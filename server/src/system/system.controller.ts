import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { Perms, User } from '../auth';
import { hashPassword } from '../auth/password';
import { PERMISSIONS, ROLES } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { like, paginate } from '../common/paginate';
import { ser } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';

class UserDto {
  @IsString() username: string;
  @IsString() full_name: string;
  @IsOptional() @IsString() password?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) roles: string[] = [];
  @IsOptional() @IsString() department?: string | null;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsBoolean() @Type(() => Boolean) is_active = true;
}

function checkRoles(roles: string[]) {
  const bad = roles.filter((r) => !ROLES[r]);
  if (bad.length) throw new BizError(`未知角色：${bad.join(',')}`);
}

@Controller('system')
export class SystemController {
  constructor(private readonly db: PrismaService) {}

  @Get('roles')
  roles() {
    return {
      roles: Object.entries(ROLES).map(([code, v]) => ({ code, name: v.name, perms: v.perms })),
      permissions: Object.entries(PERMISSIONS).map(([code, name]) => ({ code, name })),
    };
  }

  @Get('users')
  @Perms('admin')
  users(@Query() q: Record<string, string>) {
    const where = q.q ? { OR: [{ username: like(q.q) }, { full_name: like(q.q) }] } : {};
    return paginate(this.db.client.user, 'User', { where, orderBy: { id: 'asc' } }, q, 50);
  }

  @Post('users')
  @Perms('admin')
  createUser(@Body() b: UserDto, @User() admin: CurrentUser) {
    checkRoles(b.roles);
    if (!b.password || b.password.length < 6) throw new BizError('初始密码至少 6 位');
    return this.db.tx(async (tx) => {
      if (await tx.user.findUnique({ where: { username: b.username } })) throw new BizError('用户名已存在');
      const u = await tx.user.create({
        data: {
          username: b.username, full_name: b.full_name, password_hash: hashPassword(b.password!), roles: b.roles.join(','),
          department: b.department ?? null, email: b.email ?? null, is_active: b.is_active, created_by: admin.username,
        },
      });
      return ser('User', u);
    });
  }

  @Put('users/:id')
  @Perms('admin')
  updateUser(@Param('id', ParseIntPipe) id: number, @Body() b: UserDto) {
    checkRoles(b.roles);
    return this.db.tx(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id } }))) throw new NotFound('用户');
      if (b.password && b.password.length < 6) throw new BizError('密码至少 6 位');
      const u = await tx.user.update({
        where: { id },
        data: {
          full_name: b.full_name, roles: b.roles.join(','), department: b.department ?? null, email: b.email ?? null,
          is_active: b.is_active, ...(b.password ? { password_hash: hashPassword(b.password) } : {}),
        },
      });
      return ser('User', u);
    });
  }

  @Get('audit-logs')
  auditLogs(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.entity) where.entity = q.entity;
    if (q.entity_id) where.entity_id = Number(q.entity_id);
    if (q.username) where.username = q.username;
    if (q.action) where.action = q.action;
    if (q.date_from || q.date_to) {
      where.ts = {};
      if (q.date_from) where.ts.gte = dateOnly(q.date_from);
      if (q.date_to) where.ts.lt = addDays(dateOnly(q.date_to)!, 1);
    }
    return paginate(this.db.client.auditLog, 'AuditLog', { where }, q, 50);
  }

  @Get('esignatures')
  esignatures(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.entity) where.entity = q.entity;
    if (q.entity_id) where.entity_id = Number(q.entity_id);
    return paginate(this.db.client.eSignature, 'ESignature', { where }, q, 50);
  }
}
