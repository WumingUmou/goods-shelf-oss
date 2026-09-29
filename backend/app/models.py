from datetime import datetime, timezone

from sqlmodel import Field, SQLModel

STATUSES = ["已入库", "待出荷", "待收货"]
DEFAULT_STATUS = "已入库"
LOW_RES_EDGE = 600  # 长边小于此值标记「待换高清图」


def now() -> datetime:
    return datetime.now(timezone.utc)


class KindGroup(SQLModel, table=True):
    """大类 — 顶部 Tab。"""
    __tablename__ = "kind_group"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    sort: int = 0


class Kind(SQLModel, table=True):
    """种类（细类），归属一个大类。"""
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    group_id: int = Field(foreign_key="kind_group.id")
    sort: int = 0


class Series(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    sort: int = 0
    section_title: str | None = None
    card_face: str | None = None    # 卡面 — shown on the detail page of every item in the series
    theme_color: str | None = None  # MVP2


class Character(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    sort: int = 0


class BagSize(SQLModel, table=True):
    __tablename__ = "bag_size"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    sort: int = 0


class Item(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    series_id: int = Field(foreign_key="series.id")
    bag_size_id: int | None = Field(default=None, foreign_key="bag_size.id")
    spec: str | None = None
    status: str = DEFAULT_STATUS
    quantity: int = 1
    note: str | None = None
    sort: int = 0
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)


class ItemKind(SQLModel, table=True):
    __tablename__ = "item_kind"
    item_id: int = Field(foreign_key="item.id", primary_key=True, ondelete="CASCADE")
    kind_id: int = Field(foreign_key="kind.id", primary_key=True)
    sort: int = 0


class ItemCharacter(SQLModel, table=True):
    __tablename__ = "item_character"
    item_id: int = Field(foreign_key="item.id", primary_key=True, ondelete="CASCADE")
    character_id: int = Field(foreign_key="character.id", primary_key=True)


class Image(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    item_id: int = Field(foreign_key="item.id", index=True, ondelete="CASCADE")
    sha256: str
    ext: str
    width: int
    height: int
    source_url: str | None = None
    sort: int = 0


# name → model, used by the generic option routes
OPTION_MODELS: dict[str, type[SQLModel]] = {
    "group": KindGroup,
    "kind": Kind,
    "series": Series,
    "character": Character,
    "bag_size": BagSize,
}


class AccessLog(SQLModel, table=True):
    """One row per meaningful API operation (see activity.classify)."""
    __tablename__ = "access_log"
    id: int | None = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=now, index=True)
    ip: str = Field(index=True)
    method: str
    path: str
    status: int
    duration_ms: int
    action: str = Field(index=True)
    item_id: int | None = None
    detail: str | None = None
    user_agent: str | None = None


class HostAlias(SQLModel, table=True):
    """Manual names for IPs Tailscale can't identify (e.g. plain LAN devices)."""
    __tablename__ = "host_alias"
    ip: str = Field(primary_key=True)
    name: str


class AppSetting(SQLModel, table=True):
    """Global key/value settings editable from the UI."""
    __tablename__ = "app_setting"
    key: str = Field(primary_key=True)
    value: str


SETTING_DEFAULTS = {
    # ── appearance (设置 → 外观) — neutral defaults; each instance brands itself
    "site_title": "我的谷柜",       # big title in the top bar
    "site_subtitle": "",            # small text next to the title
    "app_name": "谷柜",             # installed-app name, browser tab title
    "bar_light_bg": "#f3eee6",      # top bar + add button, light scheme
    "bar_light_ink": "#3a2d24",
    "bar_dark_bg": "#1f1a16",       # top bar + add button, dark scheme
    "bar_dark_ink": "#efe5d6",
    "pattern_size": "640",          # background pattern tile size in px (phones use half)
    # ── uploaded artwork versions ("" = not set); bumped on every upload so URLs cache-bust
    "asset_logo": "",
    "asset_icon": "",
    "asset_pattern_light": "",
    "asset_pattern_dark": "",
    # ── defaults for new items
    "search_prefix": "",            # prepended to auto image-search queries (e.g. the franchise name)
    "default_character": "",        # pre-filled 角色 when there is no previous entry
}
