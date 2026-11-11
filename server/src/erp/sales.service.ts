/** 销售订单：草稿 → 确认 → 一键生成生产工单 → 发货 → 关闭 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round, round2 } from '../common/num';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser, serList } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { NumberingService } from '../core/numbering.service';
import type { SoDto, SoLineDto } from './erp.dto';
import { qInt } from './query';

const CH = ['lines'];

@Injectable()
export class SalesService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 校验并生成订单行：只能销售成品/半成品；代工产品只能卖给所属品牌客户 */
  private async soLines(tx: Tx, customerId: number, lines: SoLineDto[]) {
    if (!lines?.length) throw new BizError('请至少录入一行订单明细');
    const out: Prisma.SalesOrderLineUncheckedCreateWithoutOrderInput[] = [];
    let total = 0;
    for (const [i, ln] of lines.entries()) {
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!m) throw new NotFound('物料');
      if (!['FINISHED', 'SEMI'].includes(m.category)) throw new BizError(`${m.code} 不是成品/半成品，不能销售`);
      if (m.customer_id && m.customer_id !== customerId) throw new BizError(`${m.code} 是其他品牌客户的产品（代工产品只能卖给注册人/品牌方）`);
      const price = ln.unit_price ?? 0;
      const amount = round2(ln.qty * price);
      total += amount;
      out.push({
        line_no: i + 1, material_id: m.id, qty: ln.qty, unit_price: price, amount,
        delivery_date: dateOnly(ln.delivery_date), remark: ln.remark ?? null,
      });
    }
    return { lines: out, total: round2(total) };
  }

  private async checkCustomer(tx: Tx, id: number) {
    if (!(await tx.customer.findUnique({ where: { id } }))) throw new NotFound('客户');
  }

  list(q: Record<string, string>) {
    const where: Prisma.SalesOrderWhereInput = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { customer_po: like(q.q) }, { customer: { name: like(q.q) } }];
    if (q.status) where.status = inList(q.status);
    const cid = qInt(q.customer_id);
    if (cid) where.customer_id = cid;
    return paginate(this.db.client.salesOrder, 'SalesOrder', { where, orderBy: { id: 'desc' }, children: CH }, q);
  }

  /** 详情（含关联工单/发货） */
  async get(id: number) {
    const c = this.db.client;
    const so = await c.salesOrder.findUnique({ where: { id }, include: inc('SalesOrder', CH) });
    if (!so) throw new NotFound('销售订单');
    const d = ser('SalesOrder', so, CH);
    d.work_orders = serList('WorkOrder', await c.workOrder.findMany({ where: { so_id: id }, orderBy: { id: 'asc' }, include: inc('WorkOrder') }));
    d.shipments = serList('Shipment', await c.shipment.findMany({ where: { so_id: id }, orderBy: { id: 'asc' }, include: inc('Shipment') }));
    return d;
  }

  create(user: CurrentUser, b: SoDto) {
    return this.db.tx(async (tx) => {
      await this.checkCustomer(tx, b.customer_id);
      const { lines, total } = await this.soLines(tx, b.customer_id, b.lines);
      const so = await tx.salesOrder.create({
        data: {
          no: await this.numbering.nextNo(tx, 'SO'), status: 'DRAFT', created_by: user.username,
          customer_id: b.customer_id, order_date: dateOnly(b.order_date) ?? today(), delivery_date: dateOnly(b.delivery_date),
          customer_po: b.customer_po ?? null, currency: b.currency ?? 'CNY', ship_to: b.ship_to ?? null, remark: b.remark ?? null,
          total_amount: total, lines: { create: lines },
        },
        include: inc('SalesOrder', CH),
      });
      return ser('SalesOrder', so, CH);
    });
  }

  /** 修改草稿：未传的字段不变；显式 null 清空可选字段（必填字段 order_date/currency 传 null 时保持不变） */
  update(id: number, b: SoDto) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id } });
      if (!so) throw new NotFound('销售订单');
      if (so.status !== 'DRAFT') throw new BizError('只有草稿状态可以修改');
      const customerId = b.customer_id ?? so.customer_id;
      if (customerId !== so.customer_id) await this.checkCustomer(tx, customerId);
      const { lines, total } = await this.soLines(tx, customerId, b.lines);
      const row = await tx.salesOrder.update({
        where: { id },
        data: {
          customer_id: customerId,
          order_date: b.order_date ? dateOnly(b.order_date)! : undefined,
          delivery_date: b.delivery_date === undefined ? undefined : dateOnly(b.delivery_date),
          customer_po: b.customer_po,
          currency: b.currency ?? undefined,
          ship_to: b.ship_to,
          remark: b.remark,
          total_amount: total,
          lines: { deleteMany: {}, create: lines },
        },
        include: inc('SalesOrder', CH),
      });
      return ser('SalesOrder', row, CH);
    });
  }

  transition(id: number, allowed: string[], to: string, msg: string) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id } });
      if (!so) throw new NotFound('销售订单');
      if (!allowed.includes(so.status)) throw new BizError(msg);
      const row = await tx.salesOrder.update({ where: { id }, data: { status: to }, include: inc('SalesOrder', CH) });
      return ser('SalesOrder', row, CH);
    });
  }

  async cancel(id: number) {
    const so = await this.db.client.salesOrder.findUnique({ where: { id } });
    if (so && (await this.db.client.workOrder.findFirst({ where: { so_id: id, status: { not: 'CANCELLED' } } }))) {
      throw new BizError('订单已有生产工单，请先取消工单');
    }
    return this.transition(id, ['DRAFT', 'CONFIRMED'], 'CANCELLED', '当前状态不能取消');
  }

  /** 一键生成生产工单：每行按未排产数量生成计划工单（需有已发布 BOM） */
  createWorkOrders(id: number, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, include: { lines: { orderBy: { line_no: 'asc' }, include: { material: true } } } });
      if (!so) throw new NotFound('销售订单');
      if (!['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'].includes(so.status)) throw new BizError('订单未确认');
      const created: string[] = [];
      const skipped: string[] = [];
      for (const ln of so.lines) {
        const agg = await tx.workOrder.aggregate({ where: { so_line_id: ln.id, status: { not: 'CANCELLED' } }, _sum: { planned_qty: true } });
        const qty = round(ln.qty - (agg._sum.planned_qty ?? 0));
        if (qty <= 0) continue;
        if (!(await releasedBom(tx, ln.material_id))) {
          skipped.push(`${ln.material.code}：无已发布 BOM`);
          continue;
        }
        const wo = await tx.workOrder.create({
          data: {
            no: await this.numbering.nextNo(tx, 'WO'), material_id: ln.material_id, customer_id: so.customer_id, so_id: so.id, so_line_id: ln.id,
            planned_qty: qty, planned_start: today(), planned_end: ln.delivery_date ?? so.delivery_date, status: 'PLANNED', source: so.no,
            created_by: user.username,
          },
        });
        created.push(wo.no);
      }
      if (created.length) await tx.salesOrder.update({ where: { id }, data: { status: 'IN_PRODUCTION' } });
      return { work_orders: created, skipped };
    });
  }
}
