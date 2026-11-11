"""单据编号：前缀 + yyMMdd + 流水号，例如 SO261111001。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import now
from ..models import Sequence


def next_seq(db: Session, key: str) -> int:
    row = db.scalar(select(Sequence).where(Sequence.key == key).with_for_update())
    if row is None:
        row = Sequence(key=key, value=0)
        db.add(row)
    row.value += 1
    db.flush()
    return row.value


def next_no(db: Session, prefix: str, width: int = 3, dated: bool = True) -> str:
    date_part = now().strftime("%y%m%d") if dated else ""
    key = f"{prefix}{date_part}"
    return f"{key}{next_seq(db, key):0{width}d}"
