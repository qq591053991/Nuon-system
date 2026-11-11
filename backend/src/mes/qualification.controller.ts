/**
 * 人员上岗资质（培训/上岗资质矩阵）：GMP 要求操作人员经培训考核合格后才能在对应工序上岗。
 * 工位报工时校验报工人是否持有该工序代码（或 * = 全部工序）的有效资质，见 ProductionService.checkQualification。
 */
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
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
  constructor(private readonly db: PrismaService) {}

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

  /** 可选人员（启用的账号，供资质登记选择；无需系统管理权限） */
  @Get('users')
  @Perms('qa', 'admin')
  async users(@Query('q') qText?: string) {
    const where: Record<string, any> = { is_active: true };
    if (qText) where.OR = [{ username: like(qText) }, { full_name: like(qText) }, { department: like(qText) }];
    const rows = await this.db.client.user.findMany({ where, orderBy: { username: 'asc' }, take: 200 });
    return rows.map((u) => ({ id: u.id, username: u.username, full_name: u.full_name, department: u.department, roles: u.roles }));
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
      return out(row);
    });
  }

  @Put(':id')
  @Perms('qa', 'admin')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: QualificationUpdateDto) {
    return this.db.tx(async (tx) => {
      const cur = await tx.qualification.findUnique({ where: { id } });
      if (!cur) throw new NotFound('上岗资质');
      const data = this.data(b);
      await this.check(tx, { ...cur, ...data });
      const row = await tx.qualification.update({ where: { id }, data, include: inc('Qualification') });
      return out(row);
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
