import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User as DbUser } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AllowExpiredPassword, AllowNoRole, mustChangePassword, Public, type TokenPayload } from './auth.guard';
import { AuthService } from './auth.service';
import { DEMO_PASSWORD, demoPasswordUsers, isDemoMode } from './demo';
import { checkPasswordPolicy, hashPassword, passwordChangeReason, passwordExpiresAt, passwordPolicyText, PIN_PATTERN, verifyPassword } from './password';
import { ROLES, roleList, userPermissions } from './roles';
import { User } from './user.decorator';

class LoginDto {
  @IsString() username: string;
  @IsString() password: string;
}
class BadgeLoginDto {
  @IsString() badge_no: string;
  @IsString() pin: string;
}
class ChangePwdDto {
  @IsString() old_password: string;
  @IsString() new_password: string;
}
class ChangePinDto {
  /** 验证身份：登录密码（办公端）或原 PIN（工位刷工牌会话），二选一 */
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() old_pin?: string;
  @IsString() new_pin: string;
}

type UserRow = CurrentUser & Partial<Pick<DbUser, 'password_changed_at' | 'badge_no' | 'must_change_password' | 'pin_hash'>>;

export function userInfo(u: UserRow, amr: TokenPayload['amr'] = 'password') {
  const roles = roleList(u.roles);
  const pwd = { auth_source: u.auth_source ?? 'LOCAL', password_changed_at: u.password_changed_at ?? null, must_change_password: !!u.must_change_password };
  return {
    id: u.id, username: u.username, full_name: u.full_name, roles,
    role_names: roles.map((r) => ROLES[r]?.name ?? r), department: u.department ?? null,
    permissions: [...userPermissions(u)].sort(), auth_source: u.auth_source ?? 'LOCAL',
    badge_no: u.badge_no ?? null,
    /** 本次会话的登录方式：password / badge（工位刷工牌） */
    login_method: amr,
    /** 须先修改密码（管理员设置的初始/重置密码，或密码已过期）：其他接口返回 403 */
    must_change_password: mustChangePassword(pwd, amr),
    /** 须改密的原因：INITIAL = 管理员新建/重置的密码，须本人修改；EXPIRED = 密码已过期；null = 无需修改 */
    password_change_reason: amr === 'badge' ? null : passwordChangeReason(pwd),
    /** 密码到期时间（ISO；金蝶账号或不过期时为 null），前端在到期前 7 天提醒 */
    password_expires_at: passwordExpiresAt(pwd),
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly db: PrismaService, private readonly jwt: JwtService, private readonly auth: AuthService) {}

  private async session(u: DbUser, amr: TokenPayload['amr']) {
    const payload: TokenPayload = { sub: u.username, amr };
    const user = userInfo(u as unknown as UserRow, amr);
    return { access_token: await this.jwt.signAsync(payload), token_type: 'bearer', user, must_change_password: user.must_change_password };
  }

  /** 登录页/前端布局用：金蝶登录是否启用、空闲超时、密码策略、是否演示模式 */
  @Public()
  @Get('options')
  async options() {
    const demo = await isDemoMode(this.db);
    const demoUsers = demo ? await demoPasswordUsers(this.db, { activeOnly: true }) : [];
    return {
      /** 演示模式：仅此时登录页显示“演示账号”下拉（DEMO_MODE 环境变量，或仍有预置演示账号使用公开演示密码） */
      demo,
      /** 演示账号（仅演示模式；只列仍使用演示密码的启用账号） */
      demo_accounts: demoUsers.map((u) => ({ username: u.username, full_name: u.full_name, role_names: roleList(u.roles).map((r) => ROLES[r]?.name ?? r) })),
      demo_password: demo ? DEMO_PASSWORD : null,
      kingdee_enabled: config.kingdee.enabled,
      kingdee_name: '金蝶云星空',
      /** 本公司信息（单据打印抬头） */
      company: config.company,
      idle_minutes: config.idleTimeoutMinutes,
      password_policy: {
        min_length: config.passwordMinLength,
        require_letter_digit: config.passwordRequireLetterDigit,
        max_age_days: config.passwordMaxAgeDays,
        text: passwordPolicyText(),
      },
    };
  }

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.session(await this.auth.authenticate(body.username, body.password), 'password');
  }

  /** 工位终端刷工牌登录（工牌号 + PIN）：响应与 /auth/login 相同；仅限拥有车间报工权限的启用用户 */
  @Public()
  @Post('badge-login')
  async badgeLogin(@Body() body: BadgeLoginDto) {
    return this.session(await this.auth.authenticateBadge(body.badge_no, body.pin), 'badge');
  }

  @AllowNoRole()
  @AllowExpiredPassword()
  @Get('me')
  me(@User() user: CurrentUser, @Req() req: { authMethod?: TokenPayload['amr'] }) {
    return userInfo(user as UserRow, req.authMethod);
  }

  @AllowNoRole()
  @AllowExpiredPassword()
  @Post('change-password')
  async changePassword(@Body() body: ChangePwdDto, @User() user: CurrentUser) {
    if (user.auth_source === 'KINGDEE') throw new BizError('您使用金蝶云星空账号登录，请在金蝶系统中修改密码');
    if (!verifyPassword(body.old_password, user.password_hash)) throw new BizError('原密码错误');
    const bad = checkPasswordPolicy(body.new_password);
    if (bad) throw new BizError(bad);
    if (body.new_password === body.old_password) throw new BizError('新密码不能与原密码相同');
    await this.db.tx((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { password_hash: hashPassword(body.new_password), password_changed_at: new Date(), must_change_password: false },
      }),
    );
    return { ok: true };
  }

  /** 修改我的工位 PIN（4–8 位数字）：办公端用登录密码验证，工位刷工牌会话用原 PIN 验证 */
  @AllowExpiredPassword()
  @Post('change-pin')
  async changePin(@Body() body: ChangePinDto, @User() user: CurrentUser) {
    const row = (await this.db.base.user.findUnique({ where: { id: user.id } }))!;
    if (body.old_pin) {
      if (!row.pin_hash || !verifyPassword(body.old_pin, row.pin_hash)) throw new BizError('原 PIN 错误');
    } else if (body.password) {
      const r = await this.auth.verifyUserPassword(user, body.password);
      if (!r.ok) throw new BizError('登录密码错误');
    } else {
      throw new BizError('请输入原 PIN 或登录密码以验证身份');
    }
    if (!PIN_PATTERN.test(body.new_pin)) throw new BizError('PIN 须为 4–8 位数字');
    if (/^(\d)\1+$/.test(body.new_pin)) throw new BizError('PIN 不能是相同的数字（如 1111）');
    if (row.pin_hash && verifyPassword(body.new_pin, row.pin_hash)) throw new BizError('新 PIN 不能与原 PIN 相同');
    await this.db.tx(async (tx) => {
      // PIN 哈希直接写库，不进入审计追踪内容（审计只记录“本人修改 PIN”）
      await tx.$executeRaw`UPDATE "sys_user" SET "pin_hash" = ${hashPassword(body.new_pin)} WHERE "id" = ${user.id}`;
      await tx.auditLog.create({
        data: {
          username: user.username, full_name: user.full_name, entity: 'sys_user', entity_id: user.id, action: 'UPDATE',
          changes: JSON.stringify({ pin: [row.pin_hash ? '已设置' : null, '本人已修改'] }),
        },
      });
    });
    return { ok: true };
  }
}
