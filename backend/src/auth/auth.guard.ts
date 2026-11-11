import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { User as DbUser } from '@prisma/client';
import { als, type CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { passwordExpired } from './password';
import { PERMISSIONS, userPermissions } from './roles';

export const PUBLIC_KEY = 'nuon:public';
export const PERMS_KEY = 'nuon:perms';
export const NO_ROLE_KEY = 'nuon:no-role';
export const EXPIRED_PWD_KEY = 'nuon:expired-password-ok';
/** 未分配角色的用户（如首次登录的金蝶账号）也可访问 */
export const AllowNoRole = () => SetMetadata(NO_ROLE_KEY, true);
/** 密码已过期的用户也可访问（仅“当前用户”和“修改密码”） */
export const AllowExpiredPassword = () => SetMetadata(EXPIRED_PWD_KEY, true);
/** 无需登录 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** 需要任一权限点：@Perms('qa') / @Perms('wms', 'plan') */
export const Perms = (...perms: string[]) => SetMetadata(PERMS_KEY, perms);

/** 令牌载荷：sub = 用户名；amr = 登录方式（password / badge） */
export interface TokenPayload {
  sub: string;
  amr?: 'password' | 'badge';
}

/** 是否须先修改密码：本地账号密码过期（工牌登录的会话使用 PIN，不受密码有效期限制） */
export const mustChangePassword = (user: Pick<DbUser, 'auth_source' | 'password_changed_at'>, amr?: string) =>
  amr !== 'badge' && passwordExpired(user);

/** 全局守卫：JWT 认证 + 密码有效期 + 权限点校验；把当前用户放入请求上下文（供审计追踪使用） */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly db: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const auth: string = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new HttpException({ detail: '未登录' }, 401);
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch {
      throw new HttpException({ detail: '登录已失效，请重新登录' }, 401);
    }
    const row = await this.db.base.user.findUnique({ where: { username: payload.sub } });
    if (!row || !row.is_active) throw new HttpException({ detail: '账号不存在或已停用' }, 401);
    const user = row as unknown as CurrentUser;
    req.user = user;
    req.authMethod = payload.amr ?? 'password';
    const store = als.getStore();
    if (store) store.user = user;
    if (mustChangePassword(row, payload.amr) && !this.reflector.getAllAndOverride<boolean>(EXPIRED_PWD_KEY, targets)) {
      throw new HttpException({ detail: '您的密码已过期，请先修改密码' }, 403);
    }
    if (!user.roles && !this.reflector.getAllAndOverride<boolean>(NO_ROLE_KEY, targets)) {
      throw new HttpException({ detail: '您的账号尚未分配角色，请联系系统管理员开通权限' }, 403);
    }
    const perms = this.reflector.getAllAndOverride<string[]>(PERMS_KEY, targets);
    if (perms?.length) {
      const mine = userPermissions(user);
      if (!perms.some((p) => mine.has(p))) {
        throw new HttpException({ detail: `无权限：需要【${perms.map((p) => PERMISSIONS[p] ?? p).join('、')}】` }, 403);
      }
    }
    return true;
  }
}
