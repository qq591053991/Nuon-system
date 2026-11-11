/** MES 接口：生产工单、工位终端（扫码过站）、完工入库、DHR 与产品放行。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { inc, like, paginate, ser, serList } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';
import { SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { ProductionService } from './production.service';

const WO_CHILDREN = ['materials', 'operations'];

class WoDto {
  @IsInt() material_id: number;
  @IsNumber() @IsPositive() planned_qty: number;
  @IsOptional() @IsInt() customer_id?: number | null;
  @IsOptional() @IsInt() so_id?: number | null;
  @IsOptional() @IsInt() so_line_id?: number | null;
  @IsOptional() @IsInt() bom_id?: number | null;
  @IsOptional() @IsInt() routing_id?: number | null;
  @IsOptional() @IsString() planned_start?: string | null;
  @IsOptional() @IsString() planned_end?: string | null;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsString() remark?: string | null;
}

class KeyPartDto {
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() part_sn?: string | null;
}

class ReportDto {
  @IsString() sn: string;
  /** 工位所在工序，用于防跳站校验 */
  @IsOptional() @IsInt() seq?: number | null;
  /** 可选：人工判 FAIL（如外观不良） */
  @IsOptional() @IsString() result?: string | null;
  @IsOptional() @IsObject() values?: Record<string, number | null> = {};
  @IsOptional() @IsInt() equipment_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => KeyPartDto) key_parts?: KeyPartDto[] = [];
}

class BatchReportDto {
  @IsInt() seq: number;
  @IsOptional() @IsNumber() good_qty?: number = 0;
  @IsOptional() @IsNumber() ng_qty?: number = 0;
  @IsOptional() @IsObject() values?: Record<string, number | null> = {};
  @IsOptional() @IsInt() equipment_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
}

class FgReceiptDto {
  @IsInt() location_id: number;
  @IsOptional() @IsNumber() qty?: number | null;
}

class DhrReleaseDto {
  @IsOptional() @IsBoolean() approve?: boolean = true;
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto;
}

const WO_FIELDS = ['material_id', 'planned_qty', 'customer_id', 'so_id', 'so_line_id', 'bom_id', 'routing_id', 'planned_start', 'planned_end', 'priority', 'remark'] as const;

/** 请求体 → 工单字段（只取请求中出现的字段；日期转纯日期） */
function woData(b: WoDto): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of WO_FIELDS) {
    const v = (b as any)[k];
    if (v === undefined) continue;
    out[k] = k === 'planned_start' || k === 'planned_end' ? dateOnly(v) : v;
  }
  return out;
}

@Controller()
export class MesController {
  constructor(
    private readonly db: PrismaService,
    private readonly numbering: NumberingService,
    private readonly svc: ProductionService,
  ) {}

  private async woOut(tx: Tx, id: number) {
    const wo = await tx.workOrder.findUnique({ where: { id }, include: inc('WorkOrder', WO_CHILDREN) });
    if (!wo) throw new NotFound('生产工单');
    return ser('WorkOrder', wo, WO_CHILDREN);
  }

  private async wo(tx: Tx, id: number) {
    const wo = await tx.workOrder.findUnique({ where: { id } });
    if (!wo) throw new NotFound('生产工单');
    return wo;
  }

  // ---------- 生产工单 ----------
  @Get('work-orders')
  list(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) {
      where.OR = [{ no: like(q.q) }, { lot_no: like(q.q) }, { material: { code: like(q.q) } }, { material: { name: like(q.q) } }];
    }
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.material_id) where.material_id = Number(q.material_id);
    if (q.customer_id) where.customer_id = Number(q.customer_id);
    if (q.dhr_status) where.dhr_status = q.dhr_status;
    return paginate(this.db.client.workOrder, 'WorkOrder', { where, orderBy: { id: 'desc' } }, q);
  }

  @Get('work-orders/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.woOut(this.db.client, id);
  }

  @Post('work-orders')
  @Perms('plan')
  create(@Body() b: WoDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const m = await tx.material.findUnique({ where: { id: b.material_id } });
      if (!m || !['FINISHED', 'SEMI'].includes(m.category)) throw new BizError('请选择成品或半成品');
      const data = woData(b);
      const wo = await tx.workOrder.create({
        data: {
          priority: 3, ...data, material_id: b.material_id, planned_qty: b.planned_qty,
          no: await this.numbering.nextNo(tx, 'WO'), status: 'PLANNED', created_by: user.username,
          customer_id: data.customer_id || m.customer_id,
        } as any,
      });
      return this.woOut(tx, wo.id);
    });
  }

  @Put('work-orders/:id')
  @Perms('plan')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: WoDto) {
    return this.db.tx(async (tx) => {
      const wo = await this.wo(tx, id);
      if (wo.status !== 'PLANNED') throw new BizError('工单已下达，不能修改');
      await tx.workOrder.update({ where: { id }, data: woData(b) });
      return this.woOut(tx, id);
    });
  }

  @Post('work-orders/:id/release')
  @Perms('plan')
  release(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await this.svc.releaseWorkOrder(tx, id, user);
      return this.woOut(tx, id);
    });
  }

  @Post('work-orders/:id/cancel')
  @Perms('plan')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      const wo = await tx.workOrder.findUnique({ where: { id }, include: { materials: true } });
      if (!wo) throw new NotFound('生产工单');
      if (!['PLANNED', 'RELEASED'].includes(wo.status)) throw new BizError('已开工的工单不能取消');
      if (wo.materials.some((m) => (m.issued_qty || 0) > 0)) throw new BizError('工单已领料，请先退料');
      await tx.workOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.serialNumber.updateMany({ where: { wo_id: id }, data: { status: 'SCRAPPED' } });
      return this.woOut(tx, id);
    });
  }

  @Get('work-orders/:id/serials')
  async serials(@Param('id', ParseIntPipe) id: number, @Query('status') status?: string) {
    const rows = await this.db.client.serialNumber.findMany({
      where: { wo_id: id, ...(status ? { status } : {}) }, orderBy: { sn: 'asc' }, include: inc('SerialNumber'),
    });
    return serList('SerialNumber', rows);
  }

  @Get('work-orders/:id/records')
  async records(@Param('id', ParseIntPipe) id: number) {
    const rows = await this.db.client.operationRecord.findMany({
      where: { wo_id: id }, orderBy: { id: 'desc' }, include: inc('OperationRecord', ['values']),
    });
    return serList('OperationRecord', rows, ['values']);
  }

  // ---------- 工位终端 ----------
  @Get('mes/scan/:sn')
  scan(@Param('sn') sn: string) {
    return this.svc.scanSerial(this.db.client, sn);
  }

  @Post('mes/report')
  @Perms('mes')
  report(@Body() b: ReportDto, @User() user: CurrentUser) {
    return this.db.tx((tx) =>
      this.svc.reportSerial(tx, user, {
        sn: b.sn, seq: b.seq, result: b.result, values: b.values, equipment_id: b.equipment_id, remark: b.remark, key_parts: b.key_parts,
      }),
    );
  }

  @Post('work-orders/:id/report-batch')
  @Perms('mes')
  reportBatch(@Param('id', ParseIntPipe) id: number, @Body() b: BatchReportDto, @User() user: CurrentUser) {
    return this.db.tx((tx) =>
      this.svc.reportBatch(tx, user, id, {
        seq: b.seq, good_qty: b.good_qty, ng_qty: b.ng_qty, values: b.values, equipment_id: b.equipment_id, remark: b.remark,
      }),
    );
  }

  @Post('work-orders/:id/fg-receipt')
  @Perms('wms', 'plan')
  fgReceipt(@Param('id', ParseIntPipe) id: number, @Body() b: FgReceiptDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const rcId = await this.svc.fgReceipt(tx, user, id, b.location_id, b.qty);
      const rc = await tx.receipt.findUniqueOrThrow({ where: { id: rcId }, include: inc('Receipt', ['lines']) });
      return ser('Receipt', rc, ['lines']);
    });
  }

  // ---------- DHR 与放行 ----------
  @Get('work-orders/:id/dhr')
  dhr(@Param('id', ParseIntPipe) id: number) {
    return this.svc.buildDhr(this.db.client, id);
  }

  @Post('work-orders/:id/dhr/release')
  @Perms('qa')
  dhrRelease(@Param('id', ParseIntPipe) id: number, @Body() b: DhrReleaseDto, @User() user: CurrentUser) {
    if (b.signature && b.reason && !b.signature.reason) b.signature.reason = b.reason;
    return this.db.tx(async (tx) => {
      await this.svc.releaseDhr(tx, user, id, b.approve !== false, b.signature, b.reason);
      return this.woOut(tx, id);
    });
  }
}
