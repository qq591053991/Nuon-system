"""认证、角色权限、电子签名。"""
from datetime import timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import now, settings
from .db import get_db
from .models import ESignature, User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)

# 权限点
PERMISSIONS: dict[str, str] = {
    "master": "主数据维护（客户/供应商/物料/仓库/设备）",
    "engineering": "工程数据（BOM/工艺路线）编制与发布",
    "sales": "销售订单与发货申请",
    "purchase": "采购订单",
    "plan": "生产计划（MRP/工单）",
    "wms": "仓储作业（收货/领料/发货/调拨/盘点）",
    "mes": "车间报工（工位过站/测试数据录入）",
    "qc": "质量检验（IQC/FQC、开具NCR）",
    "qa": "质量保证（NCR评审处置、CAPA、产品放行）",
    "finance": "财务（应收应付、收付款）",
    "admin": "系统管理（用户、权限、审计）",
}

ROLES: dict[str, dict] = {
    "admin": {"name": "系统管理员", "perms": list(PERMISSIONS)},
    "manager": {"name": "厂长/管理层", "perms": [p for p in PERMISSIONS if p != "admin"]},
    "sales": {"name": "销售/客服", "perms": ["sales"]},
    "purchaser": {"name": "采购", "perms": ["purchase"]},
    "planner": {"name": "PMC 计划", "perms": ["plan", "sales"]},
    "engineer": {"name": "工艺/研发工程师", "perms": ["engineering", "master"]},
    "warehouse": {"name": "仓管员", "perms": ["wms"]},
    "operator": {"name": "产线操作员", "perms": ["mes"]},
    "qc": {"name": "质检员", "perms": ["qc"]},
    "qa": {"name": "质量工程师/QA", "perms": ["qa", "qc"]},
    "finance": {"name": "财务", "perms": ["finance"]},
}


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=settings.BCRYPT_ROUNDS)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def user_permissions(user: User) -> set[str]:
    perms: set[str] = set()
    for r in user.role_list:
        perms.update(ROLES.get(r, {}).get("perms", []))
    return perms


def create_token(user: User) -> str:
    payload = {"sub": user.username, "exp": now() + timedelta(minutes=settings.TOKEN_EXPIRE_MINUTES)}
    # 时间戳按本地时区存储，这里统一换算为 epoch
    payload["exp"] = int(payload["exp"].timestamp())
    return jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def get_current_user(token: str | None = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录", headers={"WWW-Authenticate": "Bearer"})
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已失效，请重新登录", headers={"WWW-Authenticate": "Bearer"})
    user = db.scalar(select(User).where(User.username == data.get("sub")))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不存在或已停用")
    db.info["user"] = user  # 供审计追踪钩子读取当前操作人
    return user


def require(*perms: str):
    """依赖：要求当前用户拥有任一权限点。"""

    def checker(user: User = Depends(get_current_user)) -> User:
        if perms and not (user_permissions(user) & set(perms)):
            names = "、".join(PERMISSIONS.get(p, p) for p in perms)
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"无权限：需要【{names}】")
        return user

    return checker


class SignatureIn(BaseModel):
    """电子签名：再次输入本人密码 + 理由。"""

    password: str
    reason: str | None = None


def esign(db: Session, user: User, sig: SignatureIn | None, meaning: str, entity: str, entity_id: int,
          doc_no: str | None = None) -> ESignature:
    if sig is None or not sig.password:
        raise HTTPException(400, f"此操作需要电子签名（{meaning}），请输入密码确认")
    if not verify_password(sig.password, user.password_hash):
        raise HTTPException(400, "电子签名失败：密码错误")
    rec = ESignature(
        ts=now(), username=user.username, full_name=user.full_name, meaning=meaning,
        entity=entity, entity_id=entity_id, doc_no=doc_no, reason=sig.reason,
    )
    db.add(rec)
    return rec
