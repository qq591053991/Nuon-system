import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import type { User as DbUser } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Perms, User } from '../auth';
import { NO_LOCAL_PASSWORD } from '../auth/auth.service';
import { checkPasswordPolicy, hashPassword, PIN_PATTERN } from '../auth/password';
import { PERMISSIONS, ROLES } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { like, paginate } from '../common/paginate';
import { ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuditSealService } from './audit-seal.service';

class UserDto {
  @IsString() username: string;
  @IsString() full_name: string;
  @IsOptional() @IsString() password?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) roles: string[] = [];
  @IsOptional() @IsString() department?: string | null;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsBoolean() @Type(() => Boolean) is_active = true;
  /** LOCAL = 本系统密码；KINGDEE = 使用金蝶云星空账号密码登录（无需设置密码） */
  @IsOptional() @IsIn(['LOCAL', 'KINGDEE']) auth_source?: 'LOCAL' | 'KINGDEE';
  /** 工牌号（工位终端刷卡登录）；空 = 清除 */
  @IsOptional() @IsString() @MaxLength(64) badge_no?: string | null;
  /** 设置/重置工位 PIN（4–8 位数字）；不传或为空 = 不修改 */
  @IsOptional() @IsString() @Matches(/^(\d{4,8})?$/, { message: '工位 PIN 须为 4–8 位数字' }) pin?: string | null;
}

function checkRoles(roles: string[]) {
  const bad = roles.filter((r) => !ROLES[r]);
  if (bad.length) throw new BizError(`未知角色：${bad.join(',')}`);
}

/** 用户输出（入参为 ser('User') 结果）：隐藏 PIN 哈希，补充“已设置 PIN”“锁定中”标记 */
function userView(o: Record<string, any>) {
  const { pin_hash, ...rest } = o;
  const until = rest.locked_until ? new Date(rest.locked_until).getTime() : 0;
  return { ...rest, has_pin: !!pin_hash, locked: until > Date.now() };
}

@Controller('system')
export class SystemController {
  constructor(private readonly db: PrismaService, private readonly sealer: AuditSealService) {}

  /** 工牌号唯一性 */
  private async checkBadge(tx: Tx, badge: string | null, selfId?: number) {
    if (!badge) return;
    const other = await tx.user.findUnique({ where: { badge_no: badge } });
    if (other && other.id !== selfId) throw new BizError(`工牌号 ${badge} 已分配给用户 ${other.full_name}（${other.username}）`);
  }

  /** 设置工位 PIN：直接写库，PIN 哈希不进入审计追踪内容（审计只记录“已设置/重置 PIN”） */
  private async setPin(tx: Tx, user: DbUser, pin: string, admin: CurrentUser) {
    if (!PIN_PATTERN.test(pin)) throw new BizError('工位 PIN 须为 4–8 位数字');
    await tx.$executeRaw`UPDATE "sys_user" SET "pin_hash" = ${hashPassword(pin)} WHERE "id" = ${user.id}`;
    await tx.auditLog.create({
      data: {
        username: admin.username, full_name: admin.full_name, entity: 'sys_user', entity_id: user.id, action: 'UPDATE',
        changes: JSON.stringify({ pin: [user.pin_hash ? '已设置' : null, user.pin_hash ? '已重置' : '已设置'] }),
      },
    });
  }

  @Get('roles')
  roles() {
    return {
      roles: Object.entries(ROLES).map(([code, v]) => ({ code, name: v.name, perms: v.perms })),
      permissions: Object.entries(PERMISSIONS).map(([code, name]) => ({ code, name })),
    };
  }

  @Get('users')
  @Perms('admin')
  async users(@Query() q: Record<string, string>) {
    const where = q.q ? { OR: [{ username: like(q.q) }, { full_name: like(q.q) }, { badge_no: like(q.q) }] } : {};
    const page = await paginate(this.db.client.user, 'User', { where, orderBy: { id: 'asc' } }, q, 50);
    return { ...page, items: page.items.map(userView) };
  }

  @Post('users')
  @Perms('admin')
  createUser(@Body() b: UserDto, @User() admin: CurrentUser) {
    checkRoles(b.roles);
    const source = b.auth_source ?? 'LOCAL';
    const kingdee = source === 'KINGDEE';
    if (!kingdee) {
      if (!b.password) throw new BizError('请设置初始密码');
      const bad = checkPasswordPolicy(b.password);
      if (bad) throw new BizError(bad);
    }
    const badge = b.badge_no?.trim() || null;
    return this.db.tx(async (tx) => {
      if (await tx.user.findUnique({ where: { username: b.username } })) throw new BizError('用户名已存在');
      await this.checkBadge(tx, badge);
      let u = await tx.user.create({
        data: {
          username: b.username, full_name: b.full_name, password_hash: kingdee ? NO_LOCAL_PASSWORD : hashPassword(b.password!), roles: b.roles.join(','),
          auth_source: source, password_changed_at: kingdee ? null : new Date(), badge_no: badge,
          department: b.department ?? null, email: b.email ?? null, is_active: b.is_active, created_by: admin.username,
        },
      });
      if (b.pin) {
        await this.setPin(tx, u, b.pin, admin);
        u = (await tx.user.findUnique({ where: { id: u.id } }))!;
      }
      return userView(ser('User', u));
    });
  }

  /** 修改用户；管理员保存即解锁（清零失败次数与锁定时间） */
  @Put('users/:id')
  @Perms('admin')
  updateUser(@Param('id', ParseIntPipe) id: number, @Body() b: UserDto, @User() admin: CurrentUser) {
    checkRoles(b.roles);
    return this.db.tx(async (tx) => {
      const cur = await tx.user.findUnique({ where: { id } });
      if (!cur) throw new NotFound('用户');
      const source = b.auth_source ?? cur.auth_source;
      const kingdee = source === 'KINGDEE';
      if (!kingdee && b.password) {
        const bad = checkPasswordPolicy(b.password);
        if (bad) throw new BizError(bad);
      }
      if (!kingdee && cur.auth_source === 'KINGDEE' && !b.password) throw new BizError('改为本系统账号时请设置密码');
      const badge = b.badge_no === undefined ? cur.badge_no : b.badge_no?.trim() || null;
      await this.checkBadge(tx, badge, id);
      let u = await tx.user.update({
        where: { id },
        data: {
          full_name: b.full_name, roles: b.roles.join(','), department: b.department ?? null, email: b.email ?? null,
          is_active: b.is_active, auth_source: source, badge_no: badge, failed_login_count: 0, locked_until: null,
          ...(kingdee
            ? { password_hash: NO_LOCAL_PASSWORD, password_changed_at: null }
            : b.password
              ? { password_hash: hashPassword(b.password), password_changed_at: new Date() }
              : {}),
        },
      });
      if (b.pin) {
        await this.setPin(tx, u, b.pin, admin);
        u = (await tx.user.findUnique({ where: { id } }))!;
      }
      return userView(ser('User', u));
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

  /** 审计追踪完整性校验：先封存未封存的记录，再复算整条哈希链，返回被篡改/删除/插入的记录 */
  @Get('audit-verify')
  @Perms('admin', 'qa')
  auditVerify() {
    return this.sealer.verify();
  }

  @Get('esignatures')
  esignatures(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.entity) where.entity = q.entity;
    if (q.entity_id) where.entity_id = Number(q.entity_id);
    return paginate(this.db.client.eSignature, 'ESignature', { where }, q, 50);
  }
}
