/** WMS 接口：库存查询、库存流水、收货、调拨、领料、发货、盘点。 */
import { Body, Controller, Get, Param, ParseArrayPipe, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round, round2 } from '../common/num';
import { inc, like, paginate, ser } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { WmsService } from './wms.service';

/** 查询参数：整数（空/非法 → undefined） */
const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v?: string) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

// ---------- DTO ----------
class ReceiptLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @Type(() => Number) @IsInt() location_id: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() supplier_lot?: string | null;
  @IsOptional() @IsString() mfg_date?: string | null;
  @IsOptional() @IsString() expiry_date?: string | null;
}

class ReceiptDto {
  @IsOptional() @IsString() receipt_type: string = 'CUSTOMER_SUPPLIED'; // CUSTOMER_SUPPLIED / OTHER / OPENING
  @IsOptional() @Type(() => Number) @IsInt() customer_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() supplier_id?: number | null;
  @IsOptional() @IsString() delivery_note?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines: ReceiptLineDto[];
}

class TransferDto {
  @Type(() => Number) @IsInt() stock_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @Type(() => Number) @IsInt() to_location_id: number;
  @IsOptional() @IsString() remark?: string | null;
}

class IssueLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @Type(() => Number) @IsInt() stock_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
}

class IssueDto {
  /** 为空 = 系统按 FEFO 自动分配 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto) lines?: IssueLineDto[] | null;
}

class ShipLineDto {
  @Type(() => Number) @IsInt() so_line_id: number;
  @IsOptional() @Type(() => Number) @IsNumber() qty: number = 0;
  @IsOptional() @IsArray() @IsString({ each: true }) serials?: string[] | null;
}

class ShipmentDto {
  @Type(() => Number) @IsInt() so_id: number;
  @IsOptional() @IsString() carrier?: string | null;
  @IsOptional() @IsString() tracking_no?: string | null;
  @IsOptional() @IsString() ship_to?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ShipLineDto) lines: ShipLineDto[];
}

class CountDto {
  @Type(() => Number) @IsInt() warehouse_id: number;
  @IsOptional() @IsString() remark?: string | null;
}

class CountLineDto {
  @Type(() => Number) @IsInt() id: number;
  @Type(() => Number) @IsNumber() @Min(0) counted_qty: number;
}

@Controller()
export class WmsController {
  constructor(private readonly db: PrismaService, private readonly svc: WmsService) {}

  // ---------- 库存 ----------
  @Get('stock')
  listStock(@Query() q: Record<string, string>) {
    const where: any = { qty: { gt: 0 } };
    if (q.q) where.OR = [{ material: { code: like(q.q) } }, { material: { name: like(q.q) } }, { lot_no: like(q.q) }];
    if (int(q.material_id)) where.material_id = int(q.material_id);
    if (int(q.warehouse_id)) where.location = { warehouse_id: int(q.warehouse_id) };
    if (int(q.location_id)) where.location_id = int(q.location_id);
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.lot_no) where.lot_no = q.lot_no;
    if (int(q.owner_customer_id)) where.owner_customer_id = int(q.owner_customer_id);
    if (int(q.expiring_days) !== undefined) where.expiry_date = { not: null, lte: addDays(today(), int(q.expiring_days)!) };
    return paginate(this.db.client.stock, 'Stock', { where, orderBy: [{ material: { code: 'asc' } }, { expiry_date: 'asc' }, { id: 'asc' }] }, q, 50);
  }

  @Get('stock/summary')
  async stockSummary(@Query() q: Record<string, string>) {
    const groups = await this.db.client.stock.groupBy({ by: ['material_id', 'status'], where: { qty: { gt: 0 } }, _sum: { qty: true } });
    const agg = new Map<number, Record<string, number>>();
    for (const r of groups) {
      if (!agg.has(r.material_id)) agg.set(r.material_id, {});
      agg.get(r.material_id)![r.status] = round(r._sum.qty ?? 0);
    }
    const where: any = { is_active: true };
    if (q.q) where.OR = [{ code: like(q.q) }, { name: like(q.q) }];
    if (q.category) where.category = q.category;
    const belowOnly = bool(q.below_safety);
    const out: any[] = [];
    for (const m of await this.db.client.material.findMany({ where, orderBy: { code: 'asc' } })) {
      const a = agg.get(m.id) ?? {};
      const avail = a.AVAILABLE ?? 0;
      const total = Object.values(a).reduce((s, v) => s + v, 0);
      const row = {
        material_id: m.id, material_code: m.code, material_name: m.name, spec: m.spec, uom: m.uom, category: m.category,
        available: avail, quarantine: a.QUARANTINE ?? 0, rejected: a.REJECTED ?? 0, hold: a.HOLD ?? 0, safety_stock: m.safety_stock,
        below_safety: avail < (m.safety_stock || 0), customer_supplied: !!m.owner_customer_id, amount: round2(total * (m.std_cost || 0)),
      };
      if (belowOnly && !row.below_safety) continue;
      if (!Object.keys(a).length && !belowOnly && !q.q) continue;
      out.push(row);
    }
    return out;
  }

  @Get('stock-moves')
  listMoves(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ material: { code: like(q.q) } }, { lot_no: like(q.q) }, { ref_no: like(q.q) }];
    if (int(q.material_id)) where.material_id = int(q.material_id);
    if (q.move_type) where.move_type = q.move_type;
    if (q.lot_no) where.lot_no = q.lot_no;
    if (q.ref_no) where.ref_no = q.ref_no;
    if (q.date_from || q.date_to) {
      where.ts = {};
      if (q.date_from) where.ts.gte = dateOnly(q.date_from);
      if (q.date_to) where.ts.lt = addDays(dateOnly(q.date_to)!, 1);
    }
    return paginate(this.db.client.stockMove, 'StockMove', { where, orderBy: { id: 'desc' } }, q, 50);
  }

  // ---------- 收货 ----------
  @Get('receipts')
  listReceipts(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { delivery_note: like(q.q) }];
    if (q.receipt_type) where.receipt_type = q.receipt_type;
    return paginate(this.db.client.receipt, 'Receipt', { where, children: ['lines'] }, q);
  }

  @Get('receipts/:id')
  async getReceipt(@Param('id', ParseIntPipe) id: number) {
    const r = await this.db.client.receipt.findUnique({ where: { id }, include: inc('Receipt', ['lines']) });
    if (!r) throw new NotFound('入库单');
    return ser('Receipt', r, ['lines']);
  }

  /** 其他收货：客供料收货 / 期初库存 / 其他入库（采购收货走采购订单，完工入库走生产工单） */
  @Post('receipts')
  @Perms('wms')
  createReceipt(@Body() b: ReceiptDto, @User() user: CurrentUser) {
    if (!['CUSTOMER_SUPPLIED', 'OTHER', 'OPENING'].includes(b.receipt_type)) throw new BizError('采购收货请从采购订单发起；完工入库请从生产工单发起');
    return this.db.tx(async (tx) => {
      const rc = await this.svc.receive(tx, user, {
        receipt_type: b.receipt_type as 'CUSTOMER_SUPPLIED' | 'OTHER' | 'OPENING',
        lines: b.lines.map((l) => ({
          material_id: l.material_id, qty: l.qty, location_id: l.location_id, lot_no: l.lot_no, supplier_lot: l.supplier_lot,
          mfg_date: dateOnly(l.mfg_date), expiry_date: dateOnly(l.expiry_date),
        })),
        supplier_id: b.supplier_id, customer_id: b.customer_id, delivery_note: b.delivery_note, remark: b.remark,
      });
      return ser('Receipt', rc, ['lines']);
    });
  }

  // ---------- 调拨 ----------
  @Post('stock/transfer')
  @Perms('wms')
  transfer(@Body() b: TransferDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const st = await this.svc.transfer(tx, user, b.stock_id, b.qty, b.to_location_id, b.remark);
      return ser('Stock', await tx.stock.findUnique({ where: { id: st.id }, include: inc('Stock') }));
    });
  }

  // ---------- 领料 ----------
  @Get('issues')
  listIssues(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { work_order: { no: like(q.q) } }];
    if (q.status) where.status = q.status;
    if (int(q.wo_id)) where.wo_id = int(q.wo_id);
    return paginate(this.db.client.materialIssue, 'MaterialIssue', { where, children: ['lines'] }, q);
  }

  @Get('issues/:id')
  async getIssue(@Param('id', ParseIntPipe) id: number) {
    const i = await this.db.client.materialIssue.findUnique({ where: { id }, include: inc('MaterialIssue', ['lines']) });
    if (!i) throw new NotFound('领料单');
    return ser('MaterialIssue', i, ['lines']);
  }

  /** 生成领料单（FEFO 自动推荐批次） */
  @Post('work-orders/:id/issues')
  @Perms('wms', 'plan')
  createIssue(@Param('id', ParseIntPipe) id: number, @Body() b: IssueDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.workOrder.findUnique({ where: { id } }))) throw new NotFound('工单');
      const lines = b?.lines?.length ? b.lines.map((l) => ({ material_id: l.material_id, stock_id: l.stock_id, qty: l.qty })) : null;
      const { issue, shortages } = await this.svc.createIssue(tx, user, id, lines);
      return { ...ser('MaterialIssue', issue, ['lines']), shortages };
    });
  }

  /** 领料过账（扣减库存，记录批次追溯） */
  @Post('issues/:id/confirm')
  @Perms('wms')
  confirmIssue(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.materialIssue.findUnique({ where: { id } }))) throw new NotFound('领料单');
      return ser('MaterialIssue', await this.svc.confirmIssue(tx, user, id), ['lines']);
    });
  }

  @Post('issues/:id/cancel')
  @Perms('wms', 'plan')
  cancelIssue(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      const i = await tx.materialIssue.findUnique({ where: { id } });
      if (!i) throw new NotFound('领料单');
      if (i.status !== 'DRAFT') throw new BizError('只能取消未过账的领料单');
      const row = await tx.materialIssue.update({ where: { id }, data: { status: 'CANCELLED' }, include: inc('MaterialIssue', ['lines']) });
      return ser('MaterialIssue', row, ['lines']);
    });
  }

  // ---------- 发货 ----------
  @Get('shipments')
  listShipments(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { tracking_no: like(q.q) }];
    if (q.status) where.status = q.status;
    if (int(q.so_id)) where.so_id = int(q.so_id);
    return paginate(this.db.client.shipment, 'Shipment', { where, children: ['lines'] }, q);
  }

  /** 发货单详情（每行含 serial_list 序列号清单） */
  @Get('shipments/:id')
  async getShipment(@Param('id', ParseIntPipe) id: number) {
    const s = await this.db.client.shipment.findUnique({ where: { id }, include: inc('Shipment', ['lines']) });
    if (!s) throw new NotFound('发货单');
    return ser('Shipment', s, ['lines']);
  }

  /** 创建发货单（仅允许已放行产品，序列号逐台校验） */
  @Post('shipments')
  @Perms('wms', 'sales')
  createShipment(@Body() b: ShipmentDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.salesOrder.findUnique({ where: { id: b.so_id } }))) throw new NotFound('销售订单');
      const sh = await this.svc.createShipment(
        tx, user, b.so_id,
        b.lines.map((l) => ({ so_line_id: l.so_line_id, qty: l.qty, serials: l.serials })),
        { carrier: b.carrier, tracking_no: b.tracking_no, ship_to: b.ship_to, remark: b.remark },
      );
      return ser('Shipment', sh, ['lines']);
    });
  }

  /** 发货过账（扣库存、序列号出库、生成应收） */
  @Post('shipments/:id/confirm')
  @Perms('wms')
  confirmShipment(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.shipment.findUnique({ where: { id } }))) throw new NotFound('发货单');
      return ser('Shipment', await this.svc.confirmShipment(tx, user, id), ['lines']);
    });
  }

  @Post('shipments/:id/cancel')
  @Perms('wms', 'sales')
  cancelShipment(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      const s = await tx.shipment.findUnique({ where: { id } });
      if (!s) throw new NotFound('发货单');
      if (s.status !== 'DRAFT') throw new BizError('已发货不能取消');
      const row = await tx.shipment.update({ where: { id }, data: { status: 'CANCELLED' }, include: inc('Shipment', ['lines']) });
      return ser('Shipment', row, ['lines']);
    });
  }

  /** 可发货序列号（已入库且已放行，按完工先后） */
  @Get('serials/available')
  async serialsAvailable(@Query() q: Record<string, string>) {
    const materialId = int(q.material_id);
    if (materialId === undefined) throw new BizError('缺少参数 material_id');
    const rows = await this.svc.availableSerials(this.db.client, materialId, int(q.limit) ?? 500);
    return rows.map((s) => ({ sn: s.sn, lot_no: s.lot_no, wo_no: s.work_order?.no ?? null, completed_at: s.completed_at }));
  }

  // ---------- 盘点 ----------
  @Get('stock-counts')
  listCounts(@Query() q: Record<string, string>) {
    return paginate(this.db.client.stockCount, 'StockCount', {}, q);
  }

  @Get('stock-counts/:id')
  async getCount(@Param('id', ParseIntPipe) id: number) {
    const c = await this.db.client.stockCount.findUnique({ where: { id }, include: inc('StockCount', ['lines']) });
    if (!c) throw new NotFound('盘点单');
    return ser('StockCount', c, ['lines']);
  }

  /** 创建盘点单（按仓库生成账面快照） */
  @Post('stock-counts')
  @Perms('wms')
  createCount(@Body() b: CountDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => ser('StockCount', await this.svc.createCount(tx, user, b.warehouse_id, b.remark), ['lines']));
  }

  /** 录入实盘数量 */
  @Put('stock-counts/:id/lines')
  @Perms('wms')
  updateCountLines(@Param('id', ParseIntPipe) id: number, @Body(new ParseArrayPipe({ items: CountLineDto, whitelist: true })) body: CountLineDto[]) {
    return this.db.tx(async (tx) => {
      const c = await tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
      if (!c) throw new NotFound('盘点单');
      if (c.status !== 'OPEN') throw new BizError('盘点单已过账');
      const ids = new Set(c.lines.map((l) => l.id));
      for (const ln of body) {
        if (ids.has(ln.id)) await tx.stockCountLine.update({ where: { id: ln.id }, data: { counted_qty: ln.counted_qty } });
      }
      return ser('StockCount', await tx.stockCount.findUnique({ where: { id }, include: inc('StockCount', ['lines']) }), ['lines']);
    });
  }

  /** 盘点过账（生成差异调整） */
  @Post('stock-counts/:id/post')
  @Perms('wms')
  postCount(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      if (!(await tx.stockCount.findUnique({ where: { id } }))) throw new NotFound('盘点单');
      return ser('StockCount', await this.svc.postCount(tx, user, id), ['lines']);
    });
  }
}
