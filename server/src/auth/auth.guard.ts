import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { als, type CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { PERMISSIONS, userPermissions } from './roles';

export const PUBLIC_KEY = 'nuon:public';
export const PERMS_KEY = 'nuon:perms';
/** 无需登录 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** 需要任一权限点：@Perms('qa') / @Perms('wms', 'plan') */
export const Perms = (...perms: string[]) => SetMetadata(PERMS_KEY, perms);

/** 全局守卫：JWT 认证 + 权限点校验；把当前用户放入请求上下文（供审计追踪使用） */
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
    let username: string;
    try {
      username = (await this.jwt.verifyAsync<{ sub: string }>(token)).sub;
    } catch {
      throw new HttpException({ detail: '登录已失效，请重新登录' }, 401);
    }
    const user = (await this.db.base.user.findUnique({ where: { username } })) as CurrentUser | null;
    if (!user || !user.is_active) throw new HttpException({ detail: '账号不存在或已停用' }, 401);
    req.user = user;
    const store = als.getStore();
    if (store) store.user = user;
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
