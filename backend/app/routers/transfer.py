"""Excel import (preview → commit) and zip export."""
import io
import shutil
import sqlite3
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image as PILImage
from sqlmodel import Session, select
from starlette.background import BackgroundTask

from .. import db, images, xlsx_import
from ..activity import note
from ..db import get_session
from ..models import LOW_RES_EDGE, BagSize, Character, Item, ItemCharacter, ItemKind, Kind, Series
from ..seed import KIND_TO_GROUP
from .options import get_or_create

router = APIRouter(prefix="/api")


def _tmp(token: str) -> Path:
    if not token.isalnum():
        raise HTTPException(400)
    return db.TMP_DIR / f"{token}.xlsx"


def _names(session: Session, model) -> set[str]:
    return set(session.exec(select(model.name)).all())


@router.post("/import/xlsx")
async def import_preview(request: Request, file: UploadFile = File(...), session: Session = Depends(get_session)):
    note(request, file.filename)
    token = uuid.uuid4().hex
    path = _tmp(token)
    with path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        rows = xlsx_import.parse(path)
    except Exception as e:  # noqa: BLE001
        path.unlink(missing_ok=True)
        raise HTTPException(422, f"无法解析 Excel：{e}") from e

    existing_items = _names(session, Item)
    have = {
        "series": _names(session, Series), "kind": _names(session, Kind),
        "character": _names(session, Character), "bag_size": _names(session, BagSize),
    }
    new: dict[str, set[str]] = {k: set() for k in have}
    out = []
    for r in rows:
        dup = r.name in existing_items
        if not dup:
            new["series"].add(r.series)
            new["kind"].update(r.kinds)
            new["character"].update(r.characters)
            if r.bag_size:
                new["bag_size"].add(r.bag_size)
        size = None
        if r.image:
            try:
                size = PILImage.open(io.BytesIO(r.image)).size
            except Exception:  # noqa: BLE001
                r.warnings.append("图片无法识别")
        out.append({
            "row": r.row, "name": r.name, "series": r.series, "kinds": r.kinds,
            "characters": r.characters, "bag_size": r.bag_size, "spec": r.spec,
            "status": r.status, "quantity": r.quantity, "note": r.note,
            "image_size": size, "low_res": bool(size and max(size) < LOW_RES_EDGE),
            "duplicate": dup, "warnings": r.warnings,
        })
    return {
        "token": token,
        "rows": out,
        "new_options": {k: sorted(v - have[k]) for k, v in new.items()},
        "new_kinds_to_other": sorted(k for k in new["kind"] - have["kind"] if k not in KIND_TO_GROUP),
    }


@router.post("/import/xlsx/{token}/commit")
def import_commit(token: str, request: Request, session: Session = Depends(get_session)):
    path = _tmp(token)
    if not path.exists():
        raise HTTPException(404, "导入会话已过期，请重新上传")
    rows = xlsx_import.parse(path)
    existing = _names(session, Item)
    created = skipped = 0
    for r in rows:
        if r.name in existing:
            skipped += 1
            continue
        series, _ = get_or_create(session, Series, r.series)
        kind_ids = [get_or_create(session, Kind, k)[0].id for k in r.kinds]
        char_ids = [get_or_create(session, Character, c)[0].id for c in r.characters]
        bag_id = get_or_create(session, BagSize, r.bag_size)[0].id if r.bag_size else None
        item = Item(name=r.name, series_id=series.id, bag_size_id=bag_id, spec=r.spec,
                    status=r.status, quantity=r.quantity, note=r.note, sort=r.row)
        session.add(item)
        session.flush()
        for i, kid in enumerate(dict.fromkeys(kind_ids)):
            session.add(ItemKind(item_id=item.id, kind_id=kid, sort=i))
        for cid in dict.fromkeys(char_ids):
            session.add(ItemCharacter(item_id=item.id, character_id=cid))
        if r.image:
            try:
                images.add_image(session, item.id, r.image, source_url=f"xlsx:{r.row}")
            except images.BadImage:
                pass
        existing.add(r.name)
        created += 1
    session.commit()
    path.unlink(missing_ok=True)
    note(request, f"新增 {created} 条，跳过 {skipped} 条")
    return {"created": created, "skipped": skipped}


RESTORE_NOTE = """goods-shelf backup (database + original images + appearance artwork).

Restore into an EMPTY data directory, then start the app — thumbnails are rebuilt automatically:

  docker compose stop goods-shelf
  mv data data.before-restore-$(date +%Y%m%d-%H%M)   # keep the current data until the restore is verified
  mkdir data && unzip goods-shelf-YYYYMMDD-HHMMSS.zip -d data   # this file's name; needs `unzip`
  sudo chown -R 1000:1000 data           # or your GS_UID:GS_GID
  docker compose up -d

Use your GS_DATA path instead of ./data if you changed it, and add the instance's
-p / --env-file options to the docker compose commands if you run several instances.
"""


@router.get("/export")
def export_zip():
    tmpdir = Path(tempfile.mkdtemp(dir=db.TMP_DIR))
    snap = tmpdir / "goods.db"
    src = sqlite3.connect(db.DATA_DIR / "goods.db")
    dst = sqlite3.connect(snap)
    src.backup(dst)
    src.close()
    dst.close()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zpath = tmpdir / f"goods-shelf-{stamp}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as z:
        z.write(snap, "goods.db")
        # originals + appearance artwork; the 400/800/1600 thumbnails are rebuilt on startup
        for sub in ("orig", "brand"):
            d = db.MEDIA_DIR / sub
            if d.exists():
                for f in d.iterdir():
                    if f.is_file():
                        z.write(f, f"media/{sub}/{f.name}")
        z.writestr("RESTORE.txt", RESTORE_NOTE)
    return FileResponse(zpath, filename=zpath.name, media_type="application/zip",
                        background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True))
