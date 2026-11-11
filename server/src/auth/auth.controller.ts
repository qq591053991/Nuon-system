import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsString } from 'class-validator';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Public } from './auth.guard';
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

export function userInfo(u: CurrentUser & { department?: string | null }) {
  const roles = roleList(u.roles);
  return {
    id: u.id, username: u.username, full_name: u.full_name, roles,
    role_names: roles.map((r) => ROLES[r]?.name ?? r), department: u.department ?? null,
    permissions: [...userPermissions(u)].sort(),
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly db: PrismaService, private readonly jwt: JwtService) {}

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto) {
    const u = await this.db.base.user.findUnique({ where: { username: body.username } });
    if (!u || !verifyPassword(body.password, u.password_hash)) throw new HttpException({ detail: '用户名或密码错误' }, 401);
    if (!u.is_active) throw new HttpException({ detail: '账号已停用' }, 401);
    return { access_token: await this.jwt.signAsync({ sub: u.username }), token_type: 'bearer', user: userInfo(u) };
  }

  @Get('me')
  me(@User() user: CurrentUser) {
    return userInfo(user);
  }

  @Post('change-password')
  async changePassword(@Body() body: ChangePwdDto, @User() user: CurrentUser) {
    if (!verifyPassword(body.old_password, user.password_hash)) throw new BizError('原密码错误');
    if (body.new_password.length < 6) throw new BizError('新密码至少 6 位');
    await this.db.tx((tx) => tx.user.update({ where: { id: user.id }, data: { password_hash: hashPassword(body.new_password) } }));
    return { ok: true };
  }
}
