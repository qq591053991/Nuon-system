"""审计追踪：在 ORM flush 后自动记录所有业务数据的增删改（字段级前后值）。"""
import json
from datetime import date, datetime

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from .config import now
from .models import AuditLog, ESignature, Sequence, StockMove

_SKIP_MODELS = (AuditLog, Sequence, ESignature, StockMove)
_SKIP_FIELDS = {"password_hash", "updated_at", "created_at"}


def _jsonable(v):
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def _row_changes(obj, action: str) -> dict:
    state = inspect(obj)
    out = {}
    for attr in state.mapper.column_attrs:
        key = attr.key
        if key in _SKIP_FIELDS:
            continue
        hist = state.attrs[key].history
        if action == "CREATE":
            val = getattr(obj, key)
            if val is not None and key != "id":
                out[key] = _jsonable(val)
        elif action == "UPDATE":
            if hist.has_changes():
                old = hist.deleted[0] if hist.deleted else None
                new = hist.added[0] if hist.added else None
                if old != new:
                    out[key] = [_jsonable(old), _jsonable(new)]
        else:  # DELETE
            val = getattr(obj, key)
            if val is not None:
                out[key] = _jsonable(val)
    return out


_installed: set[int] = set()


def install(session_cls) -> None:
    """注册审计钩子（幂等，重复调用不会重复记录）。"""
    if id(session_cls) in _installed:
        return
    _installed.add(id(session_cls))

    @event.listens_for(session_cls, "after_flush")
    def _after_flush(session: Session, ctx):  # noqa: ANN001
        user = session.info.get("user")
        rows = []
        ts = now()
        for action, objs in (("CREATE", session.new), ("UPDATE", session.dirty), ("DELETE", session.deleted)):
            for obj in objs:
                if isinstance(obj, _SKIP_MODELS) or not hasattr(obj, "__tablename__"):
                    continue
                if action == "UPDATE" and not session.is_modified(obj, include_collections=False):
                    continue
                changes = _row_changes(obj, action)
                if action == "UPDATE" and not changes:
                    continue
                rows.append({
                    "ts": ts,
                    "username": user.username if user else "system",
                    "full_name": user.full_name if user else "系统",
                    "entity": obj.__tablename__,
                    "entity_id": getattr(obj, "id", None),
                    "action": action,
                    "changes": json.dumps(changes, ensure_ascii=False, default=str),
                })
        if rows:
            session.connection().execute(AuditLog.__table__.insert(), rows)
