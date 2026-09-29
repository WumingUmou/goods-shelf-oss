"""Auto image search endpoints + global settings."""
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from .. import branding, image_search, images
from ..activity import note
from ..db import get_session
from ..models import SETTING_DEFAULTS, AppSetting, Item
from .items import image_out

router = APIRouter(prefix="/api")


def get_settings(session: Session) -> dict[str, str]:
    out = dict(SETTING_DEFAULTS)
    for key in SETTING_DEFAULTS:
        row = session.get(AppSetting, key)
        if row is not None:
            out[key] = row.value
    return out


class SettingsIn(BaseModel):
    site_title: str | None = Field(default=None, max_length=40)
    site_subtitle: str | None = Field(default=None, max_length=40)
    app_name: str | None = Field(default=None, max_length=30)
    bar_light_bg: str | None = None
    bar_light_ink: str | None = None
    bar_dark_bg: str | None = None
    bar_dark_ink: str | None = None
    pattern_size: int | None = Field(default=None, ge=120, le=1600)
    search_prefix: str | None = Field(default=None, max_length=50)
    default_character: str | None = Field(default=None, max_length=50)


@router.get("/settings")
def read_settings(session: Session = Depends(get_session)):
    return get_settings(session)


@router.put("/settings")
def write_settings(body: SettingsIn, request: Request, session: Session = Depends(get_session)):
    changed = body.model_dump(exclude_unset=True)
    for key, value in changed.items():
        value = "" if value is None else str(value).strip()
        if key in branding.COLOR_KEYS and not branding.valid_colour(value):
            raise HTTPException(422, f"颜色格式应为 #RRGGBB：{value}")
        if key in ("site_title", "app_name") and not value:
            value = SETTING_DEFAULTS[key]  # never blank
        row = session.get(AppSetting, key) or AppSetting(key=key, value="")
        row.value = value
        session.add(row)
    session.commit()
    note(request, ", ".join(f"{k}={v}" for k, v in changed.items()))
    return get_settings(session)


def _set(session: Session, key: str, value: str) -> None:
    row = session.get(AppSetting, key) or AppSetting(key=key, value="")
    row.value = value
    session.add(row)


@router.post("/brand/{kind}")
async def upload_brand(kind: str, request: Request, file: UploadFile = File(...),
                       session: Session = Depends(get_session)):
    if kind not in branding.ASSET_KINDS:
        raise HTTPException(404)
    try:
        version = branding.save_asset(kind, await file.read())
    except branding.BrandError as e:
        raise HTTPException(422, str(e)) from e
    _set(session, f"asset_{kind}", version)
    session.commit()
    note(request, kind)
    return get_settings(session)


@router.delete("/brand/{kind}")
def delete_brand(kind: str, request: Request, session: Session = Depends(get_session)):
    if kind not in branding.ASSET_KINDS:
        raise HTTPException(404)
    branding.delete_asset(kind)
    _set(session, f"asset_{kind}", "")
    session.commit()
    note(request, f"{kind} removed")
    return get_settings(session)


class SearchIn(BaseModel):
    q: str = Field(min_length=1, max_length=200)


@router.post("/image-search")
async def search(body: SearchIn, request: Request):
    if not image_search.enabled():
        raise HTTPException(404, "未启用自动搜图（未配置 SEARXNG_URL）")
    note(request, body.q.strip())
    try:
        return await image_search.search(body.q.strip())
    except image_search.SearchError as e:
        raise HTTPException(502, str(e)) from e


@router.get("/image-search/preview/{cid}.webp")
def preview(cid: str):
    f = image_search.cache_dir() / f"{cid}.webp"
    if not cid.isalnum() or not f.exists():
        raise HTTPException(404, "预览已过期，请重新搜索")
    return FileResponse(f, media_type="image/webp", headers={"Cache-Control": "private, max-age=3600"})


class FromSearchIn(BaseModel):
    candidate_id: str


@router.post("/items/{item_id}/images/from-search")
def use_candidate(item_id: int, body: FromSearchIn, request: Request, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "条目不存在")
    try:
        data, meta = image_search.load(body.candidate_id)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(410, "搜索结果已过期，请重新搜索") from e
    note(request, f"{item.name} · {meta.get('source_host')}")
    try:
        img = images.add_image(session, item_id, data, source_url=meta.get("source_url"))
    except images.BadImage as e:
        raise HTTPException(422, str(e)) from e
    session.commit()
    return image_out(img)
