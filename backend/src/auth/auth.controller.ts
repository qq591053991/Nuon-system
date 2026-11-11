import { Body, Controller, Get, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsString } from 'class-validator';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AllowNoRole, Public } from './auth.guard';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import { ROLES, roleList, userPermissions } from './roles';
import { User } from './user.decorator';

class LoginDto {
  @IsString() username: string;
  @IsString() password: string;
}
class ChangePwdDto {
  @IsString() old_password: string;
  @IsString() new_password: string;
}

export function userInfo(u: CurrentUser) {
  const roles = roleList(u.roles);
  return {
    id: u.id, username: u.username, full_name: u.full_name, roles,
    role_names: roles.map((r) => ROLES[r]?.name ?? r), department: u.department ?? null,
    permissions: [...userPermissions(u)].sort(), auth_source: u.auth_source ?? 'LOCAL',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly db: PrismaService, private readonly jwt: JwtService, private readonly auth: AuthService) {}

  /** 登录页展示用：是否启用了金蝶云星空账号登录 */
  @Public()
  @Get('options')
  options() {
    return { kingdee_enabled: config.kingdee.enabled, kingdee_name: '金蝶云星空' };
  }

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto) {
    const u = await this.auth.authenticate(body.username, body.password);
    return { access_token: await this.jwt.signAsync({ sub: u.username }), token_type: 'bearer', user: userInfo(u) };
  }

  @AllowNoRole()
  @Get('me')
  me(@User() user: CurrentUser) {
    return userInfo(user);
  }

  @AllowNoRole()
  @Post('change-password')
  async changePassword(@Body() body: ChangePwdDto, @User() user: CurrentUser) {
    if (user.auth_source === 'KINGDEE') throw new BizError('您使用金蝶云星空账号登录，请在金蝶系统中修改密码');
    if (!verifyPassword(body.old_password, user.password_hash)) throw new BizError('原密码错误');
    if (body.new_password.length < 6) throw new BizError('新密码至少 6 位');
    await this.db.tx((tx) => tx.user.update({ where: { id: user.id }, data: { password_hash: hashPassword(body.new_password) } }));
    return { ok: true };
  }
}
