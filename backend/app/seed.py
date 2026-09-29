"""Initial options. Runs on startup; only fills empty tables."""
import re

from sqlmodel import Session, select

from .models import BagSize, Kind, KindGroup

OTHER_GROUP = "其他"

GROUP_KINDS: dict[str, list[str]] = {
    # A small, common starting set — add your own kinds (and move them between 大类) in 设置 → 选项管理.
    "吧唧": ["吧唧", "吧唧套"],
    "卡片": ["小卡", "相卡", "拍立得", "透卡", "镭射票"],
    "明信片": ["明信片"],
    "色纸·画": ["色纸", "挂画"],
    "纸品": ["书签", "贴纸", "票根"],
    "立牌摆件": ["立牌", "摆件", "手办", "棉花娃娃"],
    "服饰杂货": ["挂件", "徽章", "杯子", "鼠标垫"],
    OTHER_GROUP: [],
}

BAG_SIZES = ["3寸", "5寸", "6寸", "58mm", "75mm"]

KIND_TO_GROUP = {k: g for g, ks in GROUP_KINDS.items() for k in ks}


def normalize_name(s: str) -> str:
    """Trim and unify brackets: 贴纸（特典) → 贴纸（特典）."""
    s = s.strip()
    s = s.replace("(", "（").replace(")", "）")
    return re.sub(r"\s+", " ", s)


def seed(session: Session) -> None:
    if session.exec(select(KindGroup)).first() is None:
        for gi, (gname, kinds) in enumerate(GROUP_KINDS.items()):
            g = KindGroup(name=gname, sort=gi)
            session.add(g)
            session.flush()
            for ki, kname in enumerate(kinds):
                session.add(Kind(name=kname, group_id=g.id, sort=ki))
    if session.exec(select(BagSize)).first() is None:
        for i, name in enumerate(BAG_SIZES):
            session.add(BagSize(name=name, sort=i))
    session.commit()
