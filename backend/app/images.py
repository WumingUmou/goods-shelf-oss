"""Image pipeline: dedupe by sha256, keep original, generate WebP variants."""
import hashlib
import io

from PIL import Image as PILImage
from PIL import ImageOps
from pillow_heif import register_heif_opener
from sqlmodel import Session, select

from . import db
from .models import Image

register_heif_opener()

SIZES = (400, 800, 1600)
PILImage.MAX_IMAGE_PIXELS = 80_000_000

_FORMAT_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif", "HEIF": "heic", "AVIF": "avif"}


class BadImage(ValueError):
    pass


GPS_IFD = 0x8825
_XMP_KEYS = ("xmp", "XML:com.adobe.xmp")   # JPEG/WebP (Pillow) · PNG iTXt


def _has_xmp(im: PILImage.Image) -> bool:
    return any(im.info.get(k) for k in _XMP_KEYS)


def strip_location(data: bytes) -> bytes:
    """Best-effort removal of location metadata before an upload is stored: the EXIF GPS block and
    any XMP packet (editors and some phones write GPS there too). Files without either are kept
    byte-for-byte; JPEGs are re-saved with their original quantisation tables. Other hints (e.g.
    what the photo shows) are of course not touched."""
    try:
        im = PILImage.open(io.BytesIO(data))
        exif = im.getexif()
    except Exception:  # noqa: BLE001 — not an image we can read; store() reports that
        return data
    if GPS_IFD not in exif and not _has_xmp(im):
        return data
    exif.pop(GPS_IFD, None)
    out = io.BytesIO()
    extra: dict = {"exif": exif.tobytes()}           # XMP is simply not written back
    if im.info.get("icc_profile"):
        extra["icc_profile"] = im.info["icc_profile"]
    if im.format == "JPEG":
        im.save(out, "JPEG", quality="keep", subsampling="keep", **extra)
    elif im.format == "PNG":
        im.save(out, "PNG", optimize=False, **extra)  # text chunks (incl. XMP) are dropped
    elif im.format == "WEBP":
        im.save(out, "WEBP", lossless=True, **extra)
    else:  # HEIF & friends: re-encode as a high-quality JPEG without the location
        im.convert("RGB").save(out, "JPEG", quality=95, **extra)
    return out.getvalue()


strip_gps = strip_location  # backwards-compatible name


def _write_variants(im: PILImage.Image, sha: str, force: bool = False) -> None:
    w, h = im.size
    has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    base = im.convert("RGBA" if has_alpha else "RGB")
    for size in SIZES:
        out = db.MEDIA_DIR / str(size) / f"{sha}.webp"
        if out.exists() and not force:
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        v = base.copy()
        if max(w, h) > size:
            v.thumbnail((size, size), PILImage.LANCZOS)
        v.save(out, "WEBP", quality=88, method=5)


def ensure_variants(session: Session) -> int:
    """Rebuild missing 400/800/1600 WebP files from the stored originals (e.g. after restoring a
    backup that only contains originals). Returns how many images were rebuilt."""
    rebuilt = 0
    for img in session.exec(select(Image)):
        if all((db.MEDIA_DIR / str(sz) / f"{img.sha256}.webp").exists() for sz in SIZES):
            continue
        orig = db.MEDIA_DIR / "orig" / f"{img.sha256}.{img.ext}"
        if not orig.exists():
            continue
        try:
            im = ImageOps.exif_transpose(PILImage.open(orig))
            im.load()
        except Exception:  # noqa: BLE001
            continue
        _write_variants(im, img.sha256)
        rebuilt += 1
    return rebuilt


def store(data: bytes) -> tuple[str, str, int, int]:
    """Save original + variants if not already stored. Returns (sha, ext, w, h)."""
    data = strip_location(data)
    sha = hashlib.sha256(data).hexdigest()
    try:
        im = PILImage.open(io.BytesIO(data))
        fmt = im.format or "PNG"
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception as e:  # noqa: BLE001
        raise BadImage(f"无法识别的图片: {e}") from e
    ext = _FORMAT_EXT.get(fmt, "png")
    w, h = im.size

    orig = db.MEDIA_DIR / "orig" / f"{sha}.{ext}"
    if not orig.exists():
        orig.parent.mkdir(parents=True, exist_ok=True)
        orig.write_bytes(data)

    _write_variants(im, sha)
    return sha, ext, w, h


def add_image(session: Session, item_id: int, data: bytes, source_url: str | None = None) -> Image:
    sha, ext, w, h = store(data)
    existing = session.exec(select(Image).where(Image.item_id == item_id, Image.sha256 == sha)).first()
    if existing:
        return existing
    last = session.exec(select(Image).where(Image.item_id == item_id).order_by(Image.sort.desc())).first()
    img = Image(item_id=item_id, sha256=sha, ext=ext, width=w, height=h,
                source_url=source_url, sort=(last.sort + 1) if last else 0)
    session.add(img)
    session.flush()
    return img


def cleanup_orphans(session: Session) -> int:
    """Remove media files no Image row references."""
    used = set(session.exec(select(Image.sha256)).all())
    removed = 0
    for sub in ("orig", *map(str, SIZES)):
        d = db.MEDIA_DIR / sub
        if not d.exists():
            continue
        for f in d.iterdir():
            if f.stem not in used:
                f.unlink(missing_ok=True)
                removed += 1
    return removed
