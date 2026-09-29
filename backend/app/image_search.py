"""Auto image search: SearXNG → download & verify candidates server-side → cache.

Raw search links are only ~40–90% downloadable (hotlink protection, timeouts), so the
server fetches them first and only offers images it already holds.
"""
import asyncio
import hashlib
import io
import ipaddress
import json
import os
import socket
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from PIL import Image as PILImage
from PIL import ImageOps

from . import db

# Optional feature: empty / unset → auto image search is off (UI hidden, endpoint 404).
SEARXNG_URL = os.environ.get("SEARXNG_URL", "").rstrip("/")


def enabled() -> bool:
    return bool(SEARXNG_URL)
WANT = 10              # candidates returned
MAX_TRY = 24           # search results we attempt to download
MIN_EDGE = 400         # discard smaller images
MAX_BYTES = 25_000_000
FETCH_TIMEOUT = 6.0
CACHE_TTL = 3600
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


class SearchError(RuntimeError):
    pass


@dataclass
class Candidate:
    id: str
    width: int
    height: int
    engine: str
    source_host: str
    source_url: str
    page_url: str | None
    title: str | None


def cache_dir() -> Path:
    d = db.TMP_DIR / "search"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _is_public(host: str) -> bool:
    """Resolve host and reject private / loopback / link-local targets (SSRF guard)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


async def _guard(request: httpx.Request) -> None:
    # runs for the first request and every redirect hop
    if request.url.scheme not in ("http", "https"):
        raise httpx.RequestError("scheme not allowed", request=request)
    ok = await asyncio.to_thread(_is_public, request.url.host)
    if not ok:
        raise httpx.RequestError("non-public address", request=request)


async def searxng(q: str) -> tuple[list[dict], list]:
    async with httpx.AsyncClient(timeout=20) as c:
        try:
            r = await c.get(f"{SEARXNG_URL}/search", params={"q": q, "categories": "images", "format": "json"})
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise SearchError(f"搜索服务不可用：{e}") from e
    d = r.json()
    return d.get("results") or [], d.get("unresponsive_engines") or []


async def _download(client: httpx.AsyncClient, r: dict) -> tuple[dict, bytes] | None:
    url = r.get("img_src")
    if not url or url.startswith("data:"):
        return None
    headers = {"User-Agent": UA}
    if r.get("url"):
        headers["Referer"] = r["url"]
    try:
        async with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code != 200:
                return None
            chunks, size = [], 0
            async for chunk in resp.aiter_bytes():
                size += len(chunk)
                if size > MAX_BYTES:
                    return None
                chunks.append(chunk)
        return r, b"".join(chunks)
    except (httpx.HTTPError, ValueError):
        return None


def _verify_and_cache(r: dict, data: bytes) -> Candidate | None:
    try:
        im = PILImage.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception:  # noqa: BLE001
        return None
    w, h = im.size
    if max(w, h) < MIN_EDGE:
        return None
    cid = hashlib.sha256(data).hexdigest()[:20]
    d = cache_dir()
    (d / f"{cid}.bin").write_bytes(data)
    prev = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
    prev.thumbnail((400, 400), PILImage.LANCZOS)
    prev.save(d / f"{cid}.webp", "WEBP", quality=82)
    engines = r.get("engines") or [r.get("engine") or "?"]
    c = Candidate(
        id=cid, width=w, height=h, engine=str(engines[0]).replace(" images", ""),
        source_host=urlsplit(r["img_src"]).hostname or "", source_url=r["img_src"],
        page_url=r.get("url"), title=(r.get("title") or "")[:120] or None,
    )
    (d / f"{cid}.json").write_text(json.dumps(asdict(c), ensure_ascii=False))
    return c


def prune_cache() -> None:
    cutoff = time.time() - CACHE_TTL
    for f in cache_dir().iterdir():
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)


async def search(q: str) -> dict:
    prune_cache()
    results, unresponsive = await searxng(q)
    seen, todo = set(), []
    for r in results:
        src = r.get("img_src")
        if src and src not in seen:
            seen.add(src)
            todo.append(r)
        if len(todo) >= MAX_TRY:
            break

    limits = httpx.Limits(max_connections=12)
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=True, limits=limits,
                                 event_hooks={"request": [_guard]}) as client:
        downloads = await asyncio.gather(*(_download(client, r) for r in todo))

    out: list[Candidate] = []
    hashes = set()
    for got in downloads:  # gather keeps the search engines' relevance order
        if got is None:
            continue
        c = await asyncio.to_thread(_verify_and_cache, *got)
        if c and c.id not in hashes:
            hashes.add(c.id)
            out.append(c)
        if len(out) >= WANT:
            break
    return {
        "query": q,
        "candidates": [asdict(c) for c in out],
        "tried": len(todo),
        "unresponsive": [e[0] if isinstance(e, list) else e for e in unresponsive],
    }


def load(cid: str) -> tuple[bytes, dict]:
    if not cid.isalnum():
        raise FileNotFoundError(cid)
    d = cache_dir()
    return (d / f"{cid}.bin").read_bytes(), json.loads((d / f"{cid}.json").read_text())

