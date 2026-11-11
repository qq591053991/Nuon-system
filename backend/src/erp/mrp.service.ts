/**
 * MRP 物料需求计划（按周分时段净算）：
 *   时段 = ISO 周（周一开始，按工厂时区的纯日期计算）；早于本周的需求/计划入库（逾期未到）一律计入本周。
 *   独立需求 = 已确认销售订单未发数量（按订单行交期）；
 *   在制工单：未完工数量 = 成品计划入库（按计划完工日）；未领料数量（计划工单按 BOM 展开）= 组件毛需求（按计划开工日）；
 *   采购在途 = 采购订单未收数量（按行/单头预计到货日，未填视为本周可到）；
 *   逐周净算：预计库存(期初) + 本周计划入库 − 本周毛需求 < 安全库存 → 净需求 = 差额；
 *     建议数量按离散单位取整、外购件最小订货量、采购单位整数倍放大，多出部分结转后续各周；
 *   需求日期 = 该周最早的需求日；建议日期 = 需求日期 − 提前期（自制件为生产周期、外购件为采购提前期），不早于今天（被压缩时备注“交期紧张”）；
 *   自制件的计划订单在“需求日期 − 生产周期”（即开工日）产生下层组件需求，按低阶码逐层展开。
 * 每个物料每周最多一条建议；自制件建议“生产”，外购件建议“采购”，客供料建议“通知客户供料”。
 * 需求日期与周次记在建议备注开头（“需求日期 YYYY-MM-DD（YYYY-Www）”），接口返回时解析为 required_date / week 字段。
 */
import { Injectable } from '@nestjs/common';
import type { Material, MrpSuggestion, Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { MoneySum } from '../common/money';
import { g as fmtNum, round } from '../common/num';
import { paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { NumberingService } from '../core/numbering.service';
import { baseCurrency } from './currency';
import { calcPoLine, hasPurchaseUnit, purchaseUnitsFor } from './po-line';

const EPS = 1e-9;
const DISCRETE_UOM_UPPER = ['PCS', 'EA', 'SET'];
const DISCRETE_UOM_CN = ['个', '台', '只', '套', '片', '件'];

type BomWithLines = Prisma.BomGetPayload<{ include: { lines: true } }>;

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

/** 纯日期（UTC 零点表示的工厂本地日期）所在 ISO 周的周一 */
export const weekStart = (d: Date): Date => addDays(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), -((d.getUTCDay() + 6) % 7));

/** ISO 周标签，如 2026-W46 */
export function isoWeekLabel(d: Date): string {
  const thu = addDays(weekStart(d), 3); // ISO 周所属年份 = 该周周四所在年份
  const year = thu.getUTCFullYear();
  const week = Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / 86400000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 建议备注开头的需求日期/周次 → 接口字段 required_date / week / note */
const REQ_RE = /^需求日期 (\d{4}-\d{2}-\d{2})（(\d{4}-W\d{2})）；?/;
function decorate<T extends Record<string, any>>(s: T): T & { required_date: string | null; week: string | null; note: string | null } {
  const m = REQ_RE.exec(s.remark ?? '');
  return { ...s, required_date: m?.[1] ?? null, week: m?.[2] ?? null, note: m ? s.remark.slice(m[0].length) || null : (s.remark ?? null) };
}
const serRun = (run: any) => {
  const d = ser('MrpRun', run, ['suggestions']);
  d.suggestions = (d.suggestions ?? []).map(decorate);
  return d;
};

/** 按周分桶的数量（需求桶同时记录该周最早的需求日） */
class Phased {
  readonly buckets = new Map<number, { qty: number; first: number }>();
  constructor(private readonly current: number) {}

  /** 日期 → 周桶（早于本周的计入本周） */
  key(d: Date): number {
    return Math.max(weekStart(d).getTime(), this.current);
  }

  add(qty: number, d: Date) {
    if (qty <= EPS) return;
    const k = this.key(d);
    const b = this.buckets.get(k);
    if (b) {
      b.qty += qty;
      b.first = Math.min(b.first, d.getTime());
    } else {
      this.buckets.set(k, { qty, first: d.getTime() });
    }
  }
}

@Injectable()
export class MrpService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 低阶码：每个物料在所有已发布 BOM 中出现的最深层级 */
  private async lowLevelCodes(tx: Tx): Promise<{ llc: Map<number, number>; boms: Map<number, BomWithLines> }> {
    const rows = await tx.bom.findMany({
      where: { status: 'RELEASED' },
      orderBy: { id: 'asc' },
      include: { lines: { orderBy: { line_no: 'asc' } } },
    });
    const boms = new Map<number, BomWithLines>();
    for (const b of rows) boms.set(b.material_id, b); // 同一物料多个已发布版本时取最新
    const llc = new Map<number, number>();
    const walk = (mid: number, level: number, path: number[]) => {
      if (path.includes(mid)) throw new BizError('BOM 存在循环引用');
      llc.set(mid, Math.max(llc.get(mid) ?? 0, level));
      const b = boms.get(mid);
      if (b) for (const ln of b.lines) walk(ln.component_id, level + 1, [...path, mid]);
    };
    for (const mid of [...boms.keys()]) walk(mid, 0, []);
    return { llc, boms };
  }

  /** 批量规则：离散单位取整 → 外购/客供最小订货量 → 采购单位整数倍 */
  private lotSize(m: Material, net: number, action: string): number {
    let qty = net;
    if (DISCRETE_UOM_UPPER.includes((m.uom || '').toUpperCase()) || DISCRETE_UOM_CN.includes(m.uom)) qty = Math.ceil(net - EPS);
    if (action !== 'PRODUCE' && m.min_order_qty && qty < m.min_order_qty) qty = m.min_order_qty;
    if (action === 'PURCHASE' && hasPurchaseUnit(m)) qty = round(purchaseUnitsFor(m, qty) * m.purchase_factor);
    return round(qty);
  }

  run(user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const t = today();
      const current = weekStart(t).getTime();
      const { llc, boms } = await this.lowLevelCodes(tx);
      const gross = new Map<number, Phased>(); // 毛需求（按周）
      const receipts = new Map<number, Phased>(); // 计划入库：采购在途 + 在制工单（按周）
      const phased = (map: Map<number, Phased>, mid: number) => {
        if (!map.has(mid)) map.set(mid, new Phased(current));
        return map.get(mid)!;
      };
      const addGross = (mid: number, qty: number, d: Date | null | undefined) => phased(gross, mid).add(qty, d ?? t);
      const addReceipt = (mid: number, qty: number, d: Date | null | undefined) => phased(receipts, mid).add(qty, d ?? t);

      // 1) 独立需求：销售订单（按行交期）
      const sos = await tx.salesOrder.findMany({
        where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'] } },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { line_no: 'asc' } } },
      });
      for (const so of sos) {
        for (const ln of so.lines) addGross(ln.material_id, round(ln.qty - (ln.shipped_qty || 0)), ln.delivery_date ?? so.delivery_date);
      }

      // 2) 在制工单：未完工数量 = 成品计划入库（计划完工日）；未领料数量 = 组件毛需求（计划开工日）
      const wos = await tx.workOrder.findMany({
        where: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS'] } },
        orderBy: { id: 'asc' },
        include: { materials: { orderBy: { id: 'asc' } } },
      });
      for (const wo of wos) {
        addReceipt(wo.material_id, Math.max(wo.planned_qty - (wo.completed_qty || 0) - (wo.scrap_qty || 0), 0), wo.planned_end ?? wo.planned_start);
        if (wo.status === 'PLANNED' || !wo.materials.length) {
          const b = boms.get(wo.material_id);
          if (b) for (const ln of b.lines) addGross(ln.component_id, wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), wo.planned_start);
        } else {
          for (const m of wo.materials) addGross(m.material_id, Math.max(m.required_qty - (m.issued_qty || 0), 0), wo.planned_start);
        }
      }

      // 3) 采购在途（按预计到货日）
      const pls = await tx.purchaseOrderLine.findMany({
        where: { order: { status: { in: ['DRAFT', 'APPROVED', 'PARTIAL_RECEIVED'] } } },
        orderBy: { id: 'asc' },
        include: { order: true },
      });
      for (const pl of pls) addReceipt(pl.material_id, Math.max(pl.qty - (pl.received_qty || 0), 0), pl.expected_date ?? pl.order.expected_date);

      // 库存（合格 + 待检/待放行）
      const stockRows = await tx.stock.groupBy({ by: ['material_id'], where: { status: { in: ['AVAILABLE', 'QUARANTINE'] } }, _sum: { qty: true } });
      const onHand = new Map(stockRows.map((r) => [r.material_id, round(r._sum.qty ?? 0)]));

      const allMids = new Set<number>([...gross.keys(), ...llc.keys()]);
      const mats = new Map<number, Material>(
        (await tx.material.findMany({ where: { id: { in: [...allMids] } } })).map((m) => [m.id, m]),
      );
      const material = async (id: number) => {
        if (!mats.has(id)) {
          const m = await tx.material.findUnique({ where: { id } });
          if (m) mats.set(id, m);
        }
        return mats.get(id);
      };

      const maxLevel = Math.max(0, ...llc.values());
      const suggestions: Prisma.MrpSuggestionUncheckedCreateWithoutRunInput[] = [];
      for (let level = 0; level <= maxLevel; level++) {
        const mids = [...allMids].filter((m) => (llc.get(m) ?? 0) === level).sort((a, b) => a - b);
        for (const mid of mids) {
          const m = await material(mid);
          if (!m) continue;
          const b = boms.get(mid);
          const action = b ? 'PRODUCE' : m.owner_customer_id ? 'CUSTOMER_SUPPLY' : 'PURCHASE';
          const ss = m.safety_stock || 0;
          const gb = gross.get(mid)?.buckets ?? new Map<number, { qty: number; first: number }>();
          const rb = receipts.get(mid)?.buckets ?? new Map<number, { qty: number; first: number }>();
          const weeks = [...new Set([current, ...gb.keys(), ...rb.keys()])].sort((x, y) => x - y);
          let projected = onHand.get(mid) ?? 0; // 预计库存（结转）
          for (const [wi, wk] of weeks.entries()) {
            const demand = round(gb.get(wk)?.qty ?? 0);
            const supply = round(rb.get(wk)?.qty ?? 0);
            const start = projected;
            const avail = round(start + supply - demand);
            if (avail >= ss - EPS) {
              projected = avail;
              continue;
            }
            const net = round(ss - avail);
            const qty = this.lotSize(m, net, action);
            projected = round(avail + qty);
            // 需求日期：本周最早需求日（逾期需求保留原日期）；仅因安全库存不足而补货时为今天
            const req = new Date(gb.get(wk)?.first ?? Math.max(wk, t.getTime()));
            const due = addDays(req, -(m.lead_time_days || 0));
            if (b) {
              // 自制件：计划订单在开工日（需求日期 − 生产周期）领用下层组件
              for (const ln of b.lines) {
                addGross(ln.component_id, qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), due);
                allMids.add(ln.component_id);
              }
            }
            const notes = [`需求日期 ${fmtDate(req)}（${isoWeekLabel(new Date(wk))}）`];
            if (due.getTime() < t.getTime()) notes.push('交期紧张：建议日期早于今天');
            const later = round(weeks.slice(wi + 1).reduce((s, w) => s + (rb.get(w)?.qty ?? 0), 0));
            if (later > EPS) notes.push(`其后各周另有在途/在制 ${fmtNum(later)}，可考虑催交提前`);
            suggestions.push({
              material_id: mid, level, action, gross_qty: demand, on_hand_qty: round(start), on_order_qty: supply, safety_stock: ss,
              net_qty: net, suggested_qty: qty, due_date: due.getTime() > t.getTime() ? due : t,
              supplier_id: action === 'PURCHASE' ? m.default_supplier_id : null,
              customer_id: action === 'CUSTOMER_SUPPLY' ? m.owner_customer_id : action === 'PRODUCE' ? m.customer_id : null,
              remark: notes.join('；').slice(0, 256),
            });
          }
        }
      }
      const cnt = (a: string) => suggestions.filter((s) => s.action === a).length;
      const run = await tx.mrpRun.create({
        data: {
          no: await this.numbering.nextNo(tx, 'MRP'), run_at: new Date(), run_by: user.full_name, created_by: user.username,
          summary: `生产建议 ${cnt('PRODUCE')} 条，采购建议 ${cnt('PURCHASE')} 条，客供料通知 ${cnt('CUSTOMER_SUPPLY')} 条`,
          suggestions: { create: suggestions },
        },
        include: inc('MrpRun', ['suggestions']),
      });
      return serRun(run);
    });
  }

  runs(q: Record<string, string>) {
    return paginate(this.db.client.mrpRun, 'MrpRun', { orderBy: { id: 'desc' } }, q);
  }

  async getRun(id: number) {
    const run = await this.db.client.mrpRun.findUnique({ where: { id }, include: inc('MrpRun', ['suggestions']) });
    if (!run) throw new NotFound('MRP 运算');
    return serRun(run);
  }

  /**
   * 建议一键转单：采购建议按供应商合并为采购订单草稿（每条建议一行，到货日 = 建议日期 + 采购提前期；
   * 物料有采购单位时按整数采购单位下单并记录采购单位/单价）；生产建议生成计划工单；客供料建议跳过（通知客户供料）
   */
  convert(ids: number[], user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const sugs = await tx.mrpSuggestion.findMany({ where: { id: { in: ids }, status: 'OPEN' }, orderBy: { id: 'asc' }, include: { material: true } });
      const createdPos: string[] = [];
      const createdWos: string[] = [];
      const skipped: string[] = [];
      const bySupplier = new Map<number, (MrpSuggestion & { material: Material })[]>();
      for (const s of sugs) {
        if (s.action === 'PURCHASE') {
          if (!s.supplier_id) {
            skipped.push(`${s.material.code}：未设置默认供应商`);
            continue;
          }
          if (!bySupplier.has(s.supplier_id)) bySupplier.set(s.supplier_id, []);
          bySupplier.get(s.supplier_id)!.push(s);
        } else if (s.action === 'PRODUCE') {
          const m = s.material;
          if (!(await releasedBom(tx, m.id))) {
            skipped.push(`${m.code}：无已发布 BOM`);
            continue;
          }
          const start = s.due_date ?? today();
          const wo = await tx.workOrder.create({
            data: {
              no: await this.numbering.nextNo(tx, 'WO'), material_id: m.id, customer_id: m.customer_id, planned_qty: s.suggested_qty,
              planned_start: start, planned_end: addDays(start, m.lead_time_days || 0), status: 'PLANNED', source: 'MRP', created_by: user.username,
            },
          });
          await tx.mrpSuggestion.update({ where: { id: s.id }, data: { status: 'CONVERTED', converted_doc_no: wo.no } });
          createdWos.push(wo.no);
        } else {
          skipped.push(`${s.material.code}：客供料，请通知客户供料`);
        }
      }
      for (const [supplierId, items] of bySupplier) {
        const total = new MoneySum();
        const lines = items.map((s, n) => {
          const m = s.material;
          const c = hasPurchaseUnit(m)
            ? calcPoLine(m, { purchase_qty: purchaseUnitsFor(m, s.suggested_qty), purchase_uom: m.purchase_uom, unit_price: m.std_cost }, n + 1)
            : calcPoLine(m, { qty: s.suggested_qty, unit_price: m.std_cost }, n + 1);
          total.add(c.amount);
          const expected = s.due_date ? addDays(s.due_date, m.lead_time_days || 0) : null;
          return { line_no: n + 1, material_id: s.material_id, ...c, expected_date: expected };
        });
        const dues = lines.map((l) => l.expected_date).filter((d): d is Date => !!d);
        const po = await tx.purchaseOrder.create({
          data: {
            no: await this.numbering.nextNo(tx, 'PO'), supplier_id: supplierId, order_date: today(), expected_date: dues.length ? dues.reduce(minDate) : null,
            status: 'DRAFT', source: 'MRP', created_by: user.username, currency: baseCurrency(), total_amount: total.value, lines: { create: lines },
          },
        });
        await tx.mrpSuggestion.updateMany({ where: { id: { in: items.map((s) => s.id) } }, data: { status: 'CONVERTED', converted_doc_no: po.no } });
        createdPos.push(po.no);
      }
      return { purchase_orders: createdPos, work_orders: createdWos, skipped };
    });
  }

  ignore(id: number) {
    return this.db.tx(async (tx) => {
      const s = await tx.mrpSuggestion.findUnique({ where: { id } });
      if (!s) throw new NotFound('建议');
      const row = await tx.mrpSuggestion.update({ where: { id }, data: { status: 'IGNORED' }, include: inc('MrpSuggestion') });
      return decorate(ser('MrpSuggestion', row));
    });
  }
}
