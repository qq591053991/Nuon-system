/** QMS 接口（移植自 backend/app/routers/qms.py）：检验（IQC）、AQL 抽样计算、NCR、CAPA。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { inc, like, paginate, ser, serList } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { samplingPlan } from '../core/aql';
import { EsignService, SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { QualityService } from './quality.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ---------- DTO ----------
class InspItemDto {
  @IsOptional() @IsInt() id?: number | null;
  @IsString() name: string;
  @IsOptional() @IsString() standard?: string | null;
  @IsOptional() @IsString() value?: string | null;
  @IsOptional() @IsString() result: string = 'PASS';
}

class InspSubmitDto {
  @IsOptional() @IsInt() defect_qty: number = 0;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InspItemDto) items: InspItemDto[] = [];
  /** 不合格时申请让步接收（需 QA） */
  @IsOptional() @IsBoolean() concession: boolean = false;
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrDto {
  @IsOptional() @IsString() source: string = 'OTHER'; // CUSTOMER/OTHER/FQC...
  @IsOptional() @IsString() severity: string = 'MAJOR';
  @IsOptional() @IsInt() material_id?: number | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @IsInt() customer_id?: number | null;
  @IsOptional() @IsInt() supplier_id?: number | null;
  @IsOptional() @IsNumber() qty: number = 1;
  @IsString() description: string;
}

class DispositionDto {
  @IsString() disposition: string; // REWORK/SCRAP/USE_AS_IS/RETURN
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class NcrCloseDto {
  @IsOptional() @IsInt() capa_id?: number | null;
}

/** CAPA 字段（PUT 时只更新请求中出现的字段） */
const CAPA_FIELDS = ['title', 'source', 'description', 'root_cause', 'correction', 'corrective_action', 'preventive_action', 'owner', 'due_date', 'effectiveness'] as const;

class CapaDto {
  @IsString() title: string;
  @IsOptional() @IsString() source?: string | null;
  @IsOptional() @IsInt() ncr_id?: number | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() root_cause?: string | null;
  @IsOptional() @IsString() correction?: string | null;
  @IsOptional() @IsString() corrective_action?: string | null;
  @IsOptional() @IsString() preventive_action?: string | null;
  @IsOptional() @IsString() owner?: string | null;
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

  /** AQL 抽样方案（GB/T 2828.1 一般检验水平 II） */
  @Get('quality/aql')
  aql(@Query() q: Record<string, string>) {
    const lot = Number(q.lot_qty);
    if (q.lot_qty === undefined || q.lot_qty === '' || !Number.isFinite(lot)) throw new BizError('缺少参数 lot_qty');
    const aql = q.aql !== undefined && q.aql !== '' ? Number(q.aql) : 1.0;
    return samplingPlan(lot, Number.isFinite(aql) ? aql : 1.0);
  }

  // ---------- 检验 ----------
  @Get('inspections')
  listInspections(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { lot_no: like(q.q) }, { material: { code: like(q.q) } }, { material: { name: like(q.q) } }];
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.insp_type) where.insp_type = q.insp_type;
    return paginate(this.db.client.inspection, 'Inspection', { where }, q);
  }

  @Get('inspections/:id')
  async getInspection(@Param('id', ParseIntPipe) id: number) {
    const i = await this.db.client.inspection.findUnique({ where: { id }, include: inc('Inspection', ['items']) });
    if (!i) throw new NotFound('检验单');
    return ser('Inspection', i, ['items']);
  }

  /** 提交检验结果（电子签名，自动转换库存质量状态） */
  @Post('inspections/:id/submit')
  @Perms('qc')
  submitInspection(@Param('id', ParseIntPipe) id: number, @Body() b: InspSubmitDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.inspection.findUnique({ where: { id } }))) throw new NotFound('检验单');
      const insp = await this.svc.submitInspection(tx, user, id, {
        items: (b.items ?? []).map((x) => ({ id: x.id, name: x.name, standard: x.standard, value: x.value, result: x.result ?? 'PASS' })),
        defect_qty: b.defect_qty ?? 0,
        concession: !!b.concession,
        remark: b.remark,
        sig: b.signature,
      });
      return ser('Inspection', insp, ['items']);
    });
  }

  // ---------- NCR ----------
  @Get('ncrs')
  listNcrs(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { sn: like(q.q) }, { lot_no: like(q.q) }, { description: like(q.q) }];
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.source) where.source = q.source;
    if (int(q.wo_id)) where.wo_id = int(q.wo_id);
    return paginate(this.db.client.ncr, 'Ncr', { where }, q);
  }

  @Get('ncrs/:id')
  async getNcr(@Param('id', ParseIntPipe) id: number) {
    const n = await this.db.client.ncr.findUnique({ where: { id }, include: inc('Ncr') });
    if (!n) throw new NotFound('NCR');
    return ser('Ncr', n);
  }

  /** 手工开具 NCR（如客诉、巡检发现） */
  @Post('ncrs')
  @Perms('qc', 'qa')
  createNcr(@Body() b: NcrDto, @User() user: CurrentUser) {
    if (b.source === 'PROCESS' || b.source === 'IQC') throw new BizError('过程/来料不合格由系统自动开具');
    return this.db.tx(async (tx) => {
      const n = await tx.ncr.create({
        data: {
          no: await this.numbering.nextNo(tx, 'NCR'), status: 'OPEN', created_by: user.username,
          source: b.source ?? 'OTHER', severity: b.severity ?? 'MAJOR', material_id: b.material_id ?? null, lot_no: b.lot_no ?? null,
          sn: b.sn ?? null, customer_id: b.customer_id ?? null, supplier_id: b.supplier_id ?? null, qty: b.qty ?? 1, description: b.description,
        },
        include: inc('Ncr'),
      });
      return ser('Ncr', n);
    });
  }

  /** NCR 评审处置（QA 电子签名） */
  @Post('ncrs/:id/disposition')
  @Perms('qa')
  disposition(@Param('id', ParseIntPipe) id: number, @Body() b: DispositionDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.ncr.findUnique({ where: { id } }))) throw new NotFound('NCR');
      return ser('Ncr', await this.svc.dispositionNcr(tx, user, id, b.disposition, b.remark, b.signature));
    });
  }

  /** 关闭 NCR（可关联 CAPA） */
  @Post('ncrs/:id/close')
  @Perms('qa')
  closeNcr(@Param('id', ParseIntPipe) id: number, @Body() b: NcrCloseDto) {
    return this.db.tx(async (tx) => {
      const n = await tx.ncr.findUnique({ where: { id } });
      if (!n) throw new NotFound('NCR');
      if (n.status !== 'DISPOSITIONED') throw new BizError('NCR 需先完成处置');
      if (b?.capa_id && !(await tx.capa.findUnique({ where: { id: b.capa_id } }))) throw new NotFound('CAPA');
      const row = await tx.ncr.update({
        where: { id },
        data: { status: 'CLOSED', ...(b?.capa_id ? { capa_id: b.capa_id } : {}) },
        include: inc('Ncr'),
      });
      return ser('Ncr', row);
    });
  }

  // ---------- CAPA ----------
  @Get('capas')
  listCapas(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { title: like(q.q) }];
    if (q.status) where.status = { in: q.status.split(',') };
    return paginate(this.db.client.capa, 'Capa', { where }, q);
  }

  @Get('capas/:id')
  async getCapa(@Param('id', ParseIntPipe) id: number) {
    const c = await this.db.client.capa.findUnique({ where: { id } });
    if (!c) throw new NotFound('CAPA');
    const ncrs = await this.db.client.ncr.findMany({ where: { capa_id: id }, orderBy: { id: 'asc' }, include: inc('Ncr') });
    return { ...ser('Capa', c), ncrs: serList('Ncr', ncrs) };
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
          owner: b.owner ?? null, due_date: dateOnly(b.due_date), effectiveness: b.effectiveness ?? null,
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
      for (const f of CAPA_FIELDS) {
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

  /** CAPA 状态流转（关闭需电子签名） */
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
        await this.esign.sign(tx, user, b.signature, 'CAPA关闭批准', 'qms_capa', c.id, c.no);
        data.closed_by = user.full_name;
        data.closed_at = new Date();
      }
      return ser('Capa', await tx.capa.update({ where: { id }, data }));
    });
  }
}
