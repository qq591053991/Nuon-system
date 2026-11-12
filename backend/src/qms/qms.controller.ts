/** QMS 接口：检验（IQC）、AQL 抽样计算、NCR（期限/超期/关闭检查/批量关闭）、CAPA。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { Ncr } from '@prisma/client';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { inc, like, paginate, ser, serList } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';
import { samplingPlan } from '../core/aql';
import { EsignService, SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { capaDueDate, closableNcrIds, fullNames, ncrDueDate, overdueWhere } from './qms-rules';
import { QualityService } from './quality.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const yes = (v?: string) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

/** 日期区间筛选（from/to 为 YYYY-MM-DD，含当天） */
function dateRange(from?: string, to?: string) {
  const r: Record<string, Date> = {};
  if (from) r.gte = dateOnly(from)!;
  if (to) r.lt = addDays(dateOnly(to)!, 1);
  return Object.keys(r).length ? r : undefined;
}

// ---------- DTO ----------
class InspItemDto {
  @IsOptional() @Type(() => Number) @IsInt() id?: number | null;
  @IsString() name: string;
  @IsOptional() @IsString() standard?: string | null;
  @IsOptional() @IsString() value?: string | null;
  @IsOptional() @IsString() result?: string | null;
  /** 定量项逐件实测值 */
  @IsOptional() @IsArray() sample_values?: (number | null)[] | null;
  /** 定性项已人工确认 */
  @IsOptional() @IsBoolean() checked?: boolean | null;
  /** 定性项判不合格时的不良件数 */
  @IsOptional() @Type(() => Number) @IsInt() defect_qty?: number | null;
  /** 自定义项目：QUAL/QUANT 与上下限 */
  @IsOptional() @IsString() item_type?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() lower?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() upper?: number | null;
  @IsOptional() @IsString() unit?: string | null;
}

class InspSubmitDto {
  @IsOptional() @Type(() => Number) @IsInt() defect_qty: number = 0;
  /** 逐项检验结果（界面提交时必须逐项完成）；不传时按旧接口只按不良数判定 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InspItemDto) items?: InspItemDto[] | null;
  /** 不合格时申请让步接收（需 QA） */
  @IsOptional() @IsBoolean() concession: boolean = false;
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrDto {
  @IsOptional() @IsString() source: string = 'OTHER'; // CUSTOMER/OTHER/FQC...
  @IsOptional() @IsString() severity: string = 'MAJOR';
  @IsOptional() @Type(() => Number) @IsInt() material_id?: number | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() customer_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() supplier_id?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() qty: number = 1;
  @IsOptional() @IsString() due_date?: string | null;
  @IsString() description: string;
}

class DispositionDto {
  @IsString() disposition: string; // REWORK/SCRAP/USE_AS_IS/RETURN
  @IsOptional() @IsString() remark?: string | null;
  /** 返工时要求更换零件（工位重测前必须先登记返工换件） */
  @IsOptional() @IsBoolean() require_part_change?: boolean | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrCloseDto {
  @IsOptional() @Type(() => Number) @IsInt() capa_id?: number | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrBatchCloseDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(100) @Type(() => Number) @IsInt({ each: true }) ids: number[];
  @IsOptional() @Type(() => Number) @IsInt() capa_id?: number | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrDueDto {
  @IsString() due_date: string;
}

/** CAPA 字段（PUT 时只更新请求中出现的字段） */
const CAPA_FIELDS = ['title', 'source', 'description', 'root_cause', 'correction', 'corrective_action', 'preventive_action', 'owner', 'owner_user_id', 'due_date', 'effectiveness'] as const;

class CapaDto {
  @IsString() title: string;
  @IsOptional() @IsString() source?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() ncr_id?: number | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() root_cause?: string | null;
  @IsOptional() @IsString() correction?: string | null;
  @IsOptional() @IsString() corrective_action?: string | null;
  @IsOptional() @IsString() preventive_action?: string | null;
  @IsOptional() @IsString() owner?: string | null;
  /** 负责人账号（优先；姓名自动带出） */
  @IsOptional() @Type(() => Number) @IsInt() owner_user_id?: number | null;
  @IsOptional() @IsString() due_date?: string | null;
  @IsOptional() @IsString() effectiveness?: string | null;
}

class CapaStatusDto {
  @IsString() status: string; // IN_PROGRESS/VERIFYING/CLOSED
  @IsOptional() @IsString() effectiveness?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

const CAPA_FLOW: Record<string, string[]> = { OPEN: ['IN_PROGRESS'], IN_PROGRESS: ['VERIFYING'], VERIFYING: ['CLOSED', 'IN_PROGRESS'] };

@Controller()
export class QmsController {
  constructor(
    private readonly db: PrismaService,
    private readonly svc: QualityService,
    private readonly numbering: NumberingService,
    private readonly esign: EsignService,
  ) {}

  /** AQL 抽样方案（GB/T 2828.1 正常检验一次抽样；level = I/II/III/S-1~S-4，默认一般检验水平 II） */
  @Get('quality/aql')
  aql(@Query() q: Record<string, string>) {
    const lot = Number(q.lot_qty);
    if (q.lot_qty === undefined || q.lot_qty === '' || !Number.isFinite(lot)) throw new BizError('缺少参数 lot_qty');
    const aql = q.aql !== undefined && q.aql !== '' ? Number(q.aql) : 1.0;
    return samplingPlan(lot, Number.isFinite(aql) ? aql : 1.0, (q.level as any) || 'II');
  }

  // ---------- 检验 ----------
  @Get('inspections')
  listInspections(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { lot_no: like(q.q) }, { material: { code: like(q.q) } }, { material: { name: like(q.q) } }];
    if (q.status) where.status = { in: q.status.split(',') };
    const type = q.insp_type || q.type;
    if (type) where.insp_type = type;
    if (int(q.supplier_id)) where.supplier_id = int(q.supplier_id);
    if (int(q.material_id)) where.material_id = int(q.material_id);
    const created = dateRange(q.date_from, q.date_to);
    if (created) where.created_at = created;
    const inspected = dateRange(q.inspected_from, q.inspected_to);
    if (inspected) where.inspected_at = inspected;
    return paginate(this.db.client.inspection, 'Inspection', { where }, q);
  }

  /** 下一张待检单（先到先检；跳过当前单） */
  @Get('inspections/next')
  async nextInspection(@Query() q: Record<string, string>) {
    const after = int(q.after);
    const row = await this.db.client.inspection.findFirst({
      where: { status: 'PENDING', insp_type: q.insp_type || q.type || 'IQC', ...(after ? { id: { not: after } } : {}) },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      include: inc('Inspection'),
    });
    const left = await this.db.client.inspection.count({ where: { status: 'PENDING', insp_type: q.insp_type || q.type || 'IQC' } });
    return { next: row ? ser('Inspection', row) : null, pending: left };
  }

  @Get('inspections/:id')
  async getInspection(@Param('id', ParseIntPipe) id: number) {
    const i = await this.db.client.inspection.findUnique({ where: { id }, include: inc('Inspection', ['items']) });
    if (!i) throw new NotFound('检验单');
    const ncrs = await this.db.client.ncr.findMany({ where: { inspection_id: id }, orderBy: { id: 'asc' }, select: { id: true, no: true, status: true, disposition: true } });
    return { ...ser('Inspection', i, ['items']), ncrs };
  }

  /** 提交检验结果（电子签名，自动转换库存质量状态） */
  @Post('inspections/:id/submit')
  @Perms('qc')
  submitInspection(@Param('id', ParseIntPipe) id: number, @Body() b: InspSubmitDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.inspection.findUnique({ where: { id } }))) throw new NotFound('检验单');
      const insp = await this.svc.submitInspection(tx, user, id, {
        items: Array.isArray(b.items) ? b.items.map((x) => ({ ...x, result: x.result ?? null })) : null,
        defect_qty: b.defect_qty ?? 0,
        concession: !!b.concession,
        remark: b.remark,
        sig: b.signature,
      });
      return ser('Inspection', insp, ['items']);
    });
  }

  // ---------- NCR ----------
  /** NCR 补充信息：关闭检查（返工复测/重检/退供应商出库）、退供应商单 */
  private async enrichNcrs(tx: Tx, rows: Record<string, any>[]) {
    const ids = rows.map((r) => r.id);
    if (!ids.length) return rows;
    const srs = await tx.supplierReturn.findMany({ where: { ncr_id: { in: ids } }, orderBy: { id: 'asc' } });
    const srBy = new Map(srs.map((s) => [s.ncr_id!, s]));
    const names = await fullNames(tx, rows.map((r) => r.created_by));
    const out = [];
    for (const r of rows) {
      const sr = srBy.get(r.id);
      const block = r.status === 'DISPOSITIONED' ? await this.svc.closeBlocker(tx, r as Ncr) : null;
      out.push({
        ...r,
        created_by_name: r.created_by ? names.get(r.created_by) ?? r.created_by : null,
        close_block: block,
        supplier_return_id: sr?.id ?? null, supplier_return_no: sr?.no ?? null, supplier_return_status: sr?.status ?? null,
      });
    }
    return out;
  }

  @Get('ncrs')
  async listNcrs(@Query() q: Record<string, string>) {
    const AND: any[] = [];
    if (q.q) AND.push({ OR: [{ no: like(q.q) }, { sn: like(q.q) }, { lot_no: like(q.q) }, { description: like(q.q) }] });
    if (q.status) AND.push({ status: { in: q.status.split(',') } });
    if (q.source) AND.push({ source: { in: q.source.split(',') } });
    if (q.severity) AND.push({ severity: { in: q.severity.split(',') } });
    if (q.disposition) AND.push({ disposition: { in: q.disposition.split(',') } });
    if (int(q.wo_id)) AND.push({ wo_id: int(q.wo_id) });
    if (int(q.id)) AND.push({ id: int(q.id) });
    if (int(q.capa_id)) AND.push({ capa_id: int(q.capa_id) });
    const created = dateRange(q.date_from, q.date_to);
    if (created) AND.push({ created_at: created });
    if (yes(q.overdue)) AND.push(overdueWhere());
    // 可关闭：处置已执行完毕、仍未关闭（QA 待办“可关闭的 NCR”）
    if (yes(q.closable)) AND.push({ id: { in: await closableNcrIds(this.db.client) } });
    const page = await paginate(this.db.client.ncr, 'Ncr', { where: AND.length ? { AND } : {} }, q);
    return { ...page, items: await this.enrichNcrs(this.db.client, page.items) };
  }

  @Get('ncrs/:id')
  async getNcr(@Param('id', ParseIntPipe) id: number) {
    const n = await this.db.client.ncr.findUnique({ where: { id }, include: { ...inc('Ncr'), inspection: true, capa: true } });
    if (!n) throw new NotFound('NCR');
    const [row] = await this.enrichNcrs(this.db.client, [ser('Ncr', n)]);
    const complaint = await this.db.client.complaint.findFirst({ where: { ncr_id: id }, select: { id: true, no: true } });
    const rma = await this.db.client.customerReturn.findFirst({ where: { ncr_id: id }, select: { id: true, no: true, status: true } });
    return {
      ...row, inspection_no: n.inspection?.no ?? null, capa_no: n.capa?.no ?? null,
      complaint_id: complaint?.id ?? null, complaint_no: complaint?.no ?? null,
      customer_return_id: rma?.id ?? null, customer_return_no: rma?.no ?? null, customer_return_status: rma?.status ?? null,
    };
  }

  /** 手工开具 NCR（如客诉、巡检发现）；处置期限默认按严重度 */
  @Post('ncrs')
  @Perms('qc', 'qa')
  createNcr(@Body() b: NcrDto, @User() user: CurrentUser) {
    if (b.source === 'PROCESS' || b.source === 'IQC') throw new BizError('过程/来料不合格由系统自动开具');
    const severity = b.severity ?? 'MAJOR';
    if (!['MINOR', 'MAJOR', 'CRITICAL'].includes(severity)) throw new BizError('严重程度无效（MINOR/MAJOR/CRITICAL）');
    return this.db.tx(async (tx) => {
      const n = await tx.ncr.create({
        data: {
          no: await this.numbering.nextNo(tx, 'NCR'), status: 'OPEN', created_by: user.username,
          source: b.source ?? 'OTHER', severity, material_id: b.material_id ?? null, lot_no: b.lot_no ?? null,
          sn: b.sn ?? null, customer_id: b.customer_id ?? null, supplier_id: b.supplier_id ?? null, qty: b.qty ?? 1, description: b.description,
          due_date: b.due_date ? dateOnly(b.due_date) : ncrDueDate(severity),
        },
        include: inc('Ncr'),
      });
      return ser('Ncr', n);
    });
  }

  /** 调整处置期限（QA，留审计追踪） */
  @Put('ncrs/:id/due-date')
  @Perms('qa')
  setDue(@Param('id', ParseIntPipe) id: number, @Body() b: NcrDueDto) {
    return this.db.tx(async (tx) => {
      const n = await tx.ncr.findUnique({ where: { id } });
      if (!n) throw new NotFound('NCR');
      if (n.status !== 'OPEN') throw new BizError('只有待处置的 NCR 可以调整处置期限');
      const d = dateOnly(b.due_date)!;
      if (d.getTime() < today().getTime()) throw new BizError('处置期限不能早于今天');
      return ser('Ncr', await tx.ncr.update({ where: { id }, data: { due_date: d }, include: inc('Ncr') }));
    });
  }

  /** NCR 评审处置（QA 电子签名） */
  @Post('ncrs/:id/disposition')
  @Perms('qa')
  disposition(@Param('id', ParseIntPipe) id: number, @Body() b: DispositionDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.ncr.findUnique({ where: { id } }))) throw new NotFound('NCR');
      return ser('Ncr', await this.svc.dispositionNcr(tx, user, id, b.disposition, b.remark, b.signature, { require_part_change: b.require_part_change }));
    });
  }

  /** 关闭 NCR（QA 电子签名“NCR关闭”；返工须复测合格、退货须已出库；可关联 CAPA） */
  @Post('ncrs/:id/close')
  @Perms('qa')
  closeNcr(@Param('id', ParseIntPipe) id: number, @Body() b: NcrCloseDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => ser('Ncr', await this.svc.closeNcr(tx, user, id, { capa_id: b?.capa_id ?? null, sig: b?.signature })));
  }

  /** 批量关闭 NCR（一次签名；任一条不满足关闭条件则整批不关闭并列出原因） */
  @Post('ncrs/close-batch')
  @Perms('qa')
  closeBatch(@Body() b: NcrBatchCloseDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const ids = [...new Set(b.ids)];
      const rows = await tx.ncr.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
      if (rows.length !== ids.length) throw new NotFound('部分 NCR');
      const problems: string[] = [];
      for (const n of rows) {
        if (n.status !== 'DISPOSITIONED') problems.push(`${n.no}：${n.status === 'OPEN' ? '尚未评审处置' : '已关闭'}`);
        else {
          const block = await this.svc.closeBlocker(tx, n);
          if (block) problems.push(`${n.no}：${block}`);
        }
      }
      if (problems.length) throw new BizError(`以下 NCR 不能关闭，请先处理或从选择中去掉：${problems.join('；')}`);
      if (!b.signature?.password) throw new BizError('此操作需要电子签名（NCR关闭），请输入密码确认');
      const out = [];
      for (const n of rows) out.push(await this.svc.closeNcr(tx, user, n.id, { capa_id: b.capa_id ?? null, sig: b.signature }));
      return { closed: out.length, items: serList('Ncr', out) };
    });
  }

  // ---------- CAPA ----------
  /** 负责人：按账号带出姓名（owner_user_id 优先；只传姓名时按姓名匹配账号） */
  private async ownerOf(tx: Tx, b: { owner?: string | null; owner_user_id?: number | null }) {
    if (b.owner_user_id) {
      const u = await tx.user.findUnique({ where: { id: b.owner_user_id } });
      if (!u) throw new NotFound('负责人账号');
      return { owner_user_id: u.id, owner: u.full_name };
    }
    if (b.owner_user_id === null && !b.owner) return { owner_user_id: null, owner: null };
    const name = (b.owner ?? '').trim();
    if (!name) return { owner_user_id: null, owner: null };
    const u = await tx.user.findFirst({ where: { full_name: name, is_active: true } });
    return { owner_user_id: u?.id ?? null, owner: name };
  }

  /** CAPA 列表/详情补充创建人姓名 */
  private async enrichCapas(tx: Tx, rows: Record<string, any>[]) {
    const names = await fullNames(tx, rows.map((r) => r.created_by));
    return rows.map((r) => ({ ...r, created_by_name: r.created_by ? names.get(r.created_by) ?? r.created_by : null }));
  }

  @Get('capas')
  async listCapas(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { title: like(q.q) }, { owner: like(q.q) }];
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.source) where.source = { in: q.source.split(',') };
    if (q.owner) where.owner = q.owner;
    if (int(q.owner_user_id)) where.owner_user_id = int(q.owner_user_id);
    if (yes(q.overdue)) Object.assign(where, { status: { not: 'CLOSED' }, due_date: { lt: today() } });
    const page = await paginate(this.db.client.capa, 'Capa', { where }, q);
    return { ...page, items: await this.enrichCapas(this.db.client, page.items) };
  }

  /** 可选负责人（启用的账号） */
  @Get('capas/owners')
  async capaOwners(@Query('q') qText?: string) {
    const where: Record<string, any> = { is_active: true };
    if (qText) where.OR = [{ username: like(qText) }, { full_name: like(qText) }, { department: like(qText) }];
    const rows = await this.db.client.user.findMany({ where, orderBy: { username: 'asc' }, take: 200 });
    return rows.map((u) => ({ id: u.id, username: u.username, full_name: u.full_name, department: u.department }));
  }

  @Get('capas/:id')
  async getCapa(@Param('id', ParseIntPipe) id: number) {
    const c = await this.db.client.capa.findUnique({ where: { id } });
    if (!c) throw new NotFound('CAPA');
    const ncrs = await this.db.client.ncr.findMany({ where: { capa_id: id }, orderBy: { id: 'asc' }, include: inc('Ncr') });
    const [row] = await this.enrichCapas(this.db.client, [ser('Capa', c)]);
    return { ...row, ncrs: serList('Ncr', ncrs) };
  }

  @Post('capas')
  @Perms('qa')
  createCapa(@Body() b: CapaDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const c = await tx.capa.create({
        data: {
          no: await this.numbering.nextNo(tx, 'CAPA'), status: 'OPEN', created_by: user.username,
          title: b.title, source: b.source ?? 'NCR', description: b.description ?? null, root_cause: b.root_cause ?? null,
          correction: b.correction ?? null, corrective_action: b.corrective_action ?? null, preventive_action: b.preventive_action ?? null,
          ...(await this.ownerOf(tx, b)), due_date: b.due_date ? dateOnly(b.due_date) : capaDueDate(b.source ?? 'NCR'), effectiveness: b.effectiveness ?? null,
        },
      });
      if (b.ncr_id && (await tx.ncr.findUnique({ where: { id: b.ncr_id } }))) {
        await tx.ncr.update({ where: { id: b.ncr_id }, data: { capa_id: c.id } });
      }
      return ser('Capa', c);
    });
  }

  @Put('capas/:id')
  @Perms('qa')
  updateCapa(@Param('id', ParseIntPipe) id: number, @Body() b: CapaDto) {
    return this.db.tx(async (tx) => {
      const c = await tx.capa.findUnique({ where: { id } });
      if (!c) throw new NotFound('CAPA');
      if (c.status === 'CLOSED') throw new BizError('CAPA 已关闭');
      const data: Record<string, any> = {};
      if (b.owner_user_id !== undefined || b.owner !== undefined) Object.assign(data, await this.ownerOf(tx, b));
      for (const f of CAPA_FIELDS) {
        if (f === 'owner' || f === 'owner_user_id') continue;
        const v = (b as any)[f];
        if (v === undefined) continue; // 只更新请求中出现的字段
        if (f === 'title' || f === 'source') {
          if (v === null) throw new BizError(`字段 ${f} 不能为空`);
          data[f] = v;
        } else data[f] = f === 'due_date' ? dateOnly(v) : v;
      }
      const merged = { ...c, ...data };
      if (merged.status === 'OPEN' && (merged.root_cause || merged.corrective_action)) data.status = 'IN_PROGRESS';
      return ser('Capa', await tx.capa.update({ where: { id }, data }));
    });
  }

  /** CAPA 状态流转（关闭需电子签名；关联 NCR 须已处置） */
  @Post('capas/:id/status')
  @Perms('qa')
  capaStatus(@Param('id', ParseIntPipe) id: number, @Body() b: CapaStatusDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const c = await tx.capa.findUnique({ where: { id } });
      if (!c) throw new NotFound('CAPA');
      if (!(CAPA_FLOW[c.status] ?? []).includes(b.status)) throw new BizError(`不能从 ${c.status} 变更为 ${b.status}`);
      const data: Record<string, any> = { status: b.status };
      if (b.effectiveness) data.effectiveness = b.effectiveness;
      const effectiveness = b.effectiveness || c.effectiveness;
      if (b.status === 'VERIFYING' && !(c.root_cause && c.corrective_action)) throw new BizError('请先填写根本原因和纠正措施');
      if (b.status === 'CLOSED') {
        if (!effectiveness) throw new BizError('请填写有效性验证结论');
        const open = await tx.ncr.findMany({ where: { capa_id: c.id, status: 'OPEN' }, select: { no: true } });
        if (open.length) throw new BizError(`关联的不合格品 ${open.map((n) => n.no).join('、')} 尚未评审处置，不能关闭 CAPA`);
        await this.esign.sign(tx, user, b.signature, 'CAPA关闭批准', 'qms_capa', c.id, c.no);
        data.closed_by = user.full_name;
        data.closed_at = new Date();
      }
      return ser('Capa', await tx.capa.update({ where: { id }, data }));
    });
  }
}
