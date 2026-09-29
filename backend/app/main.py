import mimetypes
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.middleware.gzip import GZipMiddleware
from sqlalchemy import text
from sqlmodel import Session
from starlette.staticfiles import StaticFiles

from . import activity, branding, db, images
from .routers import items, logs, options, search, transfer
from .routers.search import get_settings
from .seed import seed

mimetypes.add_type("application/manifest+json", ".webmanifest")

STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parent.parent / "static"))


class TextGZip:
    """gzip text responses only (API JSON, CSS, JS) — images and fonts are already compressed."""

    TEXT_SUFFIXES = (".css", ".js", ".webmanifest", ".json", ".txt")

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if path.startswith("/api/") or path.endswith(self.TEXT_SUFFIXES):
            await self.gzip(scope, receive, send)
        else:
            await self.app(scope, receive, send)


class CachedStatic(StaticFiles):
    """Media files are content-addressed (sha256), so they never change."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


@asynccontextmanager
async def lifespan(_: FastAPI):
    if db.engine is None:
        db.init_engine()
    shutil.rmtree(db.TMP_DIR, ignore_errors=True)
    db.TMP_DIR.mkdir(parents=True, exist_ok=True)
    with Session(db.engine) as s:
        seed(s)
        activity.prune(s)
        rebuilt = images.ensure_variants(s)
        if rebuilt:
            print(f"rebuilt thumbnails for {rebuilt} images", flush=True)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="goods-shelf", lifespan=lifespan)
    app.include_router(options.router)
    app.include_router(items.router)
    app.include_router(transfer.router)
    app.include_router(logs.router)
    app.include_router(search.router)
    app.middleware("http")(activity.middleware)
    app.add_middleware(TextGZip)

    @app.get("/api/health")
    def health():
        """For Uptime Kuma: 200 + "ok": true only when DB and media storage both work."""
        checks: dict[str, str] = {}
        items = None
        try:
            with Session(db.engine) as s:
                items = s.exec(text("SELECT COUNT(*) FROM item")).one()[0]
            checks["db"] = "ok"
        except Exception as e:  # noqa: BLE001
            checks["db"] = f"error: {e}"
        try:
            probe = db.MEDIA_DIR / ".health"
            probe.write_text("1")
            probe.unlink()
            checks["media"] = "ok"
        except Exception as e:  # noqa: BLE001
            checks["media"] = f"error: {e}"
        free_gb = round(shutil.disk_usage(db.DATA_DIR).free / 1e9, 1)
        ok = all(v == "ok" for v in checks.values())
        return JSONResponse(
            {"ok": ok, "status": "ok" if ok else "degraded", "checks": checks, "items": items, "disk_free_gb": free_gb},
            status_code=200 if ok else 503,
        )

    app.mount("/media", CachedStatic(directory=db.MEDIA_DIR, check_dir=False), name="media")

    def _settings() -> dict[str, str]:
        with Session(db.engine) as s:
            return get_settings(s)

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return Response(branding.manifest(_settings()), media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})

    @app.get("/icons/{name}.png", include_in_schema=False)
    def icon(name: str):
        if name not in (*branding.ICON_SIZES, "icon-maskable-512"):
            raise HTTPException(404)
        f = branding.icon_file(name, STATIC_DIR)
        if f is None:
            raise HTTPException(404)
        return FileResponse(f, headers={"Cache-Control": "no-cache"})

    @app.get("/brand/{kind}.png", include_in_schema=False)
    def brand_asset(kind: str):
        f = branding.brand_dir() / f"{kind}.png"
        if kind not in ("logo", "pattern_light", "pattern_dark") or not f.exists():
            raise HTTPException(404)
        # URLs carry ?v=<upload time>, so a new upload is a new URL
        return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    def index_response():
        index = STATIC_DIR / "index.html"
        if not index.exists():
            raise HTTPException(404, "frontend not built")
        return HTMLResponse(branding.render_index(index.read_text(encoding="utf-8"), _settings()),
                            headers={"Cache-Control": "no-cache"})

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        f = (STATIC_DIR / path).resolve()
        if path and path != "index.html" and f.is_file() and STATIC_DIR.resolve() in f.parents:
            # hashed build assets never change; sw.js / manifest / icons must revalidate so updates land
            immutable = path.startswith("assets/") or (path.startswith("fonts/") and path.endswith(".woff2"))
            cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
            return FileResponse(f, headers={"Cache-Control": cache})
        if path.startswith("assets/") or path == "sw.js":
            # a stale tab asking for an old chunk must get a 404, not index.html parsed as JS
            raise HTTPException(404)
        return index_response()

    return app


app = create_app()
