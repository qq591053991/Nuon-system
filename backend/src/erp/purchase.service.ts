/** 采购订单：草稿 → 审批（合格供方校验，GMP 采购控制）→ 收货（IQC、应付由仓储服务生成）→ 关闭 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { MoneySum } from '../common/money';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser, serList } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { NumberingService } from '../core/numbering.service';
import { WmsService, type ReceiveLineInput } from '../wms/wms.service';
import type { PoDto, PoLineDto, ReceiveDto } from './erp.dto';
import { calcPoLine } from './po-line';
import { qInt } from './query';

const CH = ['lines'];

@Injectable()
export class PurchaseService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService, private readonly wms: WmsService) {}

  /** 校验并生成订单行：客供料不能采购 */
  private async poLines(tx: Tx, lines: PoLineDto[]) {
    if (!lines?.length) throw new BizError('请至少录入一行采购明细');
    const out: Prisma.PurchaseOrderLineUncheckedCreateWithoutOrderInput[] = [];
    const total = new MoneySum();
    for (const [i, ln] of lines.entries()) {
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!m) throw new NotFound('物料');
      if (m.owner_customer_id) throw new BizError(`${m.code} 是客供料，不能采购`);
      // 采购单位换算：qty/unit_price 为库存单位，purchase_* 记录下单单位（见 po-line.ts）
      const c = calcPoLine(m, ln, i + 1);
      total.add(c.amount);
      out.push({
        line_no: i + 1, material_id: m.id, ...c,
        expected_date: dateOnly(ln.expected_date), remark: ln.remark ?? null,
      });
    }
    return { lines: out, total: total.value };
  }

  private async checkSupplier(tx: Tx, id: number) {
    if (!(await tx.supplier.findUnique({ where: { id } }))) throw new NotFound('供应商');
  }

  list(q: Record<string, string>) {
    const where: Prisma.PurchaseOrderWhereInput = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { supplier: { name: like(q.q) } }];
    if (q.status) where.status = inList(q.status);
    const sid = qInt(q.supplier_id);
    if (sid) where.supplier_id = sid;
    return paginate(this.db.client.purchaseOrder, 'PurchaseOrder', { where, orderBy: { id: 'desc' }, children: CH }, q);
  }

  /** 详情（含收货记录） */
  async get(id: number) {
    const c = this.db.client;
    const po = await c.purchaseOrder.findUnique({ where: { id }, include: inc('PurchaseOrder', CH) });
    if (!po) throw new NotFound('采购订单');
    const d = ser('PurchaseOrder', po, CH);
    d.receipts = serList('Receipt', await c.receipt.findMany({ where: { po_id: id }, orderBy: { id: 'asc' }, include: inc('Receipt', CH) }), CH);
    return d;
  }

  create(user: CurrentUser, b: PoDto) {
    return this.db.tx(async (tx) => {
      await this.checkSupplier(tx, b.supplier_id);
      const { lines, total } = await this.poLines(tx, b.lines);
      const po = await tx.purchaseOrder.create({
        data: {
          no: await this.numbering.nextNo(tx, 'PO'), status: 'DRAFT', created_by: user.username,
          supplier_id: b.supplier_id, order_date: dateOnly(b.order_date) ?? today(), expected_date: dateOnly(b.expected_date),
          currency: b.currency ?? 'CNY', remark: b.remark ?? null, total_amount: total, lines: { create: lines },
        },
        include: inc('PurchaseOrder', CH),
      });
      return ser('PurchaseOrder', po, CH);
    });
  }

  /** 修改草稿：未传的字段不变；显式 null 清空可选字段（必填字段 order_date/currency 传 null 时保持不变） */
  update(id: number, b: PoDto) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFound('采购订单');
      if (po.status !== 'DRAFT') throw new BizError('只有草稿状态可以修改');
      const supplierId = b.supplier_id ?? po.supplier_id;
      if (supplierId !== po.supplier_id) await this.checkSupplier(tx, supplierId);
      const { lines, total } = await this.poLines(tx, b.lines);
      const row = await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplier_id: supplierId,
          order_date: b.order_date ? dateOnly(b.order_date)! : undefined,
          expected_date: b.expected_date === undefined ? undefined : dateOnly(b.expected_date),
          currency: b.currency ?? undefined,
          remark: b.remark,
          total_amount: total,
          lines: { deleteMany: {}, create: lines },
        },
        include: inc('PurchaseOrder', CH),
      });
      return ser('PurchaseOrder', row, CH);
    });
  }

  /** 审批：供应商必须在合格供方名录内且资质未过期 */
  approve(id: number, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: true } });
      if (!po) throw new NotFound('采购订单');
      if (po.status !== 'DRAFT') throw new BizError('只有草稿可以审批');
      const sup = po.supplier;
      if (sup.status !== 'QUALIFIED') {
        throw new BizError(`供应商【${sup.name}】不在合格供方名录内（当前：${sup.status}），不能下单（GMP 采购控制）`);
      }
      if (sup.qualification_expiry && sup.qualification_expiry.getTime() < today().getTime()) {
        throw new BizError(`供应商【${sup.name}】资质已于 ${fmtDate(sup.qualification_expiry)} 过期，请先完成供应商再评价`);
      }
      const row = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'APPROVED', approved_by: user.full_name, approved_at: new Date() },
        include: inc('PurchaseOrder', CH),
      });
      return ser('PurchaseOrder', row, CH);
    });
  }

  cancel(id: number) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!po) throw new NotFound('采购订单');
      if (!['DRAFT', 'APPROVED'].includes(po.status) || po.lines.some((l) => (l.received_qty || 0) > 0)) {
        throw new BizError('已收货的订单不能取消，请使用“关闭”');
      }
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' }, include: inc('PurchaseOrder', CH) });
      return ser('PurchaseOrder', row, CH);
    });
  }

  close(id: number) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFound('采购订单');
      if (!['APPROVED', 'PARTIAL_RECEIVED', 'RECEIVED'].includes(po.status)) throw new BizError('当前状态不能关闭');
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED' }, include: inc('PurchaseOrder', CH) });
      return ser('PurchaseOrder', row, CH);
    });
  }

  /** 采购收货：调用仓储收货（自动生成 IQC 检验单、更新订单收货状态、生成应付） */
  receive(id: number, b: ReceiveDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: { orderBy: { line_no: 'asc' } } } });
      if (!po) throw new NotFound('采购订单');
      if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) throw new BizError('采购订单未审批或已完结，不能收货');
      const lines: ReceiveLineInput[] = [];
      for (const ln of b.lines) {
        const pl = await tx.purchaseOrderLine.findUnique({ where: { id: ln.po_line_id } });
        if (!pl) throw new NotFound('采购订单行');
        lines.push({
          po_line_id: ln.po_line_id, qty: ln.qty, location_id: ln.location_id, lot_no: ln.lot_no ?? null, supplier_lot: ln.supplier_lot ?? null,
          mfg_date: dateOnly(ln.mfg_date), expiry_date: dateOnly(ln.expiry_date), material_id: pl.material_id,
        });
      }
      const rc = await this.wms.receive(tx, user, {
        receipt_type: 'PURCHASE', lines, supplier_id: po.supplier_id, po, delivery_note: b.delivery_note ?? null, remark: b.remark ?? null,
      });
      const row = await tx.receipt.findUnique({ where: { id: rc.id }, include: inc('Receipt', CH) });
      return ser('Receipt', row, CH);
    });
  }
}
