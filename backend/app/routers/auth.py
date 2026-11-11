from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import BizError
from ..models import User
from ..security import ROLES, create_token, get_current_user, hash_password, user_permissions, verify_password

router = APIRouter(prefix="/api/auth", tags=["认证"])


class LoginIn(BaseModel):
    username: str
    password: str


def _user_info(u: User) -> dict:
    return {"id": u.id, "username": u.username, "full_name": u.full_name, "roles": u.role_list,
            "role_names": [ROLES.get(r, {}).get("name", r) for r in u.role_list], "department": u.department,
            "permissions": sorted(user_permissions(u))}


def _login(db: Session, username: str, password: str) -> dict:
    u = db.scalar(select(User).where(User.username == username))
    if not u or not verify_password(password, u.password_hash):
        raise BizError("用户名或密码错误", 401)
    if not u.is_active:
        raise BizError("账号已停用", 401)
    return {"access_token": create_token(u), "token_type": "bearer", "user": _user_info(u)}


@router.post("/login", summary="登录")
def login(body: LoginIn, db: Session = Depends(get_db)):
    return _login(db, body.username, body.password)


@router.post("/token", summary="OAuth2 表单登录（Swagger 调试用）")
def token(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    return _login(db, form.username, form.password)


@router.get("/me", summary="当前用户")
def me(user: User = Depends(get_current_user)):
    return _user_info(user)


class ChangePwd(BaseModel):
    old_password: str
    new_password: str


@router.post("/change-password", summary="修改密码")
def change_password(body: ChangePwd, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(body.old_password, user.password_hash):
        raise BizError("原密码错误")
    if len(body.new_password) < 6:
        raise BizError("新密码至少 6 位")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}
