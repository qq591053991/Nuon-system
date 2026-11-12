import { Body, Controller, Get, HttpException, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Perms, User } from '../auth';
import { NO_LOCAL_PASSWORD } from '../auth/auth.service';
import { DEMO_PASSWORD, demoPasswordUsers, isDemoMode } from '../auth/demo';
import { checkPasswordPolicy, generateTempPassword, hashPassword, passwordExpiresAt } from '../auth/password';
import { PERMISSIONS, ROLES, userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { like, paginate, sortArg } from '../common/paginate';
import { ser, serList } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';
import { AuditSealService } from './audit-seal.service';
import { docTargets, enrichAudit, entityName } from './audit-view';
import { checkBadge, checkKingdeeEnabled, checkRoles, clearPin, createUserTx, deactivateTx, resetPasswordTx, setPin } from './user-admin';

class UserDto {
  @IsString() username: string;
  @IsString() full_name: string;
  @IsOptional() @IsString() password?: string | null;
  /** 由系统生成随机临时密码（新建或重置时），仅在本次响应的 temp_password 中返回一次 */
  @IsOptional() @IsBoolean() generate_password?: boolean;
  /** 首次登录须修改密码：管理员设置/重置本系统密码时默认 true（仅系统集成/测试可显式传 false） */
  @IsOptional() @IsBoolean() must_change_password?: boolean;
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
  /** 由启用改为停用时：同时释放工牌、清除工位 PIN（离职人员的工牌可直接分配给新人） */
  @IsOptional() @IsBoolean() release_badge?: boolean;
}

class ResetPwdDto {
  /** 新密码；不填则系统生成临时密码（仅本次返回） */
  @IsOptional() @IsString() password?: string | null;
}

class DeactivateDto {
  /** 同时释放工牌、清除工位 PIN（默认是） */
  @IsOptional() @IsBoolean() release_badge?: boolean;
}

const BATCH_ACTIONS = ['set_roles', 'add_roles', 'remove_roles', 'deactivate', 'activate', 'force_change', 'reset_password', 'unlock', 'set_department'] as const;
class BatchDto {
  @IsArray() @ArrayMinSize(1, { message: '请先勾选用户' }) @ArrayMaxSize(1000) @IsInt({ each: true }) ids: number[];
  @IsIn(BATCH_ACTIONS as unknown as string[]) action: (typeof BATCH_ACTIONS)[number];
  @IsOptional() @IsArray() @IsString({ each: true }) roles?: string[];
  @IsOptional() @IsString() department?: string | null;
  @IsOptional() @IsBoolean() release_badge?: boolean;
}

/** 用户输出（入参为 ser('User') 结果，PIN 哈希已由视图隐藏、has_pin 由视图计算）：补充锁定、初始密码等状态 */
function userView(o: Record<string, any>, demoIds: Set<number> = new Set()) {
  const { pin_hash: _hidden, ...rest } = o; // 防御：即使视图配置变化也不输出哈希
  const until = rest.locked_until ? new Date(rest.locked_until).getTime() : 0;
  const local = rest.auth_source !== 'KINGDEE';
  const demo = demoIds.has(rest.id);
  return {
    ...rest,
    locked: until > Date.now(),
    /** 仍在使用公开的演示密码（预置演示账号） */
    demo_password: demo,
    /** 初始密码未改：管理员设置/重置的密码本人尚未修改，或仍是演示密码 */
    initial_password: local && (!!rest.must_change_password || demo),
    password_expires_at: rest.password_expires_at ?? passwordExpiresAt({
      auth_source: rest.auth_source, password_changed_at: rest.password_changed_at ? new Date(rest.password_changed_at) : null,
    }),
  };
}

/**
 * 审计追踪 / 电子签名台账的查阅权限（@Perms('audit','admin') 的等价检查）：
 * 跨单据查询、导出需审计查阅权限；单张业务单据的记录（同时指定 entity 与 entity_id，且不是系统表，
 * 如 BOM 详情页的“变更记录”“签名历史”）随单据可见。
 */
function checkAuditAccess(user: CurrentUser, q: Record<string, string>) {
  if (['audit', 'admin'].some((p) => userPermissions(user).has(p))) return;
  const single = q.entity && !q.entity.includes(',') && !q.entity.startsWith('sys_') && q.entity_id;
  if (!single) throw new HttpException({ detail: `无权限：需要【${PERMISSIONS.audit ?? '审计追踪与电子签名台账查阅'}】或【系统管理】` }, 403);
}

/** 角色筛选：roles 为逗号分隔字符串 */
const roleWhere = (role: string) => ({ OR: [{ roles: role }, { roles: { startsWith: `${role},` } }, { roles: { endsWith: `,${role}` } }, { roles: { contains: `,${role},` } }] });

@Controller('system')
export class SystemController {
  constructor(private readonly db: PrismaService, private readonly sealer: AuditSealService) {}

  private async demoIds() {
    return new Set((await demoPasswordUsers(this.db)).map((u) => u.id));
  }

  private async view(u: any) {
    return userView(ser('User', u), await this.demoIds());
  }

  @Get('roles')
  roles() {
    return {
      roles: Object.entries(ROLES).map(([code, v]) => ({ code, name: v.name, perms: v.perms })),
      permissions: Object.entries(PERMISSIONS).map(([code, name]) => ({ code, name })),
    };
  }

  /**
   * 用户列表：默认新建在前。筛选：q（账号/姓名/工牌/部门）、role、department、
   * status = active 启用 / inactive 停用 / locked 已锁定 / no_role 待分配角色 / initial_password 初始密码未改 / failed 有登录失败
   */
  @Get('users')
  @Perms('admin')
  async users(@Query() q: Record<string, string>) {
    const and: any[] = [];
    if (q.q) and.push({ OR: [{ username: like(q.q) }, { full_name: like(q.q) }, { badge_no: like(q.q) }, { department: like(q.q) }] });
    if (q.role) and.push(roleWhere(q.role));
    if (q.department) and.push({ department: q.department === '__none__' ? null : q.department });
    if (q.auth_source) and.push({ auth_source: q.auth_source });
    const demoIds = await this.demoIds();
    switch (q.status) {
      case 'active': and.push({ is_active: true }); break;
      case 'inactive': and.push({ is_active: false }); break;
      case 'locked': and.push({ locked_until: { gt: new Date() } }); break;
      case 'no_role': and.push({ roles: '' }); break;
      case 'failed': and.push({ failed_login_count: { gt: 0 } }); break;
      case 'initial_password': and.push({ auth_source: 'LOCAL', OR: [{ must_change_password: true }, { id: { in: [...demoIds] } }] }); break;
      default: break;
    }
    const where = and.length ? { AND: and } : {};
    const page = await paginate(this.db.client.user, 'User', { where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }, q, 50);
    return { ...page, items: page.items.map((u) => userView(u, demoIds)) };
  }

  /** 账号安全概况（用户页顶部提示、管理员首页）：初始密码未改、已锁定、待分配角色、演示账号等 */
  @Get('users/summary')
  @Perms('admin')
  async userSummary() {
    const c = this.db.base.user;
    const now = new Date();
    const demo = await demoPasswordUsers(this.db, { activeOnly: true });
    const demoIds = demo.map((u) => u.id);
    const [total, active, locked, noRole, initial, failed, depts] = await Promise.all([
      c.count(),
      c.count({ where: { is_active: true } }),
      c.count({ where: { is_active: true, locked_until: { gt: now } } }),
      c.count({ where: { is_active: true, roles: '' } }),
      c.count({ where: { is_active: true, auth_source: 'LOCAL', OR: [{ must_change_password: true }, { id: { in: demoIds } }] } }),
      c.count({ where: { is_active: true, failed_login_count: { gt: 0 } } }),
      c.groupBy({ by: ['department'], _count: { _all: true }, orderBy: { department: 'asc' } }),
    ]);
    return {
      total, active, inactive: total - active, locked, no_role: noRole, initial_password: initial, failed,
      /** 仍使用公开演示密码的启用账号（上线前应停用或修改） */
      demo_password: demo.map((u) => ({ id: u.id, username: u.username, full_name: u.full_name })),
      demo_mode: await isDemoMode(this.db),
      demo_password_text: demo.length ? DEMO_PASSWORD : null,
      departments: depts.filter((d) => d.department).map((d) => ({ name: d.department, count: d._count._all })),
      /** 各角色的启用人数（角色权限矩阵“人数”列） */
      role_counts: Object.fromEntries(
        await Promise.all(Object.keys(ROLES).map(async (r) => [r, await c.count({ where: { is_active: true, ...roleWhere(r) } })] as const)),
      ),
    };
  }

  @Post('users')
  @Perms('admin')
  createUser(@Body() b: UserDto, @User() admin: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await createUserTx(tx, { ...b, roles: b.roles ?? [] }, admin);
      return { ...(await this.view(r.user)), temp_password: r.temp_password };
    });
  }

  /** 修改用户；管理员保存即解锁（清零失败次数与锁定时间）；设置新密码时本人下次登录须修改 */
  @Put('users/:id')
  @Perms('admin')
  updateUser(@Param('id', ParseIntPipe) id: number, @Body() b: UserDto, @User() admin: CurrentUser) {
    checkRoles(b.roles);
    return this.db.tx(async (tx) => {
      const cur = await tx.user.findUnique({ where: { id } });
      if (!cur) throw new NotFound('用户');
      const source = b.auth_source ?? cur.auth_source;
      const kingdee = source === 'KINGDEE';
      if (kingdee && cur.auth_source !== 'KINGDEE') checkKingdeeEnabled();
      let tempPassword: string | null = null;
      let password = b.password?.trim() || null;
      if (!kingdee && !password && b.generate_password) password = tempPassword = generateTempPassword();
      if (!kingdee && password) {
        const bad = checkPasswordPolicy(password);
        if (bad) throw new BizError(bad);
      }
      if (!kingdee && cur.auth_source === 'KINGDEE' && !password) throw new BizError('改为本系统账号时请设置密码（或点“生成临时密码”）');
      const deactivating = cur.is_active && b.is_active === false;
      if (deactivating && cur.id === admin.id) throw new BizError('不能停用自己的账号');
      const release = deactivating && !!b.release_badge;
      const badge = release ? null : b.badge_no === undefined ? cur.badge_no : b.badge_no?.trim() || null;
      await checkBadge(tx, badge, id);
      let u = await tx.user.update({
        where: { id },
        data: {
          full_name: b.full_name, roles: b.roles.join(','), department: b.department ?? null, email: b.email ?? null,
          is_active: b.is_active, auth_source: source, badge_no: badge, failed_login_count: 0, locked_until: null,
          ...(kingdee
            ? { password_hash: NO_LOCAL_PASSWORD, password_changed_at: null, must_change_password: false }
            : password
              ? { password_hash: hashPassword(password), password_changed_at: new Date(), must_change_password: b.must_change_password !== false }
              : {}),
        },
      });
      if (release) await clearPin(tx, cur, admin);
      else if (b.pin) await setPin(tx, u, b.pin, admin);
      if (release || b.pin) u = (await tx.user.findUnique({ where: { id } }))!;
      return { ...(await this.view(u)), temp_password: tempPassword };
    });
  }

  private async one(tx: any, id: number) {
    const cur = await tx.user.findUnique({ where: { id } });
    if (!cur) throw new NotFound('用户');
    return cur;
  }

  /** 行内“解锁”：清零失败次数与锁定时间 */
  @Post('users/:id/unlock')
  @Perms('admin')
  unlock(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      await this.one(tx, id);
      return this.view(await tx.user.update({ where: { id }, data: { failed_login_count: 0, locked_until: null } }));
    });
  }

  /** 行内“重置密码”：不填则生成临时密码（仅本次返回）；本人下次登录须修改；同时解锁 */
  @Post('users/:id/reset-password')
  @Perms('admin')
  resetPassword(@Param('id', ParseIntPipe) id: number, @Body() b: ResetPwdDto) {
    return this.db.tx(async (tx) => {
      const r = await resetPasswordTx(tx, await this.one(tx, id), b.password);
      return { ...(await this.view(r.user)), temp_password: r.temp_password };
    });
  }

  /** 行内“停用”（离职）：默认释放工牌、清除工位 PIN */
  @Post('users/:id/deactivate')
  @Perms('admin')
  deactivate(@Param('id', ParseIntPipe) id: number, @Body() b: DeactivateDto, @User() admin: CurrentUser) {
    return this.db.tx(async (tx) => this.view(await deactivateTx(tx, await this.one(tx, id), admin, b.release_badge !== false)));
  }

  @Post('users/:id/activate')
  @Perms('admin')
  activate(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      await this.one(tx, id);
      return this.view(await tx.user.update({ where: { id }, data: { is_active: true, failed_login_count: 0, locked_until: null } }));
    });
  }

  /**
   * 批量操作（勾选多个用户）：set_roles 设为指定角色 / add_roles 追加角色 / remove_roles 移除角色 / set_department 设部门 /
   * deactivate 停用（默认释放工牌、清 PIN）/ activate 启用 / force_change 要求下次登录改密 / reset_password 重置为临时密码 / unlock 解锁。
   * 整批在一个事务中，任何一个失败全部回滚。reset_password 返回每人的临时密码（仅本次）。
   */
  @Post('users/batch')
  @Perms('admin')
  batch(@Body() b: BatchDto, @User() admin: CurrentUser) {
    const roles = b.roles ?? [];
    if (['set_roles', 'add_roles', 'remove_roles'].includes(b.action)) {
      if (!roles.length) throw new BizError('请选择角色');
      checkRoles(roles);
    }
    return this.db.tx(async (tx) => {
      const users = await tx.user.findMany({ where: { id: { in: b.ids } }, orderBy: { id: 'asc' } });
      if (users.length !== new Set(b.ids).size) throw new BizError('部分用户不存在，请刷新后重试');
      const passwords: { id: number; username: string; full_name: string; temp_password: string }[] = [];
      let changed = 0;
      const skipped: string[] = [];
      for (const u of users) {
        const cur = u.roles.split(',').filter(Boolean);
        switch (b.action) {
          case 'set_roles':
          case 'add_roles':
          case 'remove_roles': {
            const next = b.action === 'set_roles' ? roles : b.action === 'add_roles' ? [...new Set([...cur, ...roles])] : cur.filter((r) => !roles.includes(r));
            if (u.id === admin.id && cur.includes('admin') && !next.includes('admin')) throw new BizError('不能移除自己的系统管理员角色');
            if (next.join(',') === u.roles) {
              skipped.push(u.username);
              continue;
            }
            await tx.user.update({ where: { id: u.id }, data: { roles: next.join(',') } });
            break;
          }
          case 'set_department':
            await tx.user.update({ where: { id: u.id }, data: { department: b.department?.trim() || null } });
            break;
          case 'deactivate':
            if (u.id === admin.id) throw new BizError('不能停用自己的账号（请取消勾选自己）');
            if (!u.is_active && !(b.release_badge !== false && (u.badge_no || u.pin_hash))) {
              skipped.push(u.username);
              continue;
            }
            await deactivateTx(tx, u, admin, b.release_badge !== false);
            break;
          case 'activate':
            if (u.is_active) {
              skipped.push(u.username);
              continue;
            }
            await tx.user.update({ where: { id: u.id }, data: { is_active: true, failed_login_count: 0, locked_until: null } });
            break;
          case 'force_change':
            if (u.auth_source === 'KINGDEE' || u.must_change_password) {
              skipped.push(u.username);
              continue;
            }
            await tx.user.update({ where: { id: u.id }, data: { must_change_password: true } });
            break;
          case 'reset_password': {
            if (u.auth_source === 'KINGDEE') {
              skipped.push(u.username);
              continue;
            }
            const r = await resetPasswordTx(tx, u, null);
            passwords.push({ id: u.id, username: u.username, full_name: u.full_name, temp_password: r.temp_password! });
            break;
          }
          case 'unlock':
            if (!u.locked_until && !u.failed_login_count) {
              skipped.push(u.username);
              continue;
            }
            await tx.user.update({ where: { id: u.id }, data: { failed_login_count: 0, locked_until: null } });
            break;
        }
        changed++;
      }
      return { ok: true, changed, skipped, passwords };
    });
  }

  /**
   * 审计追踪（只读）。筛选：entity、entity_id、action、date_from/date_to、
   * username（账号精确）、user（账号或姓名，模糊）、doc（单号/编码/序列号，含其明细行；物料编码还包含其 BOM/工艺）。
   * 返回补充 entity_name、doc_no/doc_url、refs（ID → 编码名称）、line_changes（子表按行差异）。
   */
  @Get('audit-logs')
  async auditLogs(@Query() q: Record<string, string>, @User() user: CurrentUser) {
    checkAuditAccess(user, q);
    const and: any[] = [];
    if (q.entity) and.push({ entity: { in: q.entity.split(',') } });
    if (q.entity_id) and.push({ entity_id: Number(q.entity_id) });
    if (q.username) and.push({ username: q.username });
    if (q.user) and.push({ OR: [{ username: like(q.user.trim()) }, { full_name: like(q.user.trim()) }] });
    if (q.action) and.push({ action: { in: q.action.split(',') } });
    if (q.date_from || q.date_to) {
      const ts: any = {};
      if (q.date_from) ts.gte = dateOnly(q.date_from);
      if (q.date_to) ts.lt = addDays(dateOnly(q.date_to)!, 1);
      and.push({ ts });
    }
    if (q.doc?.trim()) {
      const targets = await docTargets(this.db, q.doc);
      if (!targets.length) return { items: [], total: 0, page: 1, page_size: Number(q.page_size) || 50, doc_not_found: true };
      and.push({ OR: targets });
    }
    const where = and.length ? { AND: and } : {};
    // 导出 Excel 时一次最多取 5000 条（通用分页上限为 1000）
    const page = Math.max(Number(q.page) || 1, 1);
    const size = Math.min(Math.max(Number(q.page_size) || 50, 1), 5000);
    const [total, rows] = await Promise.all([
      this.db.base.auditLog.count({ where }),
      this.db.base.auditLog.findMany({ where, orderBy: sortArg('AuditLog', q, [{ id: 'desc' }]), skip: (page - 1) * size, take: size }),
    ]);
    const items = await enrichAudit(this.db, serList('AuditLog', rows), { lineDiff: q.line_diff !== '0' });
    return { items, total, page, page_size: size };
  }

  /** 审计追踪完整性校验：先封存未封存的记录，再复算整条哈希链，返回被篡改/删除/插入的记录 */
  @Get('audit-verify')
  @Perms('admin', 'qa')
  auditVerify() {
    return this.sealer.verify();
  }

  /**
   * 电子签名台账（只读）。筛选：entity、entity_id、user（签名人账号/姓名）、meaning（签名含义）、doc（单号）、date_from/date_to。
   * 返回补充 entity_name（中文对象名）、doc_url（详情页链接）。
   */
  @Get('esignatures')
  async esignatures(@Query() q: Record<string, string>, @User() user: CurrentUser) {
    checkAuditAccess(user, q);
    const and: any[] = [];
    if (q.entity) and.push({ entity: { in: q.entity.split(',') } });
    if (q.entity_id) and.push({ entity_id: Number(q.entity_id) });
    if (q.user) and.push({ OR: [{ username: like(q.user.trim()) }, { full_name: like(q.user.trim()) }] });
    if (q.meaning) and.push({ meaning: like(q.meaning.trim()) });
    if (q.doc) and.push({ doc_no: like(q.doc.trim()) });
    if (q.date_from || q.date_to) {
      const ts: any = {};
      if (q.date_from) ts.gte = dateOnly(q.date_from);
      if (q.date_to) ts.lt = addDays(dateOnly(q.date_to)!, 1);
      and.push({ ts });
    }
    const page = await paginate(this.db.client.eSignature, 'ESignature', { where: and.length ? { AND: and } : {} }, q, 50);
    // 签名记录的单号以签名时保存的为准；补充中文对象名与详情链接（放行批 → DHR 页等）
    const enriched = await enrichAudit(this.db, page.items, { lineDiff: false });
    const items = page.items.map((orig, i) => {
      const { refs: _r, ...x } = enriched[i];
      return { ...x, doc_no: orig.doc_no ?? x.doc_no };
    });
    return { ...page, items };
  }

  /** 电子签名台账筛选项：出现过的签名含义与对象 */
  @Get('esignatures/options')
  @Perms('audit', 'admin')
  async esignOptions() {
    const [meanings, entities] = await Promise.all([
      this.db.base.eSignature.groupBy({ by: ['meaning'], _count: { _all: true }, orderBy: { meaning: 'asc' } }),
      this.db.base.eSignature.groupBy({ by: ['entity'], _count: { _all: true }, orderBy: { entity: 'asc' } }),
    ]);
    return {
      meanings: meanings.map((m) => ({ value: m.meaning, count: m._count._all })),
      entities: entities.map((e) => ({ value: e.entity, label: entityName(e.entity), count: e._count._all })),
    };
  }
}
