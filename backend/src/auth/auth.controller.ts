import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User as DbUser } from '@prisma/client';
import { IsString } from 'class-validator';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AllowExpiredPassword, AllowNoRole, mustChangePassword, Public, type TokenPayload } from './auth.guard';
import { AuthService } from './auth.service';
import { checkPasswordPolicy, hashPassword, passwordExpiresAt, passwordPolicyText, verifyPassword } from './password';
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

type UserRow = CurrentUser & Partial<Pick<DbUser, 'password_changed_at' | 'badge_no'>>;

export function userInfo(u: UserRow, amr: TokenPayload['amr'] = 'password') {
  const roles = roleList(u.roles);
  const pwd = { auth_source: u.auth_source ?? 'LOCAL', password_changed_at: u.password_changed_at ?? null };
  return {
    id: u.id, username: u.username, full_name: u.full_name, roles,
    role_names: roles.map((r) => ROLES[r]?.name ?? r), department: u.department ?? null,
    permissions: [...userPermissions(u)].sort(), auth_source: u.auth_source ?? 'LOCAL',
    badge_no: u.badge_no ?? null,
    /** 本次会话的登录方式：password / badge（工位刷工牌） */
    login_method: amr,
    /** 密码已过期：须先修改密码，其他接口返回 403 */
    must_change_password: mustChangePassword(pwd, amr),
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

  /** 登录页/前端布局用：金蝶登录是否启用、空闲超时、密码策略 */
  @Public()
  @Get('options')
  options() {
    return {
      kingdee_enabled: config.kingdee.enabled,
      kingdee_name: '金蝶云星空',
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
      tx.user.update({ where: { id: user.id }, data: { password_hash: hashPassword(body.new_password), password_changed_at: new Date() } }),
    );
    return { ok: true };
  }
}
