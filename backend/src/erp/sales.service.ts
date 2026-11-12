/**
 * 销售订单：草稿 → 确认 → 生成生产工单（预览、按交期倒排）→ 发货 → 关闭。
 * 已确认订单：无下游（工单/发货）时可“撤销确认”退回草稿；有下游时用“订单变更”改数量/交期（校验已发货、提示受影响工单）。
 * 所有修改由审计追踪自动记录字段级变更，变更原因另记一条审计（change_reason）。
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { lineAmount, MoneySum, price6 } from '../common/money';
import { EPS, g, num, round } from '../common/num';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser, serList } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { NumberingService } from '../core/numbering.service';
import type { SoChangeDto, SoDto, SoLineDto, SoWorkOrdersDto } from './erp.dto';
import { qInt } from './query';
import { ACTIVE_SO, backSchedule, coverageFor, isDiscreteUom, lineCoverage, LIVE_WO } from './so-plan';

const CH = ['lines'];
/** 订单金额字段：只有销售/财务（含厂长）可见 */
const MONEY_PERMS = ['sales', 'finance'];

type SoFull = Prisma.SalesOrderGetPayload<{ include: { lines: { include: { material: true } } } }>;

/** 变更原因写入审计追踪（与字段级变更同一事务、同一操作人） */
export async function auditReason(tx: Tx, user: CurrentUser, entity: string, entityId: number, text: string) {
  await tx.auditLog.create({
    data: {
      username: user.username, full_name: user.full_name, entity, entity_id: entityId, action: 'UPDATE',
      changes: JSON.stringify({ change_reason: [null, text.slice(0, 500)] }),
    },
  });
}

/** 无金额权限时去掉单价/金额 */
export function maskMoney(user: CurrentUser | undefined, perms: Set<string> | null, d: any) {
  if (!user || !perms || MONEY_PERMS.some((p) => perms.has(p))) return d;
  const strip = (o: any) => {
    if (!o) return o;
    o.total_amount = null;
    for (const l of o.lines ?? []) {
      l.unit_price = null;
      l.amount = null;
    }
    return o;
  };
  return Array.isArray(d) ? d.map(strip) : strip(d);
}

@Injectable()
export class SalesService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 校验产品：只能销售成品/半成品；代工产品只能卖给所属品牌客户 */
  private async checkProduct(tx: Tx, customerId: number, materialId: number) {
    const m = await tx.material.findUnique({ where: { id: materialId } });
    if (!m) throw new NotFound('物料');
    if (!['FINISHED', 'SEMI'].includes(m.category)) throw new BizError(`${m.code} 不是成品/半成品，不能销售`);
    if (m.customer_id && m.customer_id !== customerId) throw new BizError(`${m.code} 是其他品牌客户的产品（代工产品只能卖给注册人/品牌方）`);
    return m;
  }

  /** 校验并生成订单行 */
  private async soLines(tx: Tx, customerId: number, lines: SoLineDto[]) {
    if (!lines?.length) throw new BizError('请至少录入一行订单明细');
    const out: (Prisma.SalesOrderLineUncheckedCreateWithoutOrderInput & { id?: number })[] = [];
    const total = new MoneySum();
    for (const [i, ln] of lines.entries()) {
      const m = await this.checkProduct(tx, customerId, ln.material_id);
      const price = price6(ln.unit_price ?? 0);
      const amount = lineAmount(ln.qty, price);
      total.add(amount);
      out.push({
        id: ln.id ?? undefined, line_no: i + 1, material_id: m.id, qty: ln.qty, unit_price: price, amount,
        delivery_date: dateOnly(ln.delivery_date), remark: ln.remark ?? null,
      });
    }
    return { lines: out, total: total.value };
  }

  private async checkCustomer(tx: Tx, id: number) {
    if (!(await tx.customer.findUnique({ where: { id } }))) throw new NotFound('客户');
  }

  list(q: Record<string, string>) {
    const where: Prisma.SalesOrderWhereInput = {};
    if (q.q) {
      where.OR = [
        { no: like(q.q) }, { customer_po: like(q.q) }, { customer: { name: like(q.q) } }, { customer: { short_name: like(q.q) } },
        { lines: { some: { material: { OR: [{ code: like(q.q) }, { name: like(q.q) }] } } } },
      ];
    }
    if (q.status) where.status = inList(q.status);
    const cid = qInt(q.customer_id);
    if (cid) where.customer_id = cid;
    const range = (from?: string, to?: string) =>
      from || to ? { ...(from ? { gte: dateOnly(from)! } : {}), ...(to ? { lte: dateOnly(to)! } : {}) } : undefined;
    const od = range(q.date_from, q.date_to);
    if (od) where.order_date = od;
    const dd = range(q.delivery_from, q.delivery_to);
    if (dd) where.delivery_date = dd;
    return paginate(this.db.client.salesOrder, 'SalesOrder', { where, orderBy: { id: 'desc' }, children: CH }, q);
  }

  /** 详情（含关联工单/发货、各行已排产数量） */
  async get(id: number) {
    const c = this.db.client;
    const so = await c.salesOrder.findUnique({ where: { id }, include: inc('SalesOrder', CH) });
    if (!so) throw new NotFound('销售订单');
    const d = ser('SalesOrder', so, CH);
    d.work_orders = serList('WorkOrder', await c.workOrder.findMany({ where: { so_id: id }, orderBy: { id: 'asc' }, include: inc('WorkOrder') }));
    d.shipments = serList('Shipment', await c.shipment.findMany({ where: { so_id: id }, orderBy: { id: 'asc' }, include: inc('Shipment') }));
    const live = d.work_orders.filter((w: any) => w.status !== 'CANCELLED');
    for (const l of d.lines) l.planned_qty = round(live.filter((w: any) => w.so_line_id === l.id).reduce((s: number, w: any) => s + (w.planned_qty || 0), 0));
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
          total_amount: total, lines: { create: lines.map(({ id: _id, ...l }) => l) },
        },
        include: inc('SalesOrder', CH),
      });
      return ser('SalesOrder', so, CH);
    });
  }

  /**
   * 修改草稿：未传的字段不变；显式 null 清空可选字段（必填字段 order_date/currency 传 null 时保持不变）。
   * 明细行带 id 的原行修改（保留行 id，审计追踪按行记录变更），不带 id 的新增，未出现的删除。
   */
  update(id: number, b: SoDto) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!so) throw new NotFound('销售订单');
      if (so.status !== 'DRAFT') throw new BizError('只有草稿状态可以修改；已确认的订单请用【变更】，或先【撤销确认】退回草稿');
      const customerId = b.customer_id ?? so.customer_id;
      if (customerId !== so.customer_id) await this.checkCustomer(tx, customerId);
      const { lines, total } = await this.soLines(tx, customerId, b.lines);
      const keep = new Set(lines.map((l) => l.id).filter((x): x is number => !!x && so.lines.some((o) => o.id === x)));
      const gone = so.lines.filter((l) => !keep.has(l.id)).map((l) => l.id);
      if (gone.length) await tx.salesOrderLine.deleteMany({ where: { id: { in: gone } } });
      for (const { id: lid, ...l } of lines) {
        if (lid && keep.has(lid)) await tx.salesOrderLine.update({ where: { id: lid }, data: l });
        else await tx.salesOrderLine.create({ data: { ...l, order_id: id } });
      }
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

  /** 下游单据：未取消的工单、未取消的发货单 */
  private async downstream(tx: Tx, id: number) {
    const wos = await tx.workOrder.findMany({ where: { so_id: id, status: { not: 'CANCELLED' } }, orderBy: { id: 'asc' } });
    const shipments = await tx.shipment.findMany({ where: { so_id: id, status: { not: 'CANCELLED' } }, orderBy: { id: 'asc' } });
    return { wos, shipments };
  }

  async cancel(id: number) {
    const so = await this.db.client.salesOrder.findUnique({ where: { id } });
    if (so) {
      const { wos, shipments } = await this.downstream(this.db.client, id);
      if (wos.length) throw new BizError(`订单已有生产工单（${wos.map((w) => w.no).join('、')}），请先取消工单；如只是改数量/交期，请用【变更】`);
      if (shipments.length) throw new BizError(`订单已有发货单（${shipments.map((s) => s.no).join('、')}），不能取消；不再发货请用【关闭（短交结案）】`);
    }
    return this.transition(id, ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION'], 'CANCELLED', '当前状态不能取消');
  }

  /** 撤销确认（反审核）：没有工单和发货单时退回草稿，可再修改后重新确认 */
  unconfirm(id: number, reason: string, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id } });
      if (!so) throw new NotFound('销售订单');
      if (!['CONFIRMED', 'IN_PRODUCTION'].includes(so.status)) throw new BizError('只有已确认、尚未发货的订单可以撤销确认');
      const { wos, shipments } = await this.downstream(tx, id);
      if (wos.length) {
        throw new BizError(`订单已生成工单（${wos.map((w) => w.no).join('、')}），不能撤销确认；改数量/交期请用【变更】，或先取消工单`);
      }
      if (shipments.length) throw new BizError(`订单已有发货单（${shipments.map((s) => s.no).join('、')}），不能撤销确认；改数量/交期请用【变更】`);
      if (!reason?.trim()) throw new BizError('请填写撤销确认的原因');
      const row = await tx.salesOrder.update({ where: { id }, data: { status: 'DRAFT' }, include: inc('SalesOrder', CH) });
      await auditReason(tx, user, 'erp_sales_order', id, `撤销确认（退回草稿）：${reason.trim()}`);
      return ser('SalesOrder', row, CH);
    });
  }

  // ---------------- 订单变更（已确认订单改数量/交期/单价） ----------------

  /** 分析变更：返回差异、阻止项（errors）、提醒（warnings）与受影响工单；不写库 */
  private async analyzeChange(tx: Tx, so: SoFull, b: SoChangeDto) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const changes: string[] = [];
    const affected: { wo_id: number; wo_no: string; status: string; message: string }[] = [];
    if (!b.lines?.length) errors.push('请至少保留一行订单明细');
    const wos = await tx.workOrder.findMany({ where: { so_id: so.id, status: { in: LIVE_WO } }, orderBy: { id: 'asc' } });
    const pendingShip = await tx.shipmentLine.groupBy({
      by: ['so_line_id'], where: { shipment: { so_id: so.id, status: 'DRAFT' } }, _sum: { qty: true },
    });
    const pending = new Map(pendingShip.map((r) => [r.so_line_id, r._sum.qty ?? 0]));
    const shippedLines = new Set(
      (await tx.shipmentLine.findMany({ where: { shipment: { so_id: so.id, status: { not: 'CANCELLED' } } }, select: { so_line_id: true } })).map((r) => r.so_line_id),
    );
    const newDelivery = b.delivery_date === undefined ? so.delivery_date : dateOnly(b.delivery_date);
    if (b.delivery_date !== undefined && fmtDate(newDelivery) !== fmtDate(so.delivery_date)) {
      changes.push(`交期 ${fmtDate(so.delivery_date) ?? '空'} → ${fmtDate(newDelivery) ?? '空'}`);
    }
    for (const [k, label] of [['customer_po', '客户PO号'], ['ship_to', '收货地址'], ['remark', '备注']] as const) {
      if (b[k] !== undefined && (b[k] ?? null) !== (so[k] ?? null)) changes.push(`${label} ${so[k] ?? '空'} → ${b[k] ?? '空'}`);
    }

    const byId = new Map(so.lines.map((l) => [l.id, l]));
    const seen = new Set<number>();
    const lineWos = (lid: number) => wos.filter((w) => w.so_line_id === lid);
    const woList = (list: typeof wos) => list.map((w) => w.no).join('、');
    const checkDates = (lineNo: number, code: string, oldD: Date | null, newD: Date | null, list: typeof wos) => {
      if (fmtDate(oldD) === fmtDate(newD) || !newD) return;
      for (const w of list) {
        if (!['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(w.status)) continue;
        if (w.planned_end && w.planned_end.getTime() > newD.getTime()) {
          affected.push({
            wo_id: w.id, wo_no: w.no, status: w.status,
            message: `第${lineNo}行 ${code} 新交期 ${fmtDate(newD)} 早于工单 ${w.no} 计划完工 ${fmtDate(w.planned_end)}，请在工单上【调整】计划日期`,
          });
        } else if (oldD && newD.getTime() > oldD.getTime()) {
          affected.push({ wo_id: w.id, wo_no: w.no, status: w.status, message: `第${lineNo}行 ${code} 交期推迟到 ${fmtDate(newD)}，工单 ${w.no} 可按需推迟（不调整也不影响交付）` });
        }
      }
    };

    const newLines: { dto: SoLineDto; idx: number }[] = [];
    for (const [idx, ln] of (b.lines ?? []).entries()) {
      if (!ln.id) {
        newLines.push({ dto: ln, idx });
        continue;
      }
      const old = byId.get(ln.id);
      if (!old) {
        errors.push(`第${idx + 1}行不是本订单的明细，请刷新后重试`);
        continue;
      }
      seen.add(ln.id);
      const code = old.material.code;
      const mine = lineWos(old.id);
      const shipped = old.shipped_qty || 0;
      const pend = pending.get(old.id) ?? 0;
      const tag = `第${old.line_no}行 ${code}`;
      if (ln.material_id !== old.material_id) {
        if (mine.length || shipped > EPS || shippedLines.has(old.id)) {
          errors.push(`${tag} 已${mine.length ? `排产（${woList(mine)}）` : '发货'}，不能更换产品；请保留此行（可把数量改为已发货数量），另起一行录入新产品`);
          continue;
        }
        try {
          const m = await this.checkProduct(tx, so.customer_id, ln.material_id);
          changes.push(`${tag} 产品 → ${m.code}`);
        } catch (e: any) {
          errors.push(`${tag}：${e?.response?.detail ?? e.message}`);
          continue;
        }
      }
      if (ln.qty < shipped + pend - EPS) {
        errors.push(`${tag} 已发货 ${g(shipped)}${pend > EPS ? `、待发货 ${g(pend)}` : ''}，变更后数量不能少于 ${g(shipped + pend)}`);
      }
      if (Math.abs(ln.qty - old.qty) > EPS) {
        changes.push(`${tag} 数量 ${g(old.qty)} → ${g(ln.qty)}`);
        const woQty = round(mine.reduce((s, w) => s + w.planned_qty - (w.scrap_qty || 0), 0));
        if (ln.qty > old.qty && mine.length && ln.qty > woQty + EPS) {
          warnings.push(`${tag} 增加 ${g(ln.qty - old.qty)}，已排产 ${g(woQty)}：变更后请点【生成工单】补排 ${g(ln.qty - Math.max(woQty, shipped))}`);
        }
        if (ln.qty < woQty - EPS) {
          let over = round(woQty - ln.qty);
          for (const w of [...mine].reverse()) {
            if (over <= EPS) break;
            const started = ['IN_PROGRESS', 'COMPLETED', 'CLOSED'].includes(w.status);
            affected.push({
              wo_id: w.id, wo_no: w.no, status: w.status,
              message: started
                ? `${tag} 订单减到 ${g(ln.qty)}，工单 ${w.no}（计划 ${g(w.planned_qty)}）已开工：未开工部分可在工单上【调整】减少，已完工的多余数量入库为库存`
                : `${tag} 订单减到 ${g(ln.qty)}，工单 ${w.no} 计划 ${g(w.planned_qty)}，请在工单上【调整】减少 ${g(Math.min(over, w.planned_qty))}${w.status === 'PLANNED' ? '' : '（已下达未开工，可调）'}`,
            });
            over = round(over - w.planned_qty);
          }
        }
      }
      const oldPrice = num(old.unit_price);
      const newPrice = price6(ln.unit_price ?? oldPrice);
      if (Math.abs(newPrice - oldPrice) > 1e-9) {
        if (shipped > EPS) errors.push(`${tag} 已发货 ${g(shipped)}（已生成应收），不能修改单价；如需调价请联系财务处理应收差额`);
        else changes.push(`${tag} 单价 ${g(oldPrice)} → ${g(newPrice)}`);
      }
      // 行字段未传 = 不改
      const lineD = ln.delivery_date === undefined ? old.delivery_date : dateOnly(ln.delivery_date);
      const oldD = old.delivery_date ?? so.delivery_date;
      const newD = lineD ?? newDelivery;
      if (fmtDate(old.delivery_date) !== fmtDate(lineD)) {
        changes.push(`${tag} 交期 ${fmtDate(old.delivery_date) ?? '同表头'} → ${fmtDate(lineD) ?? '同表头'}`);
      }
      checkDates(old.line_no, code, oldD, newD, mine);
      if ((ln.remark ?? null) !== (old.remark ?? null) && ln.remark !== undefined) changes.push(`${tag} 备注已修改`);
    }
    for (const old of so.lines) {
      if (seen.has(old.id)) continue;
      const mine = lineWos(old.id);
      const tag = `第${old.line_no}行 ${old.material.code}`;
      if (mine.length || (old.shipped_qty || 0) > EPS || shippedLines.has(old.id)) {
        errors.push(`${tag} 已${mine.length ? `排产（${woList(mine)}）` : '发货'}，不能删除；可把数量改为已发货数量`);
      } else {
        changes.push(`${tag} 删除`);
      }
    }
    for (const { dto, idx } of newLines) {
      try {
        const m = await this.checkProduct(tx, so.customer_id, dto.material_id);
        changes.push(`新增 ${m.code} × ${g(dto.qty)}`);
        warnings.push(`新增行 ${m.code} 需要排产：变更后请点【生成工单】`);
      } catch (e: any) {
        errors.push(`第${idx + 1}行：${e?.response?.detail ?? e.message}`);
      }
    }
    return { errors, warnings, changes, affected, newDelivery };
  }

  /** 订单变更：preview=true 只返回差异与影响；否则保存（需填原因） */
  change(id: number, b: SoChangeDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, include: { lines: { include: { material: true }, orderBy: { line_no: 'asc' } } } });
      if (!so) throw new NotFound('销售订单');
      if (!ACTIVE_SO.includes(so.status)) throw new BizError('只有已确认、生产中或部分发货的订单可以变更；草稿可直接修改');
      const a = await this.analyzeChange(tx, so, b);
      const result = { changes: a.changes, warnings: a.warnings, errors: a.errors, affected: a.affected };
      if (b.preview) return result;
      if (a.errors.length) throw new BizError(a.errors.join('；'));
      if (!a.changes.length) throw new BizError('没有修改任何内容');
      if (!b.reason?.trim()) throw new BizError('请填写变更原因（如：客户邮件要求追加 5 台）');

      const total = new MoneySum();
      const byId = new Map(so.lines.map((l) => [l.id, l]));
      const keep = new Set<number>();
      let maxNo = Math.max(0, ...so.lines.map((l) => l.line_no));
      const statusLines: { qty: number; shipped: number }[] = [];
      for (const ln of b.lines) {
        const old = ln.id ? byId.get(ln.id) : undefined;
        const price = price6(ln.unit_price ?? (old ? num(old.unit_price) : 0));
        const amount = lineAmount(ln.qty, price);
        total.add(amount);
        const data = {
          material_id: ln.material_id, qty: ln.qty, unit_price: price, amount,
          delivery_date: ln.delivery_date === undefined && old ? old.delivery_date : dateOnly(ln.delivery_date),
          remark: ln.remark === undefined && old ? old.remark : (ln.remark ?? null),
        };
        if (old) {
          keep.add(old.id);
          await tx.salesOrderLine.update({ where: { id: old.id }, data });
          statusLines.push({ qty: ln.qty, shipped: old.shipped_qty || 0 });
        } else {
          await tx.salesOrderLine.create({ data: { ...data, order_id: id, line_no: ++maxNo } });
          statusLines.push({ qty: ln.qty, shipped: 0 });
        }
      }
      const gone = so.lines.filter((l) => !keep.has(l.id)).map((l) => l.id);
      if (gone.length) await tx.salesOrderLine.deleteMany({ where: { id: { in: gone } } });
      const allShipped = statusLines.every((l) => l.shipped + EPS >= l.qty);
      const anyShipped = statusLines.some((l) => l.shipped > EPS);
      const status = allShipped ? 'SHIPPED' : anyShipped ? 'PARTIAL_SHIPPED' : so.status === 'PARTIAL_SHIPPED' ? 'IN_PRODUCTION' : so.status;
      await tx.salesOrder.update({
        where: { id },
        data: {
          delivery_date: b.delivery_date === undefined ? undefined : a.newDelivery,
          customer_po: b.customer_po, ship_to: b.ship_to, remark: b.remark, total_amount: total.value, status,
        },
      });
      await auditReason(tx, user, 'erp_sales_order', id, `订单变更：${a.changes.join('；')}。原因：${b.reason.trim()}`);
      const row = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: inc('SalesOrder', CH) });
      return { ...result, order: ser('SalesOrder', row, CH) };
    });
  }

  /** 订单的变更记录（订单与订单行的审计追踪，含变更原因） */
  async history(id: number) {
    const c = this.db.client;
    const so = await c.salesOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!so) throw new NotFound('销售订单');
    const created = await c.auditLog.findMany({
      where: { entity: 'erp_sales_order_line', action: 'CREATE', changes: { contains: `"order_id":${id}` } },
      select: { entity_id: true, changes: true },
    });
    const lineIds = new Set(so.lines.map((l) => l.id));
    for (const r of created) {
      try {
        if (JSON.parse(r.changes || '{}').order_id === id && r.entity_id) lineIds.add(r.entity_id);
      } catch {
        /* 忽略无法解析的记录 */
      }
    }
    const rows = await c.auditLog.findMany({
      where: { OR: [{ entity: 'erp_sales_order', entity_id: id }, { entity: 'erp_sales_order_line', entity_id: { in: [...lineIds] } }] },
      orderBy: { id: 'asc' },
    });
    const lineNo = new Map<number, number>(so.lines.map((l) => [l.id, l.line_no]));
    return rows.map((r) => {
      let ch: Record<string, any> = {};
      try {
        ch = JSON.parse(r.changes || '{}');
      } catch {
        /* 原样返回 */
      }
      if (r.entity === 'erp_sales_order_line' && ch.line_no && !Array.isArray(ch.line_no)) lineNo.set(r.entity_id!, ch.line_no);
      return {
        id: r.id, ts: r.ts, username: r.username, full_name: r.full_name, action: r.action,
        target: r.entity === 'erp_sales_order' ? 'ORDER' : 'LINE', line_no: r.entity === 'erp_sales_order_line' ? (lineNo.get(r.entity_id!) ?? null) : null,
        changes: ch,
      };
    });
  }

  // ---------------- 生成工单（预览 + 按交期倒排） ----------------

  /** 生成工单预览：每行订单数量、已排产、库存/未关联工单抵扣、建议生成数量与倒排日期 */
  async workOrderPlan(id: number, tx: Tx = this.db.client) {
    const so = await tx.salesOrder.findUnique({ where: { id }, include: { lines: { include: { material: true }, orderBy: { line_no: 'asc' } } } });
    if (!so) throw new NotFound('销售订单');
    const cov = await coverageFor(tx, so.lines.map((l) => l.material_id));
    const lines = [];
    for (const l of so.lines) {
      const c = lineCoverage(cov, l.material_id, l.id);
      const m = l.material;
      const hasBom = !!(await releasedBom(tx, m.id));
      const delivery = l.delivery_date ?? so.delivery_date;
      const sch = backSchedule(delivery, m.lead_time_days);
      const uncovered = c?.uncovered ?? 0;
      const suggest = m.serial_control || isDiscreteUom(m.uom) ? Math.ceil(uncovered - EPS) : uncovered;
      const notes: string[] = [];
      if (!hasBom) notes.push('无已发布 BOM，不能生成工单（请工程部发布 BOM）');
      if (c?.free_sources.length) {
        notes.push(`已由${c.free_sources.map((s) => (s.type === 'STOCK' ? `成品库存 ${g(s.qty)}` : `未关联订单的工单 ${s.no} ${g(s.qty)}`)).join('、')}覆盖`);
      }
      if (suggest > EPS && sch.tight) notes.push(`交期紧张：按生产周期 ${m.lead_time_days} 天应在 ${fmtDate(addDays(delivery!, -(m.lead_time_days || 0)))} 开工`);
      lines.push({
        line_id: l.id, line_no: l.line_no, material_id: m.id, material_code: m.code, material_name: m.name, uom: m.uom,
        serial_control: m.serial_control, qty: l.qty, shipped_qty: l.shipped_qty || 0, wo_qty: c?.wo_qty ?? 0, wo_nos: c?.wo_nos ?? [],
        free_qty: c?.free_qty ?? 0, free_sources: c?.free_sources ?? [], uncovered, suggest_qty: hasBom ? suggest : 0,
        delivery_date: fmtDate(delivery), planned_start: fmtDate(sch.start), planned_end: fmtDate(sch.end), tight: sch.tight,
        lead_time_days: m.lead_time_days, has_bom: hasBom, notes,
      });
    }
    // 可关联到本订单的工单（同产品、未关联订单）
    const linkable = [];
    for (const [mid, mc] of cov) {
      for (const w of mc.free_wos) {
        const m = so.lines.find((l) => l.material_id === mid)?.material;
        linkable.push({ ...w, material_id: mid, material_code: m?.code ?? null });
      }
    }
    return { so_id: so.id, so_no: so.no, status: so.status, lines, linkable_work_orders: linkable };
  }

  /**
   * 生成生产工单：
   *   - link_wo_ids：把未关联订单的同产品工单关联到本订单（不新建）；
   *   - lines：按预览中确认/修改的数量与日期生成；未传则按“未覆盖数量”自动生成（按交期倒排开工）。
   */
  createWorkOrders(id: number, user: CurrentUser, b: SoWorkOrdersDto = {}) {
    return this.db.tx(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, include: { lines: { orderBy: { line_no: 'asc' }, include: { material: true } } } });
      if (!so) throw new NotFound('销售订单');
      if (!ACTIVE_SO.includes(so.status)) throw new BizError('订单未确认，不能生成工单');
      const created: string[] = [];
      const skipped: string[] = [];
      const linked: string[] = [];
      for (const woId of b.link_wo_ids ?? []) {
        const w = await tx.workOrder.findUnique({ where: { id: woId } });
        if (!w || w.status === 'CANCELLED') throw new BizError('要关联的工单不存在或已取消');
        if (w.so_line_id) throw new BizError(`工单 ${w.no} 已关联订单，不能重复关联`);
        const ln = so.lines.find((l) => l.material_id === w.material_id);
        if (!ln) throw new BizError(`工单 ${w.no} 的产品不在本订单中`);
        await tx.workOrder.update({ where: { id: w.id }, data: { so_id: so.id, so_line_id: ln.id, customer_id: w.customer_id ?? so.customer_id, source: w.source ?? so.no } });
        linked.push(w.no);
      }
      let plan: { so_line_id: number; qty: number; planned_start?: string | null; planned_end?: string | null }[];
      if (b.lines) {
        plan = b.lines;
      } else {
        const p = await this.workOrderPlan(id, tx);
        plan = p.lines.filter((l) => l.suggest_qty > EPS && l.has_bom).map((l) => ({ so_line_id: l.line_id, qty: l.suggest_qty, planned_start: l.planned_start, planned_end: l.planned_end }));
        for (const l of p.lines) if (!l.has_bom && l.uncovered > EPS) skipped.push(`${l.material_code}：无已发布 BOM`);
      }
      for (const item of plan) {
        if (!(item.qty > EPS)) continue;
        const ln = so.lines.find((l) => l.id === item.so_line_id);
        if (!ln) throw new BizError('订单行不存在，请刷新后重试');
        const m = ln.material;
        if (m.serial_control && Math.abs(item.qty - Math.round(item.qty)) > EPS) throw new BizError(`${m.code} 是序列号管理的产品，工单数量必须为整数`);
        if (!(await releasedBom(tx, m.id))) {
          skipped.push(`${m.code}：无已发布 BOM`);
          continue;
        }
        const sch = backSchedule(ln.delivery_date ?? so.delivery_date, m.lead_time_days);
        const start = dateOnly(item.planned_start) ?? sch.start;
        const end = dateOnly(item.planned_end) ?? (sch.end.getTime() < start.getTime() ? addDays(start, m.lead_time_days || 0) : sch.end);
        if (end.getTime() < start.getTime()) throw new BizError(`${m.code} 计划完工日期不能早于计划开工日期`);
        const wo = await tx.workOrder.create({
          data: {
            no: await this.numbering.nextNo(tx, 'WO'), material_id: ln.material_id, customer_id: so.customer_id, so_id: so.id, so_line_id: ln.id,
            planned_qty: item.qty, planned_start: start, planned_end: end, status: 'PLANNED', source: so.no, created_by: user.username,
          },
        });
        created.push(wo.no);
      }
      if ((created.length || linked.length) && so.status === 'CONFIRMED') await tx.salesOrder.update({ where: { id }, data: { status: 'IN_PRODUCTION' } });
      return { work_orders: created, skipped, linked };
    });
  }

  // ---------------- 录单辅助 ----------------

  /** 同一客户的客户PO号是否已被其他（未取消）订单使用 */
  async checkPo(q: Record<string, string>) {
    const cid = qInt(q.customer_id);
    const po = (q.customer_po || '').trim();
    if (!cid || !po) return [];
    const rows = await this.db.client.salesOrder.findMany({
      where: { customer_id: cid, customer_po: { equals: po, mode: 'insensitive' }, status: { not: 'CANCELLED' }, ...(qInt(q.exclude_id) ? { id: { not: qInt(q.exclude_id) } } : {}) },
      orderBy: { id: 'desc' },
      take: 10,
    });
    return rows.map((r) => ({ id: r.id, no: r.no, status: r.status, order_date: fmtDate(r.order_date), customer_po: r.customer_po }));
  }

  /** 该客户各产品的上次成交价（已确认及之后的订单） */
  async lastPrices(q: Record<string, string>) {
    const cid = qInt(q.customer_id);
    const ids = String(q.material_ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
    const out: Record<number, { unit_price: number; currency: string; so_id: number; so_no: string; order_date: string | null; qty: number }> = {};
    if (!cid || !ids.length) return out;
    const rows = await this.db.client.salesOrderLine.findMany({
      where: {
        material_id: { in: ids },
        order: { customer_id: cid, status: { notIn: ['DRAFT', 'CANCELLED'] }, ...(qInt(q.exclude_id) ? { id: { not: qInt(q.exclude_id) } } : {}) },
      },
      include: { order: true },
      orderBy: [{ order: { order_date: 'desc' } }, { id: 'desc' }],
    });
    for (const r of rows) {
      if (out[r.material_id]) continue;
      out[r.material_id] = { unit_price: num(r.unit_price), currency: r.order.currency, so_id: r.order_id, so_no: r.order.no, order_date: fmtDate(r.order.order_date), qty: r.qty };
    }
    return out;
  }
}
