"""Operation log API for the hidden /logs page."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import Integer, func
from sqlmodel import Session, select

from .. import hosts
from ..activity import ACTIONS, READ_ACTIONS, WRITE_ACTIONS
from ..db import get_session
from ..models import AccessLog, HostAlias, Item

router = APIRouter(prefix="/api/logs")

WRITE = "__write"  # pseudo-action: every non-read operation


def _filters(ip: list[str] | None, action: str | None, since: datetime | None, until: datetime | None):
    conds = []
    if ip:
        conds.append(AccessLog.ip.in_(ip))
    if action == WRITE:
        conds.append(AccessLog.action.in_(WRITE_ACTIONS))
    elif action:
        conds.append(AccessLog.action == action)
    if since:
        conds.append(AccessLog.ts >= _utc_naive(since))
    if until:
        conds.append(AccessLog.ts <= _utc_naive(until))
    return conds


def _utc_naive(dt: datetime) -> datetime:
    """Rows are stored as naive UTC."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


@router.get("/summary")
def summary(
    ip: list[str] | None = Query(None),
    action: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    session: Session = Depends(get_session),
):
    conds = _filters(ip, action, since, until)

    def q(*cols):
        return select(*cols).where(*conds)

    total, first_ts, last_ts, errors, writes = session.exec(
        q(
            func.count(AccessLog.id),
            func.min(AccessLog.ts),
            func.max(AccessLog.ts),
            func.sum((AccessLog.status >= 400).cast(Integer)),
            func.sum(AccessLog.action.in_(WRITE_ACTIONS).cast(Integer)),
        )
    ).one()
    last = session.exec(q(AccessLog).order_by(AccessLog.id.desc()).limit(1)).first()
    last_write = session.exec(
        select(AccessLog).where(*conds, AccessLog.action.in_(WRITE_ACTIONS)).order_by(AccessLog.id.desc()).limit(1)
    ).first()

    by_action = [
        {"action": a, "count": c, "last_ts": _iso(t)}
        for a, c, t in session.exec(
            q(AccessLog.action, func.count(), func.max(AccessLog.ts)).group_by(AccessLog.action).order_by(func.count().desc())
        )
    ]

    ip_rows = session.exec(
        q(AccessLog.ip, func.count(), func.max(AccessLog.ts), func.max(AccessLog.id),
          func.sum(AccessLog.action.in_(WRITE_ACTIONS).cast(Integer)))
        .group_by(AccessLog.ip).order_by(func.max(AccessLog.ts).desc())
    ).all()
    last_by_id = {
        r.id: r for r in session.exec(select(AccessLog).where(AccessLog.id.in_([r[3] for r in ip_rows])))
    } if ip_rows else {}

    names = hosts.resolve_all(session, [r[0] for r in ip_rows] + ([last.ip] if last else []) + ([last_write.ip] if last_write else []))

    def row_out(r: AccessLog | None):
        if r is None:
            return None
        return {"ts": _iso(r.ts), "action": r.action, "ip": r.ip, "host": names.get(r.ip, {}).get("name"),
                "detail": r.detail, "status": r.status}

    return {
        "total": total,
        "writes": writes or 0,
        "errors": errors or 0,
        "first_ts": _iso(first_ts),
        "last_ts": _iso(last_ts),
        "last": row_out(last),
        "last_write": row_out(last_write),
        "by_action": by_action,
        "by_ip": [
            {"ip": ipaddr, "count": c, "writes": w or 0, "last_ts": _iso(t),
             "last_action": last_by_id[lid].action if lid in last_by_id else None, **names[ipaddr]}
            for ipaddr, c, t, lid, w in ip_rows
        ],
    }


@router.get("")
def recent(
    ip: list[str] | None = Query(None),
    action: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(200, ge=1, le=200),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(AccessLog).where(*_filters(ip, action, since, until)).order_by(AccessLog.id.desc()).limit(limit)
    ).all()
    names = hosts.resolve_all(session, list({r.ip for r in rows}))
    item_names = dict(session.exec(select(Item.id, Item.name).where(Item.id.in_({r.item_id for r in rows if r.item_id}))).all()) if rows else {}
    return [
        {
            "id": r.id, "ts": _iso(r.ts), "ip": r.ip, "host": names[r.ip]["name"], "via": names[r.ip]["via"],
            "method": r.method, "path": r.path, "status": r.status, "duration_ms": r.duration_ms,
            "action": r.action, "item_id": r.item_id,
            "item_name": item_names.get(r.item_id) if r.item_id else None,
            "detail": r.detail, "user_agent": r.user_agent,
        }
        for r in rows
    ]


@router.get("/hosts")
def all_hosts(session: Session = Depends(get_session)):
    """Every IP seen in the log (for the filter dropdown) plus known Tailscale devices."""
    seen = session.exec(
        select(AccessLog.ip, func.count(), func.max(AccessLog.ts)).group_by(AccessLog.ip)
    ).all()
    names = hosts.resolve_all(session, [r[0] for r in seen])
    return {
        "actions": ACTIONS,
        "read_actions": sorted(READ_ACTIONS),
        "write_key": WRITE,
        "hosts": [{"ip": ip, "count": c, "last_ts": _iso(t), **names[ip]} for ip, c, t in seen],
        "tailscale": [{"ip": ip, **info} for ip, info in hosts.tailscale_map().items() if info["via"] == "tailscale" and ":" not in ip],
    }


class AliasIn(BaseModel):
    ip: str
    name: str


@router.put("/alias")
def set_alias(body: AliasIn, session: Session = Depends(get_session)):
    ip = body.ip.strip()
    if not ip:
        raise HTTPException(422, "IP 不能为空")
    row = session.get(HostAlias, ip)
    name = body.name.strip()
    if not name:
        if row:
            session.delete(row)
    elif row:
        row.name = name
        session.add(row)
    else:
        session.add(HostAlias(ip=ip, name=name))
    session.commit()
    return {"ok": True}
