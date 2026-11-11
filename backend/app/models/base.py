from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from ..config import now

# 数量/金额统一使用 Numeric(18,4)，以 float 形式读写，避免前端处理 Decimal 字符串
Q = Numeric(18, 4, asdecimal=False)


class Base(DeclarativeBase):
    pass


class IdMixin:
    id: Mapped[int] = mapped_column(Integer, primary_key=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
    created_by: Mapped[str | None] = mapped_column(String(64))


__all__ = [
    "Base", "IdMixin", "TimestampMixin", "Q", "Mapped", "mapped_column", "ForeignKey",
    "Integer", "String", "Text", "Boolean", "Date", "DateTime", "date", "datetime",
]
