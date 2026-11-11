from datetime import date, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..crud import paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import AuditLog, ESignature, User
from ..security import PERMISSIONS, ROLES, get_current_user, hash_password, require
from ..serial import ser

router = APIRouter(prefix="/api/system", tags=["系统管理"])


@router.get("/roles", summary="角色与权限定义")
def roles(_: User = Depends(get_current_user)):
    return {"roles": [{"code": k, "name": v["name"], "perms": v["perms"]} for k, v in ROLES.items()],
            "permissions": [{"code": k, "name": v} for k, v in PERMISSIONS.items()]}


class UserIn(BaseModel):
    username: str
    full_name: str
    password: str | None = None
    roles: list[str] = []
    department: str | None = None
    email: str | None = None
    is_active: bool = True


def _check_roles(roles: list[str]):
    bad = [r for r in roles if r not in ROLES]
    if bad:
        raise BizError(f"未知角色：{','.join(bad)}")


@router.get("/users", summary="用户列表")
def list_users(q: str | None = None, page: int = 1, page_size: int = 50, db: Session = Depends(get_db),
               _: User = Depends(require("admin"))):
    stmt = select(User).order_by(User.id)
    if q:
        stmt = stmt.where(User.username.ilike(f"%{q}%") | User.full_name.ilike(f"%{q}%"))
    return paginate(db, stmt, page, page_size)


@router.post("/users", summary="新增用户")
def create_user(body: UserIn, db: Session = Depends(get_db), admin: User = Depends(require("admin"))):
    _check_roles(body.roles)
    if not body.password or len(body.password) < 6:
        raise BizError("初始密码至少 6 位")
    u = User(username=body.username, full_name=body.full_name, password_hash=hash_password(body.password),
             roles=",".join(body.roles), department=body.department, email=body.email, is_active=body.is_active,
             created_by=admin.username)
    db.add(u)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise BizError("用户名已存在")
    return ser(u)


@router.put("/users/{uid}", summary="修改用户（含重置密码）")
def update_user(uid: int, body: UserIn, db: Session = Depends(get_db), _: User = Depends(require("admin"))):
    u = db.get(User, uid)
    if not u:
        raise NotFound("用户")
    _check_roles(body.roles)
    u.full_name, u.roles, u.department, u.email, u.is_active = (body.full_name, ",".join(body.roles), body.department,
                                                                body.email, body.is_active)
    if body.password:
        if len(body.password) < 6:
            raise BizError("密码至少 6 位")
        u.password_hash = hash_password(body.password)
    db.commit()
    return ser(u)


@router.get("/audit-logs", summary="审计追踪查询")
def audit_logs(entity: str | None = None, entity_id: int | None = None, username: str | None = None,
               action: str | None = None, date_from: date | None = None, date_to: date | None = None,
               page: int = 1, page_size: int = 50, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(AuditLog).order_by(AuditLog.id.desc())
    if entity:
        stmt = stmt.where(AuditLog.entity == entity)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if username:
        stmt = stmt.where(AuditLog.username == username)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if date_from:
        stmt = stmt.where(AuditLog.ts >= date_from)
    if date_to:
        stmt = stmt.where(AuditLog.ts < date_to + timedelta(days=1))
    return paginate(db, stmt, page, page_size)


@router.get("/esignatures", summary="电子签名记录")
def esignatures(entity: str | None = None, entity_id: int | None = None, page: int = 1, page_size: int = 50,
                db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(ESignature).order_by(ESignature.id.desc())
    if entity:
        stmt = stmt.where(ESignature.entity == entity)
    if entity_id:
        stmt = stmt.where(ESignature.entity_id == entity_id)
    return paginate(db, stmt, page, page_size)
