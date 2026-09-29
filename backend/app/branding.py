"""Per-instance appearance: uploaded artwork, generated app icons, dynamic manifest + index.html."""
import io
import json
import re
import time
from pathlib import Path

from PIL import Image as PILImage
from PIL import ImageOps

from . import db

ASSET_KINDS = ("logo", "icon", "pattern_light", "pattern_dark")
ICON_SIZES = {"icon-512": 512, "icon-192": 192, "apple-touch-icon": 180, "favicon-64": 64}
COLOR_KEYS = ("bar_light_bg", "bar_light_ink", "bar_dark_bg", "bar_dark_ink")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class BrandError(ValueError):
    pass


def brand_dir() -> Path:
    d = db.MEDIA_DIR / "brand"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _open(data: bytes) -> PILImage.Image:
    try:
        im = PILImage.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception as e:  # noqa: BLE001
        raise BrandError(f"无法识别的图片：{e}") from e
    return im.convert("RGBA")


def _trim(im: PILImage.Image) -> PILImage.Image:
    box = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return im.crop(box) if box else im


def _edge_colour(im: PILImage.Image) -> tuple[int, int, int]:
    small = im.convert("RGB").resize((32, 32))
    px = [small.getpixel((x, y)) for x in range(32) for y in (0, 31)] + [small.getpixel((x, y)) for y in range(32) for x in (0, 31)]
    return tuple(sum(c[i] for c in px) // len(px) for i in range(3))  # type: ignore[return-value]


def save_asset(kind: str, data: bytes) -> str:
    """Process + store an uploaded image. Returns the new version string."""
    if kind not in ASSET_KINDS:
        raise BrandError(f"未知类型 {kind}")
    im = _open(data)
    d = brand_dir()
    if kind == "logo":  # small mark beside the title: trim transparent margins, 144px tall (sharp at 3x)
        im = _trim(im)
        h = 144
        im.resize((max(1, round(im.width * h / im.height)), h), PILImage.LANCZOS).save(d / "logo.png", optimize=True)
    elif kind == "icon":  # square-crop, then every size the PWA / browsers ask for
        side = min(im.size)
        sq = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2))
        flat = PILImage.new("RGB", sq.size, _edge_colour(sq))
        flat.paste(sq, mask=sq.getchannel("A"))
        for name, size in ICON_SIZES.items():
            flat.resize((size, size), PILImage.LANCZOS).save(d / f"{name}.png", optimize=True)
        # maskable: keep the artwork inside the 80% safe zone on its own edge colour
        m = PILImage.new("RGB", (512, 512), _edge_colour(sq))
        inner = round(512 * 0.86)
        m.paste(flat.resize((inner, inner), PILImage.LANCZOS), ((512 - inner) // 2,) * 2)
        m.save(d / "icon-maskable-512.png", optimize=True)
    else:  # background tiles: keep transparency, cap the size
        im.thumbnail((1280, 1280), PILImage.LANCZOS)
        im.save(d / f"{kind}.png", optimize=True)
    return str(int(time.time()))


def delete_asset(kind: str) -> None:
    d = brand_dir()
    names = [f"{n}.png" for n in (*ICON_SIZES, "icon-maskable-512")] if kind == "icon" else [f"{kind}.png"]
    for n in names:
        (d / n).unlink(missing_ok=True)


def asset_urls(settings: dict[str, str]) -> dict[str, str | None]:
    return {k: (f"/brand/{k}.png?v={settings[f'asset_{k}']}" if settings.get(f"asset_{k}") else None)
            for k in ("logo", "pattern_light", "pattern_dark")}


def icon_file(name: str, static_dir: Path) -> Path | None:
    """Custom icon if uploaded, else the neutral one shipped with the frontend build."""
    custom = brand_dir() / f"{name}.png"
    if custom.exists():
        return custom
    default = static_dir / "default-icons" / f"{name}.png"
    return default if default.exists() else None


def manifest(settings: dict[str, str]) -> str:
    v = settings.get("asset_icon") or "0"
    name = settings.get("app_name") or "谷柜"
    return json.dumps({
        "name": name, "short_name": name, "lang": "zh-CN",
        "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": settings["bar_dark_bg"], "theme_color": settings["bar_dark_bg"],
        "icons": [
            {"src": f"/icons/icon-192.png?v={v}", "sizes": "192x192", "type": "image/png"},
            {"src": f"/icons/icon-512.png?v={v}", "sizes": "512x512", "type": "image/png"},
            {"src": f"/icons/icon-maskable-512.png?v={v}", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }, ensure_ascii=False)


def render_index(html: str, settings: dict[str, str]) -> str:
    """Fill the placeholders in the built index.html (title, status-bar colours, icon versions)."""
    from html import escape
    v = settings.get("asset_icon") or "0"
    return (html.replace("__APP_NAME__", escape(settings.get("app_name") or "谷柜"))
                .replace("__THEME_LIGHT__", settings["bar_light_bg"])
                .replace("__THEME_DARK__", settings["bar_dark_bg"])
                .replace("__ICON_V__", v))


def valid_colour(v: str) -> bool:
    return bool(HEX.match(v))
