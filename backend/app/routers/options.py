from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from ..activity import note
from ..db import get_session
from ..models import (
    OPTION_MODELS, STATUSES, BagSize, Character, Item, ItemCharacter,
    ItemKind, Kind, KindGroup, Series,
)
from ..seed import OTHER_GROUP, normalize_name
from .. import branding, image_search
from .search import get_settings

router = APIRouter(prefix="/api")


@router.get("/meta")
def meta(session: Session = Depends(get_session)):
    def rows(model):
        return [r.model_dump() for r in session.exec(select(model).order_by(model.sort, model.id))]

    specs = session.exec(
        select(Item.spec, func.count()).where(Item.spec.is_not(None)).group_by(Item.spec)
        .order_by(func.count().desc())
    ).all()
    return {
        "groups": rows(KindGroup),
        "kinds": rows(Kind),
        "series": rows(Series),
        "characters": rows(Character),
        "bag_sizes": rows(BagSize),
        "statuses": STATUSES,
        "specs": [s for s, _ in specs if s],
        "settings": (st := get_settings(session)),
        "brand": branding.asset_urls(st),
        "features": {"image_search": image_search.enabled()},
    }


class OptionIn(BaseModel):
    name: str
    group_id: int | None = None       # kind only
    section_title: str | None = None  # series only
    card_face: str | None = None      # series only
    theme_color: str | None = None    # series only


class OptionPatch(BaseModel):
    name: str | None = None
    group_id: int | None = None
    section_title: str | None = None
    card_face: str | None = None
    theme_color: str | None = None


class OrderIn(BaseModel):
    ids: list[int]


def _model(type_: str):
    model = OPTION_MODELS.get(type_)
    if model is None:
        raise HTTPException(404, f"未知选项类型 {type_}")
    return model


def other_group_id(session: Session) -> int:
    g = session.exec(select(KindGroup).where(KindGroup.name == OTHER_GROUP)).first()
    if g is None:
        last = session.exec(select(func.max(KindGroup.sort))).one() or 0
        g = KindGroup(name=OTHER_GROUP, sort=last + 1)
        session.add(g)
        session.flush()
    return g.id


def get_or_create(session: Session, model, name: str, **extra):
    name = normalize_name(name)
    row = session.exec(select(model).where(model.name == name)).first()
    if row:
        return row, False
    last = session.exec(select(func.max(model.sort))).one()
    if model is Kind and not extra.get("group_id"):
        extra["group_id"] = other_group_id(session)
    row = model(name=name, sort=(last or 0) + 1, **extra)
    session.add(row)
    session.flush()
    return row, True


@router.post("/options/{type_}")
def create_option(type_: str, body: OptionIn, request: Request, session: Session = Depends(get_session)):
    model = _model(type_)
    note(request, f"{TYPE_LABEL[type_]}「{body.name.strip()}」")
    name = normalize_name(body.name)
    if not name:
        raise HTTPException(422, "名称不能为空")
    extra = {}
    if model is Kind:
        extra["group_id"] = body.group_id
    if model is Series:
        extra.update(section_title=body.section_title or None, card_face=(body.card_face or "").strip() or None,
                     theme_color=body.theme_color)
    row, created = get_or_create(session, model, name, **extra)
    session.commit()
    session.refresh(row)
    return row


@router.patch("/options/{type_}/{id_}")
def update_option(type_: str, id_: int, body: OptionPatch, request: Request, session: Session = Depends(get_session)):
    model = _model(type_)
    row = session.get(model, id_)
    if row is None:
        raise HTTPException(404)
    changed = ", ".join(k for k in body.model_dump(exclude_unset=True))
    note(request, f"{TYPE_LABEL[type_]}「{row.name}」: {changed}")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        name = normalize_name(data["name"] or "")
        if not name:
            raise HTTPException(422, "名称不能为空")
        dup = session.exec(select(model).where(model.name == name, model.id != id_)).first()
        if dup:
            raise HTTPException(409, f"「{name}」已存在")
        row.name = name
    if model is Kind and data.get("group_id"):
        row.group_id = data["group_id"]
    if model is Series:
        if "section_title" in data:
            row.section_title = (data["section_title"] or "").strip() or None
        if "card_face" in data:
            row.card_face = (data["card_face"] or "").strip() or None
        if "theme_color" in data:
            row.theme_color = data["theme_color"]
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


TYPE_LABEL = {"group": "大类", "kind": "种类", "series": "系列", "character": "角色", "bag_size": "自封袋"}

_REFS = {
    KindGroup: (Kind, Kind.group_id),
    Kind: (ItemKind, ItemKind.kind_id),
    Series: (Item, Item.series_id),
    Character: (ItemCharacter, ItemCharacter.character_id),
    BagSize: (Item, Item.bag_size_id),
}


@router.delete("/options/{type_}/{id_}")
def delete_option(type_: str, id_: int, request: Request, session: Session = Depends(get_session)):
    model = _model(type_)
    row = session.get(model, id_)
    if row is None:
        raise HTTPException(404)
    note(request, f"{TYPE_LABEL[type_]}「{row.name}」")
    ref_model, ref_col = _REFS[model]
    n = session.exec(select(func.count()).select_from(ref_model).where(ref_col == id_)).one()
    if n:
        raise HTTPException(409, f"「{row.name}」仍被 {n} 条记录使用，无法删除")
    session.delete(row)
    session.commit()
    return {"ok": True}


@router.put("/options/{type_}/order")
def reorder_options(type_: str, body: OrderIn, request: Request, session: Session = Depends(get_session)):
    model = _model(type_)
    note(request, f"{TYPE_LABEL[type_]} · {len(body.ids)} 项")
    for i, id_ in enumerate(body.ids):
        row = session.get(model, id_)
        if row is not None:
            row.sort = i
            session.add(row)
    session.commit()
    return {"ok": True}
