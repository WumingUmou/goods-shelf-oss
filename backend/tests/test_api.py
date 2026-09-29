import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image as PILImage

from app import db



@pytest.fixture()
def client(tmp_path):
    db.init_engine(tmp_path)
    from app.main import create_app
    with TestClient(create_app()) as c:
        yield c


def png(w=800, h=1000, color=(200, 30, 30, 255)) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def opt(c, type_, name, **kw):
    r = c.post(f"/api/options/{type_}", json={"name": name, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def make_item(c, **kw):
    s = opt(c, "series", "示例系列")
    kind = next(k for k in c.get("/api/meta").json()["kinds"] if k["name"] == "吧唧")
    body = {"name": "示例系列 - 吧唧", "series_id": s["id"], "kind_ids": [kind["id"]], **kw}
    r = c.post("/api/items", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_seed_meta(client):
    m = client.get("/api/meta").json()
    assert [g["name"] for g in m["groups"]][:3] == ["吧唧", "卡片", "明信片"]
    assert m["groups"][-1]["name"] == "其他"
    assert m["statuses"] == ["已入库", "待出荷", "待收货"]


def test_option_crud_and_ref_protection(client):
    item = make_item(client)
    # duplicate name returns existing
    again = opt(client, "series", "示例系列")
    assert again["id"] == item["series_id"]
    r = client.delete(f"/api/options/series/{item['series_id']}")
    assert r.status_code == 409
    # new kind without group goes to 其他
    k = opt(client, "kind", "亚克力砖")
    other = next(g for g in client.get("/api/meta").json()["groups"] if g["name"] == "其他")
    assert k["group_id"] == other["id"]
    # reorder series
    s2 = opt(client, "series", "另一系列")
    client.put("/api/options/series/order", json={"ids": [s2["id"], item["series_id"]]})
    names = [s["name"] for s in client.get("/api/meta").json()["series"]]
    assert names == ["另一系列", "示例系列"]
    # section title
    r = client.patch(f"/api/options/series/{s2['id']}", json={"section_title": "示例展区"})
    assert r.json()["section_title"] == "示例展区"


def test_item_crud_and_images(client):
    item = make_item(client, quantity=3, spec="75mm")
    assert item["quantity"] == 3 and item["status"] == "已入库"
    r = client.post(f"/api/items/{item['id']}/images",
                    files=[("files", ("a.png", png(), "image/png")),
                           ("files", ("b.png", png(300, 200, (0, 0, 255, 128)), "image/png"))])
    assert r.status_code == 200, r.text
    a, b = r.json()
    assert a["low_res"] is False and b["low_res"] is True
    for size in (400, 800, 1600):
        assert client.get(f"/media/{size}/{a['sha256']}.webp").status_code == 200
    # transparency kept
    im = PILImage.open(db.MEDIA_DIR / "400" / f"{b['sha256']}.webp")
    assert im.mode == "RGBA"
    # dedupe
    r = client.post(f"/api/items/{item['id']}/images", files=[("files", ("a.png", png(), "image/png"))])
    assert r.json()[0]["id"] == a["id"]
    # reorder → cover changes
    client.put(f"/api/items/{item['id']}/images/order", json={"ids": [b["id"], a["id"]]})
    got = client.get(f"/api/items/{item['id']}").json()
    assert [i["id"] for i in got["images"]] == [b["id"], a["id"]]
    # update
    body = {k: got[k] for k in ("name", "series_id", "kind_ids", "character_ids", "bag_size_id",
                                "spec", "status", "quantity", "note")}
    body.update(status="待收货", note="  备注 ")
    r = client.put(f"/api/items/{item['id']}", json=body)
    assert r.json()["status"] == "待收货" and r.json()["note"] == "备注"
    assert client.put(f"/api/items/{item['id']}", json={**body, "status": "已出"}).status_code == 422
    # delete removes files
    client.delete(f"/api/items/{item['id']}")
    assert client.get(f"/api/items/{item['id']}").status_code == 404
    assert not (db.MEDIA_DIR / "orig" / f"{a['sha256']}.png").exists()


def test_bad_image(client):
    item = make_item(client)
    r = client.post(f"/api/items/{item['id']}/images", files=[("files", ("x.png", b"nope", "image/png"))])
    assert r.status_code == 422


def make_xlsx(path):
    """Template-like workbook: header row, 3 items, one embedded (floating) image."""
    import openpyxl
    from openpyxl.drawing.image import Image as XLImage
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["谷子名称", "图片", "IP / 作品", "角色 / 推", "谷柜", "种类", "属性", "尺寸 / 规格", "状态", "数量"])
    ws.append(["示例系列 - 明信片套组", None, "作品名", "角色甲", "", "明信片", "6寸", "100*150mm", "已入库", 1])
    ws.append(["示例系列 - 吧唧", None, "作品名", "角色甲、角色乙", "", "吧唧", "70mm", "65mm", "待收货", 2])
    ws.append(["测试系列 - 手记纸品套组", None, "作品名", "角色甲", "", "小卡, 留言卡, 贴纸(特典)", None, "90*135mm", "", None])
    img_path = path.parent / "cell.png"
    PILImage.new("RGB", (320, 240), (180, 40, 60)).save(img_path)
    xl = XLImage(str(img_path))
    xl.anchor = "B2"
    ws.add_image(xl)
    wb.save(path)


def test_xlsx_import(client, tmp_path):
    x = tmp_path / "import.xlsx"
    make_xlsx(x)
    with x.open("rb") as f:
        r = client.post("/api/import/xlsx", files={"file": ("import.xlsx", f, "application/octet-stream")})
    assert r.status_code == 200, r.text
    p = r.json()
    assert len(p["rows"]) == 3
    first = p["rows"][0]
    assert first["series"] == "示例系列" and first["bag_size"] == "6寸" and first["characters"] == ["角色甲"]
    assert first["image_size"] == [320, 240] and first["low_res"] is True
    assert p["rows"][1]["characters"] == ["角色甲", "角色乙"] and p["rows"][1]["quantity"] == 2
    multi = p["rows"][2]
    assert multi["kinds"] == ["小卡", "留言卡", "贴纸（特典）"] and multi["status"] == "已入库"  # brackets normalised
    assert "小卡" not in p["new_options"]["kind"] and "留言卡" in p["new_options"]["kind"]

    r = client.post(f"/api/import/xlsx/{p['token']}/commit")
    assert r.json() == {"created": 3, "skipped": 0}
    items = client.get("/api/items").json()
    assert len(items) == 3 and len(items[0]["images"]) == 1
    with x.open("rb") as f:
        tok = client.post("/api/import/xlsx", files={"file": ("again.xlsx", f)}).json()["token"]
    assert client.post(f"/api/import/xlsx/{tok}/commit").json() == {"created": 0, "skipped": 3}
    r = client.get("/api/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True and j["checks"] == {"db": "ok", "media": "ok"} and j["items"] == 0


def test_activity_log(client, monkeypatch):
    from app import hosts
    monkeypatch.setattr(hosts, "tailscale_map", lambda: {"testclient": {"name": "测试机", "via": "tailscale", "dns": None, "os": "linux", "online": True}})
    client.get("/api/meta")        # not logged
    client.get("/api/health")      # not logged
    client.get("/api/items")       # 浏览
    item = make_item(client)       # 新增选项 + 新增条目
    client.post(f"/api/items/{item['id']}/images", files=[("files", ("a.png", png(), "image/png"))])
    client.delete(f"/api/items/{item['id']}")
    client.delete("/api/items/99999")  # 404 still logged

    logs = client.get("/api/logs").json()
    assert [l["action"] for l in logs] == ["删除条目", "删除条目", "上传图片", "新增条目", "新增选项", "浏览"]
    assert logs[0]["status"] == 404
    assert logs[1]["detail"] == "示例系列 - 吧唧" and logs[1]["host"] == "测试机"
    assert logs[2]["detail"] == "示例系列 - 吧唧 · 1 张"

    s = client.get("/api/logs/summary").json()
    assert s["total"] == 6 and s["writes"] == 5 and s["errors"] == 1
    assert s["last"]["action"] == "删除条目" and s["last_write"]["action"] == "删除条目"
    assert s["by_ip"][0]["name"] == "测试机" and s["by_ip"][0]["count"] == 6

    assert client.get("/api/logs/summary", params={"action": "浏览"}).json()["total"] == 1
    assert client.get("/api/logs/summary", params={"action": "__write"}).json()["total"] == 5
    assert client.get("/api/logs/summary", params={"ip": "1.2.3.4"}).json()["total"] == 0
    assert client.get("/api/logs", params={"since": "2999-01-01T00:00:00Z"}).json() == []

    client.put("/api/logs/alias", json={"ip": "testclient", "name": "我的电脑"})
    h = client.get("/api/logs/hosts").json()
    assert h["hosts"][0]["name"] == "我的电脑" and h["hosts"][0]["via"] == "alias"


def test_image_search(client, monkeypatch):
    from app import image_search as s

    def jpg(w, h, color):
        buf = io.BytesIO()
        PILImage.new("RGB", (w, h), color).save(buf, "JPEG")
        return buf.getvalue()

    blobs = {
        "https://a.example/big.jpg": jpg(1200, 1600, (200, 0, 0)),
        "https://b.example/small.jpg": jpg(200, 200, (0, 200, 0)),   # < MIN_EDGE → dropped
        "https://c.example/dup.jpg": jpg(1200, 1600, (200, 0, 0)),    # same bytes as a → deduped
        "https://d.example/other.png": png(900, 700, (0, 0, 255, 255)),
        "https://e.example/broken.jpg": b"not an image",
    }

    async def fake_searxng(q):
        return [{"img_src": u, "url": "https://page.example/", "engines": ["bing images"], "title": "t"} for u in blobs] + \
               [{"img_src": "https://a.example/big.jpg"}], [["duckduckgo images", "access denied"]]

    async def fake_download(client_, r):
        return r, blobs[r["img_src"]]

    monkeypatch.setattr(s, "SEARXNG_URL", "http://searxng.test")
    monkeypatch.setattr(s, "searxng", fake_searxng)
    monkeypatch.setattr(s, "_download", fake_download)

    r = client.post("/api/image-search", json={"q": "作品名 示例系列 吧唧 角色甲"})
    assert r.status_code == 200, r.text
    body = r.json()
    cands = body["candidates"]
    assert [(c["width"], c["height"]) for c in cands] == [(1200, 1600), (900, 700)]  # order kept, small/dup/broken dropped
    assert cands[0]["engine"] == "bing" and cands[0]["source_host"] == "a.example"
    assert body["unresponsive"] == ["duckduckgo images"]
    assert client.get(f"/api/image-search/preview/{cands[0]['id']}.webp").status_code == 200

    item = make_item(client)
    r = client.post(f"/api/items/{item['id']}/images/from-search", json={"candidate_id": cands[0]["id"]})
    assert r.status_code == 200, r.text
    got = client.get(f"/api/items/{item['id']}").json()
    assert len(got["images"]) == 1 and got["images"][0]["width"] == 1200 and not got["images"][0]["low_res"]
    assert client.post(f"/api/items/{item['id']}/images/from-search", json={"candidate_id": "deadbeef"}).status_code == 410

    logs = client.get("/api/logs").json()
    assert [(l["action"], l["status"]) for l in logs[:3]] == [("使用搜索图片", 410), ("使用搜索图片", 200), ("新增条目", 201)]
    assert any(l["action"] == "自动搜图" for l in logs)


def test_ssrf_guard():
    from app.image_search import _is_public
    for host in ("127.0.0.1", "localhost", "10.1.2.3", "192.168.1.10", "169.254.169.254", "::1"):
        assert _is_public(host) is False, host
    assert _is_public("8.8.8.8") is True


def test_settings(client):
    st = client.get("/api/meta").json()["settings"]
    assert st["search_prefix"] == "" and st["default_character"] == "" and st["site_title"] == "我的谷柜"
    r = client.put("/api/settings", json={"search_prefix": " 作品名 角色甲 ", "site_title": " 我的展柜 "})
    assert r.json()["search_prefix"] == "作品名 角色甲" and r.json()["site_title"] == "我的展柜"
    assert client.put("/api/settings", json={"site_title": "  "}).json()["site_title"] == "我的谷柜"  # never blank
    assert client.put("/api/settings", json={"bar_light_bg": "red"}).status_code == 422
    assert client.put("/api/settings", json={"bar_dark_bg": "#2F0A0F"}).json()["bar_dark_bg"] == "#2F0A0F"
    assert client.put("/api/settings", json={"default_character": ""}).json()["default_character"] == ""


def test_static_cache_rules(client, tmp_path, monkeypatch):
    from app import main
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html></html>")
    (static / "sw.js").write_text("// sw")
    (static / "assets" / "app-abc.js").write_text("//")
    monkeypatch.setattr(main, "STATIC_DIR", static)
    assert client.get("/assets/app-abc.js").headers["cache-control"].endswith("immutable")
    assert client.get("/sw.js").headers["cache-control"] == "no-cache"
    m = client.get("/manifest.webmanifest")
    assert m.headers["content-type"].startswith("application/manifest+json") and m.json()["name"] == "谷柜"
    assert client.get("/assets/old-gone.js").status_code == 404   # not index.html
    r = client.get("/bulk")
    assert r.status_code == 200 and "<html>" in r.text


def test_series_card_face(client):
    s = opt(client, "series", "示例系列")
    assert s["card_face"] is None
    r = client.patch(f"/api/options/series/{s['id']}", json={"card_face": "  心之絮语  "})
    assert r.json()["card_face"] == "心之絮语"
    meta = client.get("/api/meta").json()
    assert next(x for x in meta["series"] if x["id"] == s["id"])["card_face"] == "心之絮语"
    # other fields untouched by a card_face-only patch, and blank clears it
    client.patch(f"/api/options/series/{s['id']}", json={"section_title": "展区"})
    r = client.patch(f"/api/options/series/{s['id']}", json={"card_face": " "})
    assert r.json()["card_face"] is None and r.json()["section_title"] == "展区"


def test_add_missing_column_migration(tmp_path):
    """A DB created before series.card_face gets the column on startup, data intact."""
    import sqlite3
    old = sqlite3.connect(tmp_path / "goods.db")
    old.execute("CREATE TABLE series (id INTEGER PRIMARY KEY, name VARCHAR UNIQUE, sort INTEGER,"
                " section_title VARCHAR, theme_color VARCHAR)")
    old.execute("INSERT INTO series (id, name, sort) VALUES (1, '旧系列', 0)")
    old.commit(); old.close()
    db.init_engine(tmp_path)
    db.init_engine(tmp_path)  # idempotent
    con = sqlite3.connect(tmp_path / "goods.db")
    assert "card_face" in [r[1] for r in con.execute("PRAGMA table_info(series)")]
    assert con.execute("SELECT name, card_face FROM series").fetchone() == ("旧系列", None)


def test_item_order_and_append(client):
    s = opt(client, "series", "测试系列")
    other = opt(client, "series", "示例系列")
    kind = next(k for k in client.get("/api/meta").json()["kinds"] if k["name"] == "吧唧")

    def mk(name, series_id):
        r = client.post("/api/items", json={"name": name, "series_id": series_id, "kind_ids": [kind["id"]]})
        assert r.status_code == 201, r.text
        return r.json()

    a, b, c = mk("A", s["id"]), mk("B", s["id"]), mk("C", s["id"])
    x = mk("X", other["id"])

    def order(series_id):
        return [i["name"] for i in client.get("/api/items").json() if i["series_id"] == series_id]

    assert order(s["id"]) == ["A", "B", "C"]            # new items append, not jump to the front
    r = client.put(f"/api/series/{s['id']}/items/order", json={"ids": [c["id"], a["id"], b["id"]]})
    assert r.status_code == 200, r.text
    assert order(s["id"]) == ["C", "A", "B"]
    assert mk("D", s["id"])["name"] == "D" and order(s["id"]) == ["C", "A", "B", "D"]
    # must list exactly the series' items
    assert client.put(f"/api/series/{s['id']}/items/order", json={"ids": [a["id"], b["id"]]}).status_code == 422
    assert client.put(f"/api/series/{s['id']}/items/order", json={"ids": [a["id"], b["id"], c["id"], x["id"]]}).status_code == 422
    assert client.put("/api/series/9999/items/order", json={"ids": [a["id"]]}).status_code == 404
    # moving an item to another series puts it at that series' end
    body = {k: x[k] for k in ("name", "kind_ids", "character_ids", "bag_size_id", "spec", "status", "quantity", "note")}
    client.put(f"/api/items/{x['id']}", json={**body, "series_id": s["id"]})
    assert order(s["id"])[-1] == "X"
    # editing without changing series keeps the position
    body_a = {k: a[k] for k in ("name", "series_id", "kind_ids", "character_ids", "bag_size_id", "spec", "status", "quantity", "note")}
    client.put(f"/api/items/{a['id']}", json={**body_a, "note": "改备注"})
    assert order(s["id"]) == ["C", "A", "B", "D", "X"]
    assert any(l["action"] == "条目排序" for l in client.get("/api/logs").json())


def test_text_gzip_and_font_cache(client, tmp_path, monkeypatch):
    from app import main
    static = tmp_path / "static"
    (static / "fonts").mkdir(parents=True)
    (static / "index.html").write_text("<html></html>")
    (static / "fonts" / "fonts.css").write_text("@font-face{}" * 500)
    (static / "fonts" / "a-123.woff2").write_bytes(b"wOF2" + b"\0" * 4000)
    monkeypatch.setattr(main, "STATIC_DIR", static)
    r = client.get("/fonts/fonts.css", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip" and r.headers["cache-control"] == "no-cache"
    r = client.get("/fonts/a-123.woff2", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers and r.headers["cache-control"].endswith("immutable")
    r = client.get("/api/meta", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip" and r.json()["statuses"]



def test_branding(client, tmp_path, monkeypatch):
    from app import main
    static = tmp_path / "static"
    (static / "default-icons").mkdir(parents=True)
    (static / "index.html").write_text("<title>__APP_NAME__</title><meta content='__THEME_DARK__'><link href='/icons/icon-192.png?v=__ICON_V__'>")
    (static / "default-icons" / "icon-192.png").write_bytes(png(192, 192))
    monkeypatch.setattr(main, "STATIC_DIR", static)
    meta = client.get("/api/meta").json()
    assert meta["brand"] == {"logo": None, "pattern_light": None, "pattern_dark": None}
    assert meta["features"] == {"image_search": False}
    assert client.get("/icons/icon-192.png").status_code == 200          # neutral default
    assert client.get("/brand/logo.png").status_code == 404

    client.put("/api/settings", json={"app_name": "我的<展柜>", "bar_dark_bg": "#112233"})
    html = client.get("/").text
    assert "<title>我的&lt;展柜&gt;</title>" in html and "#112233" in html and "__" not in html
    assert client.get("/manifest.webmanifest").json()["theme_color"] == "#112233"

    for kind, (w, h) in {"logo": (400, 200), "icon": (900, 600), "pattern_light": (300, 300)}.items():
        r = client.post(f"/api/brand/{kind}", files={"file": ("a.png", png(w, h), "image/png")})
        assert r.status_code == 200, r.text
        assert r.json()[f"asset_{kind}"]
    meta = client.get("/api/meta").json()
    assert meta["brand"]["logo"].startswith("/brand/logo.png?v=") and meta["brand"]["pattern_dark"] is None
    assert PILImage.open(io.BytesIO(client.get("/brand/logo.png").content)).height == 144
    for name, size in {"icon-512": 512, "icon-maskable-512": 512, "apple-touch-icon": 180, "favicon-64": 64}.items():
        im = PILImage.open(io.BytesIO(client.get(f"/icons/{name}.png").content))
        assert im.size == (size, size), name
    v = client.get("/api/meta").json()["settings"]["asset_icon"]
    assert f"?v={v}" in client.get("/manifest.webmanifest").text and f"v={v}" in client.get("/").text

    assert client.post("/api/brand/nope", files={"file": ("a.png", png(), "image/png")}).status_code == 404
    assert client.post("/api/brand/logo", files={"file": ("a.png", b"junk", "image/png")}).status_code == 422
    client.delete("/api/brand/logo")
    assert client.get("/api/meta").json()["brand"]["logo"] is None and client.get("/brand/logo.png").status_code == 404
    client.delete("/api/brand/icon")
    assert PILImage.open(io.BytesIO(client.get("/icons/icon-192.png").content)).size == (192, 192)  # back to default


def test_image_search_disabled_by_default(client):
    assert client.post("/api/image-search", json={"q": "x"}).status_code == 404



def test_gps_stripped_from_originals(client):
    from app import images
    buf = io.BytesIO()
    im = PILImage.new("RGB", (800, 600), (10, 120, 200))
    exif = im.getexif()
    exif[0x010F] = "PhoneMaker"                       # Make — kept
    exif[images.GPS_IFD] = {1: "N", 2: (31.0, 14.0, 0.0), 3: "E", 4: (121.0, 28.0, 0.0)}
    im.save(buf, "JPEG", quality=90, exif=exif.tobytes())
    assert images.GPS_IFD in PILImage.open(io.BytesIO(buf.getvalue())).getexif()

    item = make_item(client)
    r = client.post(f"/api/items/{item['id']}/images", files=[("files", ("gps.jpg", buf.getvalue(), "image/jpeg"))])
    sha = r.json()[0]["sha256"]
    stored = PILImage.open(db.MEDIA_DIR / "orig" / f"{sha}.jpg").getexif()
    assert images.GPS_IFD not in stored and stored.get(0x010F) == "PhoneMaker"


def test_activity_log_switch(client, monkeypatch):
    from app import activity
    monkeypatch.setattr(activity, "ENABLED", False)
    client.get("/api/items")
    make_item(client)
    assert client.get("/api/logs").json() == []


XMP_WITH_GPS = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="31,14.0N" '
                b'exif:GPSLongitude="121,28.0E"/></rdf:RDF></x:xmpmeta>')


def test_xmp_location_stripped(client):
    from PIL import PngImagePlugin
    from app import images
    # PNG with the location only in an XMP iTXt chunk
    info = PngImagePlugin.PngInfo()
    info.add_itxt("XML:com.adobe.xmp", XMP_WITH_GPS.decode())
    buf = io.BytesIO()
    PILImage.new("RGB", (640, 480), (90, 30, 140)).save(buf, "PNG", pnginfo=info)
    assert b"GPSLatitude" in buf.getvalue()
    # JPEG with XMP (and no EXIF GPS)
    jbuf = io.BytesIO()
    PILImage.new("RGB", (640, 480), (30, 90, 140)).save(jbuf, "JPEG", quality=90, xmp=XMP_WITH_GPS)
    assert b"GPSLatitude" in jbuf.getvalue()

    item = make_item(client)
    for name, data, ext in (("x.png", buf.getvalue(), "png"), ("x.jpg", jbuf.getvalue(), "jpg")):
        sha = client.post(f"/api/items/{item['id']}/images", files=[("files", (name, data, "image/*"))]).json()[0]["sha256"]
        stored = (db.MEDIA_DIR / "orig" / f"{sha}.{ext}").read_bytes()
        assert b"GPSLatitude" not in stored and b"xmpmeta" not in stored, name
    # a plain photo is stored byte-for-byte
    plain = png(300, 300)
    assert images.strip_location(plain) == plain


def test_zip_backup_restores_fully(client, tmp_path):
    """Export → unzip into an empty data dir → start: items, originals, thumbnails, appearance all back."""
    import zipfile
    from fastapi.testclient import TestClient
    from app.main import create_app
    item = make_item(client)
    sha = client.post(f"/api/items/{item['id']}/images", files=[("files", ("a.png", png(1200, 900), "image/png"))]).json()[0]["sha256"]
    client.post("/api/brand/logo", files={"file": ("l.png", png(300, 150), "image/png")})
    client.post("/api/brand/pattern_light", files={"file": ("p.png", png(200, 200), "image/png")})
    client.put("/api/settings", json={"site_title": "恢复测试", "bar_light_bg": "#123456"})

    r = client.get("/api/export")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert {"goods.db", "RESTORE.txt", f"media/orig/{sha}.png", "media/brand/logo.png", "media/brand/pattern_light.png"} <= names
    assert not any(n.startswith("media/400/") for n in names)   # thumbnails are rebuilt, not shipped

    restored = tmp_path / "restored"
    restored.mkdir()
    z.extractall(restored)
    db.init_engine(restored)
    with TestClient(create_app()) as c2:
        items = c2.get("/api/items").json()
        assert [i["name"] for i in items] == [item["name"]]
        for size in (400, 800, 1600):
            assert c2.get(f"/media/{size}/{sha}.webp").status_code == 200
        meta = c2.get("/api/meta").json()
        assert meta["settings"]["site_title"] == "恢复测试" and meta["settings"]["bar_light_bg"] == "#123456"
        assert c2.get(meta["brand"]["logo"].split("?")[0]).status_code == 200
        assert c2.get(meta["brand"]["pattern_light"].split("?")[0]).status_code == 200
