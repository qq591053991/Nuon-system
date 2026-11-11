"""通用 CRUD 路由工厂：主数据（客户、供应商、物料、设备、仓库库位…）统一的增删改查、搜索、分页、筛选。"""
from collections.abc import Callable
from datetime import date, datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import create_model
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import get_db
from .errors import BizError, NotFound
from .models import User
from .security import get_current_user, require
from .serial import ser, ser_list

_SKIP = {"id", "created_at", "updated_at", "created_by"}


def _pytype(col) -> type:
    try:
        t = col.type.python_type
    except NotImplementedError:  # pragma: no cover
        return str
    if t.__name__ == "Decimal":
        return float
    return t


def schemas_for(model, exclude: set[str] = frozenset()):
    create_fields: dict[str, Any] = {}
    update_fields: dict[str, Any] = {}
    for col in model.__table__.columns:
        if col.key in _SKIP or col.key in exclude:
            continue
        t = _pytype(col)
        required = not col.nullable and col.default is None and not col.primary_key
        create_fields[col.key] = (t, ...) if required else (Optional[t], None)
        update_fields[col.key] = (Optional[t], None)
    return (create_model(f"{model.__name__}Create", **create_fields),
            create_model(f"{model.__name__}Update", **update_fields))


def paginate(db: Session, stmt, page: int, page_size: int, children=()) -> dict:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    page_size = max(1, min(page_size, 1000))
    items = db.scalars(stmt.offset((max(page, 1) - 1) * page_size).limit(page_size)).unique().all()
    return {"items": ser_list(items, children), "total": total, "page": page, "page_size": page_size}


def apply_filters(model, stmt, request: Request, filters: tuple[str, ...]):
    qp = request.query_params
    for f in filters:
        if f in qp and qp[f] != "":
            col = getattr(model, f)
            v = qp[f]
            t = _pytype(col.property.columns[0])
            if t is bool:
                v = v.lower() in ("1", "true", "yes")
            elif t is int:
                v = int(v)
            stmt = stmt.where(col == v)
    return stmt


def crud_router(model, *, prefix: str, tag: str, perm: str, search: tuple[str, ...] = ("code", "name"),
                filters: tuple[str, ...] = (), order=None, children=(), exclude: set[str] = frozenset(),
                validate: Callable[[Session, Any], None] | None = None, label: str = "记录") -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[tag])
    Create, Update = schemas_for(model, exclude)

    @router.get("", summary=f"{label}列表")
    def list_items(request: Request, q: str | None = None, page: int = 1, page_size: int = 20,
                   db: Session = Depends(get_db), _: User = Depends(get_current_user)):
        stmt = select(model)
        if q:
            stmt = stmt.where(or_(*[getattr(model, f).ilike(f"%{q}%") for f in search]))
        stmt = apply_filters(model, stmt, request, filters)
        stmt = stmt.order_by(order if order is not None else model.id.desc())
        return paginate(db, stmt, page, page_size, children)

    @router.get("/{item_id}", summary=f"{label}详情")
    def get_item(item_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
        obj = db.get(model, item_id)
        if not obj:
            raise NotFound(label)
        return ser(obj, children)

    def _save(db: Session, obj):
        if validate:
            validate(db, obj)
        try:
            db.commit()
        except IntegrityError as e:
            db.rollback()
            msg = str(e.orig).lower()
            if "unique" in msg or "duplicate" in msg:
                raise BizError(f"{label}编码已存在")
            raise BizError(f"数据不完整或关联数据不存在：{e.orig}")
        db.refresh(obj)
        return ser(obj, children)

    @router.post("", summary=f"新增{label}")
    def create_item(body: Create, db: Session = Depends(get_db), user: User = Depends(require(perm))):  # type: ignore[valid-type]
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        obj = model(**data)
        if hasattr(obj, "created_by"):
            obj.created_by = user.username
        db.add(obj)
        return _save(db, obj)

    @router.put("/{item_id}", summary=f"修改{label}")
    def update_item(item_id: int, body: Update, db: Session = Depends(get_db), _: User = Depends(require(perm))):  # type: ignore[valid-type]
        obj = db.get(model, item_id)
        if not obj:
            raise NotFound(label)
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(obj, k, v)
        return _save(db, obj)

    @router.delete("/{item_id}", summary=f"删除{label}")
    def delete_item(item_id: int, db: Session = Depends(get_db), _: User = Depends(require(perm))):
        obj = db.get(model, item_id)
        if not obj:
            raise NotFound(label)
        db.delete(obj)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise BizError(f"该{label}已被业务单据引用，不能删除（可改为停用）")
        return {"ok": True}

    return router


def as_date(v) -> date | None:
    if v is None or isinstance(v, date) and not isinstance(v, datetime):
        return v
    return date.fromisoformat(str(v)[:10])
