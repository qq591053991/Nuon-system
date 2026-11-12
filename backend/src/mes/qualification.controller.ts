/**
 * 人员上岗资质（培训/上岗资质矩阵）：GMP 要求操作人员经培训考核合格后才能在对应工序上岗。
 * 工位报工时校验报工人是否持有该工序代码（或 * = 全部工序）的有效资质，见 ProductionService.checkQualification。
 * 资质是 GMP 培训记录：登记、变更、作废均需 QA 电子签名；人员登记后不可修改（选错人员请作废后重新登记）；
 * 只能为有工位报工权限（mes）的人员登记；可按工牌号查找人员（扫工牌）。
 */
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { userPermissions } from '../auth/roles';
import { EsignService, SignatureDto } from '../core/esign.service';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { inc, like, paginate, ser } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';

export const QUALIFICATION_LEVELS = ['TRAINEE', 'QUALIFIED', 'TRAINER'] as const;

class QualificationDto {
  @Type(() => Number) @IsInt() user_id: number;
  /** 工序代码（如 OPT / SAFE），* 表示全部工序 */
  @IsString() @MaxLength(32) op_code: string;
  @IsOptional() @IsIn(QUALIFICATION_LEVELS as unknown as string[]) level?: string;
  @IsString() certified_at: string;
  @IsOptional() @IsString() expires_at?: string | null;
  @IsOptional() @IsString() @MaxLength(64) trainer?: string | null;
  @IsOptional() @IsString() @MaxLength(128) certificate?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(256) remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class QualificationVoidDto {
  @IsString() @MaxLength(200) reason: string;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class QualificationUpdateDto {
  @IsOptional() @Type(() => Number) @IsInt() user_id?: number;
  @IsOptional() @IsString() @MaxLength(32) op_code?: string;
  @IsOptional() @IsIn(QUALIFICATION_LEVELS as unknown as string[]) level?: string;
  @IsOptional() @IsString() certified_at?: string;
  @IsOptional() @IsString() expires_at?: string | null;
  @IsOptional() @IsString() @MaxLength(64) trainer?: string | null;
  @IsOptional() @IsString() @MaxLength(128) certificate?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(256) remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

const FIELDS = ['user_id', 'op_code', 'level', 'certified_at', 'expires_at', 'trainer', 'certificate', 'is_active', 'remark'] as const;
const DATE_KEYS = new Set(['certified_at', 'expires_at']);

/** 有效 = 启用、已生效、未过期且不是“培训中”（可独立上岗）；入参为序列化后的记录（日期为 YYYY-MM-DD） */
function withValid(q: Record<string, any>) {
  const t = fmtDate(today())!;
  return { ...q, valid: !!q.is_active && q.level !== 'TRAINEE' && q.certified_at <= t && (!q.expires_at || q.expires_at >= t) };
}

const out = (row: any) => withValid(ser('Qualification', row));

@Controller('qualifications')
export class QualificationController {
  constructor(private readonly db: PrismaService, private readonly esign: EsignService) {}

  /** 列表：按人员 / 工序代码 / 启用 / 当前有效筛选；q 搜索姓名、账号、工序代码、证书编号 */
  @Get()
  async list(@Query() q: Record<string, string>) {
    const where: Record<string, any> = {};
    if (q.q) {
      where.OR = [
        { op_code: like(q.q) }, { certificate: like(q.q) }, { trainer: like(q.q) },
        { user: { full_name: like(q.q) } }, { user: { username: like(q.q) } },
      ];
    }
    if (q.user_id) where.user_id = Number(q.user_id);
    if (q.op_code) where.op_code = q.op_code;
    if (q.level) where.level = q.level;
    if (q.is_active !== undefined && q.is_active !== '') where.is_active = ['1', 'true', 'yes'].includes(q.is_active.toLowerCase());
    if (q.valid === '1' || q.valid === 'true') {
      const t = today();
      Object.assign(where, { is_active: true, level: { not: 'TRAINEE' }, certified_at: { lte: t }, AND: [{ OR: [{ expires_at: null }, { expires_at: { gte: t } }] }] });
    }
    const page = await paginate(this.db.client.qualification, 'Qualification', { where, orderBy: [{ user_id: 'asc' }, { op_code: 'asc' }, { id: 'asc' }] }, q, 50);
    return { ...page, items: page.items.map(withValid) };
  }

  /**
   * 可选人员：启用且有工位报工权限（mes）的账号，显示工牌号；badge=工牌号 精确查找（扫工牌）；all=1 列出全部启用账号。
   * 供资质登记选择，无需系统管理权限。
   */
  @Get('users')
  @Perms('qa', 'admin')
  async users(@Query('q') qText?: string, @Query('badge') badge?: string, @Query('all') all?: string) {
    const where: Record<string, any> = { is_active: true };
    if (badge) where.badge_no = { equals: badge.trim(), mode: 'insensitive' };
    else if (qText) where.OR = [{ username: like(qText) }, { full_name: like(qText) }, { department: like(qText) }, { badge_no: like(qText) }];
    const rows = await this.db.client.user.findMany({ where, orderBy: [{ badge_no: 'asc' }, { username: 'asc' }], take: 200 });
    return rows
      .map((u) => ({
        id: u.id, username: u.username, full_name: u.full_name, department: u.department, roles: u.roles, badge_no: u.badge_no,
        can_report: userPermissions(u).has('mes'),
      }))
      .filter((u) => all === '1' || u.can_report);
  }

  /** 工序代码清单（来自工艺路线），供资质登记选择 */
  @Get('op-codes')
  async opCodes() {
    const ops = await this.db.client.routingOperation.findMany({ select: { code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] });
    const map = new Map<string, Set<string>>();
    for (const o of ops) {
      if (!map.has(o.code)) map.set(o.code, new Set());
      map.get(o.code)!.add(o.name);
    }
    return [{ code: '*', name: '全部工序' }, ...[...map].map(([code, names]) => ({ code, name: [...names].join(' / ') }))];
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const row = await this.db.client.qualification.findUnique({ where: { id }, include: inc('Qualification') });
    if (!row) throw new NotFound('上岗资质');
    return out(row);
  }

  private async check(tx: Tx, merged: { user_id: number; op_code: string; certified_at: Date; expires_at: Date | null }) {
    const u = await tx.user.findUnique({ where: { id: merged.user_id } });
    if (!u) throw new BizError('人员不存在');
    if (!userPermissions(u).has('mes')) {
      throw new BizError(`${u.full_name}（${u.username}）没有工位报工权限，不需要上岗资质——请确认是否选错了人员`);
    }
    if (!merged.op_code) throw new BizError('请填写工序代码（* 表示全部工序）');
    if (merged.op_code !== '*' && !(await tx.routingOperation.findFirst({ where: { code: merged.op_code } }))) {
      throw new BizError(`工序代码 ${merged.op_code} 不存在于任何工艺路线（* 表示全部工序）`);
    }
    if (merged.expires_at && merged.expires_at.getTime() < merged.certified_at.getTime()) throw new BizError('有效期不能早于取证日期');
  }

  private data(b: QualificationDto | QualificationUpdateDto): Record<string, any> {
    const d: Record<string, any> = {};
    for (const k of FIELDS) {
      const v = (b as any)[k];
      if (v === undefined) continue;
      if (DATE_KEYS.has(k)) d[k] = dateOnly(v);
      else if (typeof v === 'string') d[k] = v.trim() === '' ? null : v.trim();
      else d[k] = v;
    }
    if (d.certified_at === null) throw new BizError('请填写取证日期');
    if (d.op_code === null) throw new BizError('请填写工序代码（* 表示全部工序）');
    return d;
  }

  @Post()
  @Perms('qa', 'admin')
  create(@Body() b: QualificationDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const data = this.data(b);
      await this.check(tx, { user_id: data.user_id, op_code: data.op_code, certified_at: data.certified_at, expires_at: data.expires_at ?? null });
      const row = await tx.qualification.create({ data: { level: 'QUALIFIED', ...data, created_by: user.username } as any, include: inc('Qualification') });
      await this.esign.sign(tx, user, b.signature, '上岗资质登记', 'hr_qualification', row.id, `${(row as any).user?.username ?? ''} ${row.op_code}`.trim());
      return out(row);
    });
  }

  @Put(':id')
  @Perms('qa', 'admin')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: QualificationUpdateDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const cur = await tx.qualification.findUnique({ where: { id }, include: { user: true } });
      if (!cur) throw new NotFound('上岗资质');
      const data = this.data(b);
      if (data.user_id !== undefined && data.user_id !== cur.user_id) {
        throw new BizError('资质登记后不能更换人员：如选错了人员，请“作废”本条后为正确的人员重新登记');
      }
      delete data.user_id;
      await this.check(tx, { ...cur, ...data });
      const row = await tx.qualification.update({ where: { id }, data, include: inc('Qualification') });
      await this.esign.sign(tx, user, b.signature, '上岗资质变更', 'hr_qualification', id, `${cur.user.username} ${row.op_code}`);
      return out(row);
    });
  }

  /** 作废（选错人员/资质撤销）：停用并记录原因，QA 电子签名“上岗资质作废”；记录保留 */
  @Post(':id/void')
  @Perms('qa', 'admin')
  void(@Param('id', ParseIntPipe) id: number, @Body() b: QualificationVoidDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const cur = await tx.qualification.findUnique({ where: { id }, include: { user: true } });
      if (!cur) throw new NotFound('上岗资质');
      if (!cur.is_active) throw new BizError('该资质已停用/作废');
      const why = (b.reason || '').trim();
      if (!why) throw new BizError('请填写作废原因（如：选错人员、考核不合格撤销）');
      await this.esign.sign(tx, user, { ...(b.signature as SignatureDto), reason: (b.signature?.reason || why).slice(0, 250) }, '上岗资质作废', 'hr_qualification', id, `${cur.user.username} ${cur.op_code}`);
      const remark = [cur.remark, `作废：${why}（${user.full_name}）`].filter(Boolean).join('；').slice(0, 256);
      return out(await tx.qualification.update({ where: { id }, data: { is_active: false, remark }, include: inc('Qualification') }));
    });
  }

  /** 删除（审计追踪保留删除前内容）；建议优先“停用”，以保留培训记录 */
  @Delete(':id')
  @Perms('qa', 'admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      if (!(await tx.qualification.findUnique({ where: { id } }))) throw new NotFound('上岗资质');
      await tx.qualification.delete({ where: { id } });
      return { ok: true };
    });
  }
}
