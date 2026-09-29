from collections import defaultdict

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, delete, select

from .. import images
from ..activity import note
from ..db import get_session
from ..models import (
    DEFAULT_STATUS, LOW_RES_EDGE, STATUSES, BagSize, Character, Image, Item, ItemCharacter,
    ItemKind, Kind, Series, now,
)

router = APIRouter(prefix="/api")


class ItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    series_id: int
    kind_ids: list[int] = Field(min_length=1)
    character_ids: list[int] = []
    bag_size_id: int | None = None
    spec: str | None = None
    status: str = DEFAULT_STATUS
    quantity: int = Field(default=1, ge=1, le=9999)
    note: str | None = None


def image_out(img: Image) -> dict:
    return {
        "id": img.id, "sha256": img.sha256, "ext": img.ext,
        "width": img.width, "height": img.height, "sort": img.sort,
        "low_res": max(img.width, img.height) < LOW_RES_EDGE,
    }


def serialize(session: Session, items: list[Item]) -> list[dict]:
    ids = [i.id for i in items]
    kinds, chars, imgs = defaultdict(list), defaultdict(list), defaultdict(list)
    if ids:
        for r in session.exec(select(ItemKind).where(ItemKind.item_id.in_(ids)).order_by(ItemKind.sort)):
            kinds[r.item_id].append(r.kind_id)
        for r in session.exec(select(ItemCharacter).where(ItemCharacter.item_id.in_(ids))):
            chars[r.item_id].append(r.character_id)
        for r in session.exec(select(Image).where(Image.item_id.in_(ids)).order_by(Image.sort, Image.id)):
            imgs[r.item_id].append(image_out(r))
    return [
        {**i.model_dump(), "kind_ids": kinds[i.id], "character_ids": chars[i.id], "images": imgs[i.id]}
        for i in items
    ]


def _validate(session: Session, body: ItemIn) -> None:
    if body.status not in STATUSES:
        raise HTTPException(422, f"未知状态 {body.status}")
    if session.get(Series, body.series_id) is None:
        raise HTTPException(422, "系列不存在")
    for kid in body.kind_ids:
        if session.get(Kind, kid) is None:
            raise HTTPException(422, f"种类 {kid} 不存在")
    for cid in body.character_ids:
        if session.get(Character, cid) is None:
            raise HTTPException(422, f"角色 {cid} 不存在")
    if body.bag_size_id is not None and session.get(BagSize, body.bag_size_id) is None:
        raise HTTPException(422, "自封袋尺寸不存在")


def _next_sort(session: Session, series_id: int) -> int:
    """Position after the last item of the series — new (or moved-in) items go to the end."""
    return (session.exec(select(func.max(Item.sort)).where(Item.series_id == series_id)).one() or 0) + 1


def _apply(session: Session, item: Item, body: ItemIn) -> None:
    item.name = body.name.strip()
    if item.id is None or item.series_id != body.series_id:
        item.sort = _next_sort(session, body.series_id)
    item.series_id = body.series_id
    item.bag_size_id = body.bag_size_id
    item.spec = (body.spec or "").strip() or None
    item.status = body.status
    item.quantity = body.quantity
    item.note = (body.note or "").strip() or None
    item.updated_at = now()
    session.add(item)
    session.flush()
    session.exec(delete(ItemKind).where(ItemKind.item_id == item.id))
    session.exec(delete(ItemCharacter).where(ItemCharacter.item_id == item.id))
    for i, kid in enumerate(dict.fromkeys(body.kind_ids)):
        session.add(ItemKind(item_id=item.id, kind_id=kid, sort=i))
    for cid in dict.fromkeys(body.character_ids):
        session.add(ItemCharacter(item_id=item.id, character_id=cid))


@router.get("/items")
def list_items(session: Session = Depends(get_session)):
    """All items (≤1000) — the frontend filters locally."""
    items = session.exec(select(Item).order_by(Item.sort, Item.id)).all()
    return serialize(session, list(items))


def _get(session: Session, item_id: int) -> Item:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "条目不存在")
    return item


@router.get("/items/{item_id}")
def get_item(item_id: int, session: Session = Depends(get_session)):
    return serialize(session, [_get(session, item_id)])[0]


@router.post("/items", status_code=201)
def create_item(body: ItemIn, request: Request, session: Session = Depends(get_session)):
    _validate(session, body)
    item = Item(name=body.name, series_id=body.series_id)
    _apply(session, item, body)
    session.commit()
    note(request, item.name, item.id)
    return serialize(session, [item])[0]


@router.put("/items/{item_id}")
def update_item(item_id: int, body: ItemIn, request: Request, session: Session = Depends(get_session)):
    item = _get(session, item_id)
    note(request, body.name.strip())
    _validate(session, body)
    _apply(session, item, body)
    session.commit()
    return serialize(session, [item])[0]


class ItemOrderIn(BaseModel):
    ids: list[int] = Field(min_length=1)


@router.put("/series/{series_id}/items/order")
def reorder_series_items(series_id: int, body: ItemOrderIn, request: Request,
                         session: Session = Depends(get_session)):
    """Manual in-series order. `ids` = every item of the series, in the new order."""
    series = session.get(Series, series_id)
    if series is None:
        raise HTTPException(404, "系列不存在")
    members = {i.id: i for i in session.exec(select(Item).where(Item.series_id == series_id))}
    if len(set(body.ids)) != len(body.ids) or set(body.ids) != set(members):
        raise HTTPException(422, "顺序列表必须恰好包含该系列的全部谷子")
    for pos, item_id in enumerate(body.ids, start=1):
        members[item_id].sort = pos
        session.add(members[item_id])
    session.commit()
    note(request, f"{series.name} · {len(body.ids)} 件")
    return {"ok": True}


@router.delete("/items/{item_id}")
def delete_item(item_id: int, request: Request, session: Session = Depends(get_session)):
    item = _get(session, item_id)
    note(request, item.name)
    session.exec(delete(Image).where(Image.item_id == item_id))
    session.exec(delete(ItemKind).where(ItemKind.item_id == item_id))
    session.exec(delete(ItemCharacter).where(ItemCharacter.item_id == item_id))
    session.delete(item)
    session.commit()
    images.cleanup_orphans(session)
    return {"ok": True}


# ---- images ---------------------------------------------------------------

@router.post("/items/{item_id}/images")
async def upload_images(item_id: int, request: Request, files: list[UploadFile] = File(...),
                        session: Session = Depends(get_session)):
    item = _get(session, item_id)
    note(request, f"{item.name} · {len(files)} 张")
    added = []
    for f in files:
        data = await f.read()
        try:
            added.append(images.add_image(session, item_id, data))
        except images.BadImage as e:
            session.rollback()
            raise HTTPException(422, f"{f.filename}: {e}") from e
    session.commit()
    return [image_out(i) for i in added]


class OrderIn(BaseModel):
    ids: list[int]


@router.put("/items/{item_id}/images/order")
def reorder_images(item_id: int, body: OrderIn, request: Request, session: Session = Depends(get_session)):
    note(request, _get(session, item_id).name)
    for i, img_id in enumerate(body.ids):
        img = session.get(Image, img_id)
        if img and img.item_id == item_id:
            img.sort = i
            session.add(img)
    session.commit()
    return {"ok": True}


@router.delete("/images/{image_id}")
def delete_image(image_id: int, request: Request, session: Session = Depends(get_session)):
    img = session.get(Image, image_id)
    if img is None:
        raise HTTPException(404)
    owner = session.get(Item, img.item_id)
    note(request, owner.name if owner else None, img.item_id)
    session.delete(img)
    session.commit()
    images.cleanup_orphans(session)
    return {"ok": True}
