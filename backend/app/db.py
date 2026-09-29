import os
from pathlib import Path

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MEDIA_DIR = DATA_DIR / "media"
TMP_DIR = DATA_DIR / "tmp"

engine = None


def init_engine(data_dir: Path | None = None):
    """(Re)create the engine. Tests call this with a temp dir."""
    global engine, DATA_DIR, MEDIA_DIR, TMP_DIR
    if data_dir is not None:
        DATA_DIR = data_dir
        MEDIA_DIR = data_dir / "media"
        TMP_DIR = data_dir / "tmp"
    for d in (DATA_DIR, MEDIA_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{DATA_DIR / 'goods.db'}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _pragmas(conn, _):
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    from . import models  # noqa: F401  register tables

    SQLModel.metadata.create_all(engine)
    _add_missing_columns()
    return engine


# create_all() makes new tables but never alters existing ones. Additive column changes are
# listed here and applied on startup (idempotent). Switch to Alembic if a change ever needs
# more than "ADD COLUMN".
_COLUMN_MIGRATIONS = [
    ("series", "card_face", "VARCHAR"),
]


def _add_missing_columns() -> None:
    with engine.begin() as conn:
        for table, column, ddl in _COLUMN_MIGRATIONS:
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if column not in existing:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def get_session():
    with Session(engine) as session:
        yield session
