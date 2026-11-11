/**
 * 认证服务：本地账号 + 金蝶云星空账号 + 工位工牌（工牌号 + PIN）。
 *  - auth_source=LOCAL：校验本系统密码（bcrypt）。
 *  - auth_source=KINGDEE，或本系统尚无该账号且已启用金蝶集成：向金蝶云星空校验账号密码；
 *    首次登录自动开通本系统账号（默认无角色，需管理员分配）。
 *  - 工牌登录：仅限启用状态、拥有车间报工（mes）权限的用户，PIN 以 bcrypt 校验。
 *  - 连续失败锁定：失败次数与锁定截止时间存数据库（sys_user.failed_login_count / locked_until），多实例部署同样有效；
 *    密码登录与工牌登录共用同一计数。管理员在“用户与角色”中保存该用户即解锁。
 *  - 登录成功/失败写入审计追踪（对象“登录”）。
 * 电子签名的密码校验也走这里，保证金蝶用户用金蝶密码签名。
 */
import { HttpException, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { kingdeeValidateUser } from './kingdee.client';
import { verifyPassword } from './password';
import { ROLES, userPermissions } from './roles';

/** 金蝶用户的占位密码哈希（任何密码都无法匹配） */
export const NO_LOCAL_PASSWORD = '!kingdee';

/**
 * 兼容旧接口：锁定状态已改存数据库（随用户记录一起重置/由管理员保存用户解锁），此函数不再需要做任何事。
 * 保留导出供测试工具与 /api/test/reset 调用。
 */
export const resetLoginFailures = (_username?: string) => undefined;

@Injectable()
export class AuthService {
  constructor(private readonly db: PrismaService) {}

  private async audit(username: string | null, fullName: string | null, userId: number | null, action: string, detail: Record<string, unknown>) {
    await this.db.base.auditLog.create({
      data: { username: username?.slice(0, 64) ?? null, full_name: fullName, entity: 'sys_login', entity_id: userId, action, changes: JSON.stringify(detail) },
    });
  }

  /** 账号处于锁定期则拒绝（不计入失败次数） */
  private checkLock(user: User | null) {
    if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
      const min = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
      throw new HttpException({ detail: `密码连续错误次数过多，账号已锁定，请 ${min} 分钟后再试或联系管理员解锁` }, 401);
    }
  }

  /** 记录一次失败：累计到数据库，达到上限即锁定；写审计；抛出 401 */
  private async fail(loginName: string, user: User | null, reason: string, extra: Record<string, unknown> = {}): Promise<never> {
    let locked = false;
    if (user) {
      const u = await this.db.base.user.update({ where: { id: user.id }, data: { failed_login_count: { increment: 1 } } });
      if (u.failed_login_count >= config.loginMaxFailures) {
        await this.db.base.user.update({
          where: { id: user.id },
          data: { failed_login_count: 0, locked_until: new Date(Date.now() + config.loginLockMinutes * 60000) },
        });
        locked = true;
      }
    }
    await this.audit(user?.username ?? loginName, user?.full_name ?? null, user?.id ?? null, 'LOGIN_FAILED', { reason, ...extra, ...(locked ? { locked: true } : {}) });
    throw new HttpException({ detail: reason }, 401);
  }

  /** 登录成功：清零失败计数、记录最近登录时间与审计 */
  private async succeed(user: User, source: string): Promise<User> {
    const u = await this.db.base.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date(), failed_login_count: 0, locked_until: null },
    });
    await this.audit(u.username, u.full_name, u.id, 'LOGIN', { source });
    return u;
  }

  /** 登录：返回通过校验的用户 */
  async authenticate(username: string, password: string): Promise<User> {
    username = (username || '').trim();
    let user = await this.db.base.user.findUnique({ where: { username } });
    this.checkLock(user);
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
    return this.succeed(user!, user!.auth_source);
  }

  /** 工位终端刷工牌登录：工牌号 + PIN；仅限启用状态且拥有车间报工（mes）权限的用户 */
  async authenticateBadge(badgeNo: string, pin: string): Promise<User> {
    badgeNo = (badgeNo || '').trim();
    const user = badgeNo ? await this.db.base.user.findUnique({ where: { badge_no: badgeNo } }) : null;
    this.checkLock(user);
    const extra = { source: 'BADGE', badge_no: badgeNo };
    if (!user || !user.pin_hash || !verifyPassword(pin || '', user.pin_hash)) {
      return this.fail(`工牌:${badgeNo}`, user, '工牌号或 PIN 错误', extra);
    }
    if (!user.is_active) return this.fail(badgeNo, user, '账号已停用', extra);
    if (!userPermissions(user).has('mes')) return this.fail(badgeNo, user, '该账号没有车间报工权限，不能在工位终端登录', extra);
    return this.succeed(user, 'BADGE');
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
