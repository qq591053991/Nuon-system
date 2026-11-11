/**
 * 认证服务：本地账号 + 金蝶云星空账号。
 *  - auth_source=LOCAL：校验本系统密码（bcrypt）。
 *  - auth_source=KINGDEE，或本系统尚无该账号且已启用金蝶集成：向金蝶云星空校验账号密码；
 *    首次登录自动开通本系统账号（默认无角色，需管理员分配）。
 *  - 连续失败锁定；登录成功/失败写入审计追踪。
 * 电子签名的密码校验也走这里，保证金蝶用户用金蝶密码签名。
 */
import { HttpException, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { kingdeeValidateUser } from './kingdee.client';
import { verifyPassword } from './password';
import { ROLES } from './roles';

/** 金蝶用户的占位密码哈希（任何密码都无法匹配） */
export const NO_LOCAL_PASSWORD = '!kingdee';

const failures = new Map<string, { count: number; until?: number }>();
/** 清除登录失败计数（测试重置、管理员解锁） */
export const resetLoginFailures = (username?: string) => (username ? failures.delete(username) : failures.clear());

@Injectable()
export class AuthService {
  constructor(private readonly db: PrismaService) {}

  private async audit(username: string, fullName: string | null, userId: number | null, action: string, detail: Record<string, unknown>) {
    await this.db.base.auditLog.create({
      data: { username, full_name: fullName, entity: 'sys_login', entity_id: userId, action, changes: JSON.stringify(detail) },
    });
  }

  private checkLock(username: string) {
    const f = failures.get(username);
    if (f?.until && f.until > Date.now()) {
      const min = Math.ceil((f.until - Date.now()) / 60000);
      throw new HttpException({ detail: `密码连续错误次数过多，账号已锁定，请 ${min} 分钟后再试` }, 401);
    }
  }

  private async fail(username: string, user: User | null, reason: string, status = 401): Promise<never> {
    const f = failures.get(username) ?? { count: 0 };
    f.count += 1;
    if (f.count >= config.loginMaxFailures) {
      f.until = Date.now() + config.loginLockMinutes * 60000;
      f.count = 0;
    }
    failures.set(username, f);
    await this.audit(username, user?.full_name ?? null, user?.id ?? null, 'LOGIN_FAILED', { reason });
    throw new HttpException({ detail: reason }, status);
  }

  /** 登录：返回通过校验的用户 */
  async authenticate(username: string, password: string): Promise<User> {
    username = (username || '').trim();
    this.checkLock(username);
    let user = await this.db.base.user.findUnique({ where: { username } });
    const useKingdee = config.kingdee.enabled && (!user || user.auth_source === 'KINGDEE');

    if (!useKingdee) {
      if (!user || user.auth_source !== 'LOCAL' || !verifyPassword(password, user.password_hash)) {
        return this.fail(username, user, user?.auth_source === 'KINGDEE' ? '金蝶登录未启用，请联系管理员' : '用户名或密码错误');
      }
    } else {
      const r = await kingdeeValidateUser(username, password);
      if (r.unavailable) {
        await this.audit(username, user?.full_name ?? null, user?.id ?? null, 'LOGIN_FAILED', { reason: r.message, source: 'KINGDEE' });
        throw new HttpException({ detail: r.message }, 503);
      }
      if (!r.ok) return this.fail(username, user, `金蝶云星空：${r.message}`);
      if (!user) {
        if (!config.kingdee.autoCreate) return this.fail(username, null, '该金蝶账号尚未开通本系统，请联系管理员');
        const roles = config.kingdee.defaultRoles.split(',').map((x) => x.trim()).filter((x) => ROLES[x]).join(',');
        user = await this.db.client.user.create({
          data: {
            username, full_name: r.displayName || username, password_hash: NO_LOCAL_PASSWORD, roles, auth_source: 'KINGDEE',
            external_id: r.userId ?? null, created_by: 'kingdee-sso', department: null,
          },
        });
      } else if (r.userId && user.external_id !== r.userId) {
        user = await this.db.base.user.update({ where: { id: user.id }, data: { external_id: r.userId } });
      }
    }
    if (!user!.is_active) return this.fail(username, user, '账号已停用');
    failures.delete(username);
    await this.db.base.user.update({ where: { id: user!.id }, data: { last_login_at: new Date() } });
    await this.audit(username, user!.full_name, user!.id, 'LOGIN', { source: user!.auth_source });
    return user!;
  }

  /** 校验当前用户的密码（电子签名用）：本地用户校验本地密码，金蝶用户向金蝶校验 */
  async verifyUserPassword(user: CurrentUser & { auth_source?: string }, password: string): Promise<{ ok: boolean; message?: string }> {
    if (user.auth_source === 'KINGDEE') {
      if (!config.kingdee.enabled) return { ok: false, message: '金蝶登录未启用，无法完成电子签名' };
      const r = await kingdeeValidateUser(user.username, password);
      if (r.unavailable) return { ok: false, message: r.message };
      return { ok: r.ok, message: r.ok ? undefined : '电子签名失败：金蝶密码错误' };
    }
    return verifyPassword(password, user.password_hash) ? { ok: true } : { ok: false, message: '电子签名失败：密码错误' };
  }
}
