"""Operation log: classify API requests and record them in access_log."""
import os
import re
import time

from fastapi import Request
from sqlalchemy import delete, func, select
from sqlmodel import Session

from . import db
from .models import AccessLog

KEEP_ROWS = 100_000

# (method, path regex, action). First match wins; unmatched requests are not logged.
RULES: list[tuple[str, re.Pattern, str]] = [
    (m, re.compile(p), a)
    for m, p, a in [
        ("GET", r"^/api/items$", "浏览"),
        ("GET", r"^/api/export$", "导出备份"),
        ("POST", r"^/api/items$", "新增条目"),
        ("PUT", r"^/api/items/\d+$", "编辑条目"),
        ("DELETE", r"^/api/items/\d+$", "删除条目"),
        ("POST", r"^/api/items/\d+/images$", "上传图片"),
        ("POST", r"^/api/items/\d+/images/from-search$", "使用搜索图片"),
        ("POST", r"^/api/image-search$", "自动搜图"),
        ("PUT", r"^/api/settings$", "修改设置"),
        ("POST", r"^/api/brand/\w+$", "上传外观图片"),
        ("DELETE", r"^/api/brand/\w+$", "删除外观图片"),
        ("PUT", r"^/api/items/\d+/images/order$", "图片排序"),
        ("PUT", r"^/api/series/\d+/items/order$", "条目排序"),
        ("DELETE", r"^/api/images/\d+$", "删除图片"),
        ("POST", r"^/api/options/\w+$", "新增选项"),
        ("PUT", r"^/api/options/\w+/order$", "选项排序"),
        ("PATCH", r"^/api/options/\w+/\d+$", "修改选项"),
        ("DELETE", r"^/api/options/\w+/\d+$", "删除选项"),
        ("POST", r"^/api/import/xlsx$", "导入预览"),
        ("POST", r"^/api/import/xlsx/\w+/commit$", "导入确认"),
    ]
]
READ_ACTIONS = {"浏览", "导出备份", "自动搜图"}
ACTIONS = [a for _, _, a in RULES]
WRITE_ACTIONS = [a for a in ACTIONS if a not in READ_ACTIONS]

_ITEM_ID = re.compile(r"^/api/items/(\d+)")


def classify(method: str, path: str) -> str | None:
    for m, rx, action in RULES:
        if m == method and rx.match(path):
            return action
    return None


def note(request: Request, detail: str | None = None, item_id: int | None = None) -> None:
    """Called from routes to attach human-readable context to the log row."""
    if detail is not None:
        request.state.log_detail = detail
    if item_id is not None:
        request.state.log_item_id = item_id


_inserts = 0


def prune(session: Session) -> None:
    newest = session.exec(select(func.max(AccessLog.id))).one()[0]
    if newest and newest > KEEP_ROWS:
        session.exec(delete(AccessLog).where(AccessLog.id <= newest - KEEP_ROWS))
        session.commit()


# ACTIVITY_LOG=off disables the operation log entirely (no IPs / user agents are recorded).
ENABLED = os.environ.get("ACTIVITY_LOG", "on").strip().lower() not in ("0", "off", "false", "no")


async def middleware(request: Request, call_next):
    action = classify(request.method, request.url.path) if ENABLED else None
    if action is None:
        return await call_next(request)
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        try:
            _record(request, action, status, int((time.perf_counter() - start) * 1000))
        except Exception:  # noqa: BLE001 — logging must never break a request
            pass


def _record(request: Request, action: str, status: int, ms: int) -> None:
    global _inserts
    item_id = getattr(request.state, "log_item_id", None)
    if item_id is None and (m := _ITEM_ID.match(request.url.path)):
        item_id = int(m.group(1))
    row = AccessLog(
        ip=request.client.host if request.client else "?",
        method=request.method,
        path=request.url.path,
        status=status,
        duration_ms=ms,
        action=action,
        item_id=item_id,
        detail=getattr(request.state, "log_detail", None),
        user_agent=(request.headers.get("user-agent") or "")[:300] or None,
    )
    with Session(db.engine) as s:
        s.add(row)
        s.commit()
        _inserts += 1
        if _inserts % 1000 == 0:
            prune(s)
