from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, TimestampMixin


class User(IdMixin, TimestampMixin, Base):
    __tablename__ = "sys_user"
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(128))
    roles: Mapped[str] = mapped_column(String(256), default="")  # 逗号分隔
    department: Mapped[str | None] = mapped_column(String(64))
    email: Mapped[str | None] = mapped_column(String(128))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def role_list(self) -> list[str]:
        return [r for r in (self.roles or "").split(",") if r]


class AuditLog(IdMixin, Base):
    """审计追踪（不可修改、不可删除）：记录谁在何时对哪条记录做了什么修改（修改前/后值）。"""

    __tablename__ = "sys_audit_log"
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    username: Mapped[str | None] = mapped_column(String(64), index=True)
    full_name: Mapped[str | None] = mapped_column(String(64))
    entity: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(16))  # CREATE / UPDATE / DELETE
    changes: Mapped[str | None] = mapped_column(Text)  # JSON


class ESignature(IdMixin, Base):
    """电子签名记录（参照 21 CFR Part 11 §11.50 / §11.200）：签名人、时间、签名含义、对象。"""

    __tablename__ = "sys_esignature"
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    username: Mapped[str] = mapped_column(String(64))
    full_name: Mapped[str] = mapped_column(String(64))
    meaning: Mapped[str] = mapped_column(String(64))  # 签名含义，如“IQC检验判定”“产品放行”
    entity: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    doc_no: Mapped[str | None] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(String(256))


class Sequence(Base):
    __tablename__ = "sys_sequence"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
