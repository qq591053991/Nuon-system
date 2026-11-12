/**
 * MRP 物料需求计划（按周分时段净算）：
 *   时段 = ISO 周（周一开始，按工厂时区的纯日期计算）；早于本周的需求/计划入库（逾期未到）一律计入本周。
 *   独立需求 = 已确认销售订单未发数量（按订单行交期）；
 *   在制工单：未完工数量 = 成品计划入库（按计划完工日）；未领料数量（计划工单按 BOM 展开）= 组件毛需求（按计划开工日）；
 *   采购在途 = 采购订单未收数量（按供应商回复交期 / 行 / 单头预计到货日，未填视为本周可到）；
 *   逐周净算：预计库存(期初) + 本周计划入库 − 本周毛需求 < 安全库存 → 缺口；
 *     缺口先用“后续各周已有的在途/在制”抵补（提前催交例外 exception=EXPEDITE，不新建单据），仍不足才产生新建议；
 *     建议数量按离散单位取整、外购件最小订货量、采购单位整数倍放大，多出部分结转后续各周；
 *   需求日期 = 该周最早的需求日；建议日期 = 需求日期 − 提前期（自制件为生产周期、外购件为采购提前期），不早于今天（被压缩时备注“交期紧张”）；
 *   自制件的计划订单在“需求日期 − 生产周期”（即开工日）产生下层组件需求，按低阶码逐层展开。
 * 需求来源（demand_refs，JSON 数组）：role 缺省 = 需求来源（SO 订单行 / WO 工单用料 / PLAN 上层计划订单），
 *   role='expedite' = 建议提前的在途/在制单据，role='converted' = 转出的单据。
 * 生产建议转工单时按需求来源关联销售订单行（扣除已被工单/库存覆盖的数量，不重复生成）。
 * 转单前检查结果是否过期：运算之后订单、工单、采购、BOM、计划参数或库存有变化时提示重算。
 */
import { Injectable } from '@nestjs/common';
import type { Material, MrpSuggestion, Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { MoneySum } from '../common/money';
import { EPS, g as fmtNum, round } from '../common/num';
import { paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { NumberingService } from '../core/numbering.service';
import { baseCurrency } from './currency';
import { calcPoLine, hasPurchaseUnit, purchaseUnitsFor } from './po-line';
import { ACTIVE_SO, coverageForMaterial, isDiscreteUom } from './so-plan';

type BomWithLines = Prisma.BomGetPayload<{ include: { lines: true } }>;

/** 需求来源 / 催交对象 / 转出单据 */
export interface MrpRef {
  role?: 'expedite' | 'converted';
  type: 'SO' | 'WO' | 'PLAN' | 'PO';
  id?: number;
  no?: string;
  line_id?: number;
  line_no?: number;
  qty: number;
  date?: string | null;
  to_date?: string | null;
  customer?: string | null;
  parent?: string;
  parent_name?: string;
  so?: string[];
}

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

export const parseRefs = (s: string | null | undefined): MrpRef[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** 接口字段 required_date / week / note / demand / expedite / converted；兼容早期把需求日期/周次写在备注开头的数据 */
const REQ_RE = /^需求日期 (\d{4}-\d{2}-\d{2})（(\d{4}-W\d{2})）；?/;
function decorate<T extends Record<string, any>>(s: T) {
  const refs = parseRefs(s.demand_refs);
  const extra = {
    demand: refs.filter((r) => !r.role),
    expedite: refs.filter((r) => r.role === 'expedite'),
    converted: refs.filter((r) => r.role === 'converted'),
  };
  if (s.week) return { ...s, required_date: fmtDate(s.required_date) ?? s.required_date ?? null, week: s.week, note: s.remark ?? null, ...extra };
  const m = REQ_RE.exec(s.remark ?? '');
  return { ...s, required_date: m?.[1] ?? null, week: m?.[2] ?? null, note: m ? s.remark.slice(m[0].length) || null : (s.remark ?? null), ...extra };
}

/** 按周分桶的需求（记录该周最早的需求日与需求来源） */
class Phased {
  readonly buckets = new Map<number, { qty: number; first: number; refs: MrpRef[] }>();
  constructor(private readonly current: number) {}

  /** 日期 → 周桶（早于本周的计入本周） */
  key(d: Date): number {
    return Math.max(weekStart(d).getTime(), this.current);
  }

  add(qty: number, d: Date, ref?: MrpRef) {
    if (qty <= EPS) return;
    const k = this.key(d);
    const b = this.buckets.get(k);
    if (b) {
      b.qty += qty;
      b.first = Math.min(b.first, d.getTime());
      if (ref) b.refs.push(ref);
    } else {
      this.buckets.set(k, { qty, first: d.getTime(), refs: ref ? [ref] : [] });
    }
  }
}

/** 计划入库（采购在途 / 在制工单）：逐单记录，缺口可从后续周“提前” */
interface Receipt {
  wk: number;
  date: Date;
  remaining: number;
  ref: MrpRef;
}

/** 库存流水中不改变 MRP 净需求的类型（库存与在途/需求同时变化，相互抵消） */
const NEUTRAL_MOVES = new Set(['PO_RECEIPT', 'WO_ISSUE', 'WO_RETURN', 'FG_RECEIPT', 'SHIPMENT', 'TRANSFER', 'IQC_RELEASE', 'STATUS_CHANGE']);

@Injectable()
export class MrpService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 低阶码：每个物料在所有已发布 BOM 中出现的最深层级 */
  private async lowLevelCodes(tx: Tx): Promise<{ llc: Map<number, number>; boms: Map<number, BomWithLines> }> {
    const rows = await tx.bom.findMany({
      where: { status: 'RELEASED', OR: [{ effective_date: null }, { effective_date: { lte: today() } }] },
      orderBy: [{ effective_date: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      include: { lines: { orderBy: { line_no: 'asc' } } },
    });
    const boms = new Map<number, BomWithLines>();
    for (const b of rows) boms.set(b.material_id, b); // 同一物料多个已发布版本时取生效日期最晚、版本最新的
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
    if (isDiscreteUom(m.uom)) qty = Math.ceil(net - EPS);
    if (action !== 'PRODUCE' && m.min_order_qty && qty < m.min_order_qty) qty = m.min_order_qty;
    if (action === 'PURCHASE' && hasPurchaseUnit(m)) qty = round(purchaseUnitsFor(m, qty) * m.purchase_factor);
    return round(qty);
  }

  run(user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const t = today();
      const current = weekStart(t).getTime();
      const { llc, boms } = await this.lowLevelCodes(tx);
      const gross = new Map<number, Phased>(); // 毛需求（按周，含来源）
      const receipts = new Map<number, Receipt[]>(); // 计划入库（逐单）
      const mats = new Map<number, Material>();
      const material = async (id: number) => {
        if (!mats.has(id)) {
          const m = await tx.material.findUnique({ where: { id } });
          if (m) mats.set(id, m);
        }
        return mats.get(id);
      };
      const phased = (mid: number) => {
        if (!gross.has(mid)) gross.set(mid, new Phased(current));
        return gross.get(mid)!;
      };
      /** 组件毛需求：离散单位按每次展开向上取整（与工单用料快照一致，不出现 10,362.6 颗） */
      const addGross = async (mid: number, qty: number, d: Date | null | undefined, ref: MrpRef) => {
        const m = await material(mid);
        const q = isDiscreteUom(m?.uom) ? Math.ceil(qty - EPS) : round(qty);
        phased(mid).add(q, d ?? t, { ...ref, qty: q });
      };
      const addReceipt = (mid: number, qty: number, d: Date | null | undefined, ref: MrpRef) => {
        if (qty <= EPS) return;
        const date = d ?? t;
        if (!receipts.has(mid)) receipts.set(mid, []);
        receipts.get(mid)!.push({ wk: Math.max(weekStart(date).getTime(), current), date, remaining: round(qty), ref: { ...ref, qty: round(qty), date: fmtDate(date) } });
      };

      // 1) 独立需求：销售订单（按行交期）
      const sos = await tx.salesOrder.findMany({
        where: { status: { in: ACTIVE_SO } },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { line_no: 'asc' } }, customer: true },
      });
      for (const so of sos) {
        for (const ln of so.lines) {
          const d = ln.delivery_date ?? so.delivery_date;
          const qty = round(ln.qty - (ln.shipped_qty || 0));
          if (qty <= EPS) continue;
          phased(ln.material_id).add(qty, d ?? t, {
            type: 'SO', id: so.id, no: so.no, line_id: ln.id, line_no: ln.line_no, qty, date: fmtDate(d ?? t),
            customer: so.customer?.short_name || so.customer?.name || null,
          });
        }
      }

      // 2) 在制工单：未完工数量 = 成品计划入库（计划完工日）；未领料数量 = 组件毛需求（计划开工日）
      const wos = await tx.workOrder.findMany({
        where: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS'] } },
        orderBy: { id: 'asc' },
        include: { materials: { orderBy: { id: 'asc' } }, material: true },
      });
      for (const wo of wos) {
        const end = wo.planned_end ?? wo.planned_start;
        addReceipt(wo.material_id, Math.max(wo.planned_qty - (wo.completed_qty || 0) - (wo.scrap_qty || 0), 0), end, { type: 'WO', id: wo.id, no: wo.no, qty: 0 });
        const ref: MrpRef = { type: 'WO', id: wo.id, no: wo.no, qty: 0, date: fmtDate(wo.planned_start ?? t), parent: wo.material.code };
        if (wo.status === 'PLANNED' || !wo.materials.length) {
          const b = boms.get(wo.material_id);
          if (b) for (const ln of b.lines) await addGross(ln.component_id, wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), wo.planned_start, ref);
        } else {
          for (const m of wo.materials) await addGross(m.material_id, Math.max(m.required_qty - (m.issued_qty || 0), 0), wo.planned_start, ref);
        }
      }

      // 3) 采购在途（按供应商回复交期 / 预计到货日）
      const pls = await tx.purchaseOrderLine.findMany({
        where: { order: { status: { in: ['DRAFT', 'APPROVED', 'PARTIAL_RECEIVED'] } } },
        orderBy: { id: 'asc' },
        include: { order: true },
      });
      for (const pl of pls) {
        addReceipt(pl.material_id, Math.max(pl.qty - (pl.received_qty || 0), 0), pl.promised_date ?? pl.expected_date ?? pl.order.expected_date, {
          type: 'PO', id: pl.order_id, no: pl.order.no, line_id: pl.id, line_no: pl.line_no, qty: 0,
        });
      }

      // 库存（合格 + 待检/待放行）
      const stockRows = await tx.stock.groupBy({ by: ['material_id'], where: { status: { in: ['AVAILABLE', 'QUARANTINE'] } }, _sum: { qty: true } });
      const onHand = new Map(stockRows.map((r) => [r.material_id, round(r._sum.qty ?? 0)]));

      const allMids = new Set<number>([...gross.keys(), ...llc.keys()]);
      for (const m of await tx.material.findMany({ where: { id: { in: [...allMids] } } })) mats.set(m.id, m);

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
          const gb = gross.get(mid)?.buckets ?? new Map<number, { qty: number; first: number; refs: MrpRef[] }>();
          const recs = (receipts.get(mid) ?? []).sort((x, y) => x.date.getTime() - y.date.getTime());
          const weeks = [...new Set([current, ...gb.keys(), ...recs.map((r) => r.wk)])].sort((x, y) => x - y);
          const partner = {
            supplier_id: action === 'PURCHASE' ? m.default_supplier_id : null,
            customer_id: action === 'CUSTOMER_SUPPLY' ? m.owner_customer_id : action === 'PRODUCE' ? m.customer_id : null,
          };
          let projected = onHand.get(mid) ?? 0; // 预计库存（结转）
          for (const wk of weeks) {
            const bucket = gb.get(wk);
            const demand = round(bucket?.qty ?? 0);
            const supply = round(recs.filter((r) => r.wk === wk).reduce((s, r) => s + r.remaining, 0));
            const start = projected;
            let avail = round(start + supply - demand);
            if (avail >= ss - EPS) {
              projected = avail;
              continue;
            }
            // 需求日期：本周最早需求日（逾期需求保留原日期）；仅因安全库存不足而补货时为今天
            const req = new Date(bucket?.first ?? Math.max(wk, t.getTime()));
            const demandRefs = (bucket?.refs ?? []).slice(0, 200);
            const base = { material_id: mid, level, gross_qty: demand, on_hand_qty: round(start), on_order_qty: supply, safety_stock: ss, required_date: req, week: isoWeekLabel(new Date(wk)), ...partner };

            // 先把后续各周已有的在途/在制提前（催交），不新建单据
            let short = round(ss - avail);
            const pulls: MrpRef[] = [];
            for (const r of recs) {
              if (short <= EPS) break;
              if (r.wk <= wk || r.remaining <= EPS) continue;
              const take = round(Math.min(r.remaining, short));
              r.remaining = round(r.remaining - take);
              short = round(short - take);
              avail = round(avail + take);
              pulls.push({ ...r.ref, role: 'expedite', qty: take, to_date: fmtDate(req) });
            }
            if (pulls.length) {
              const qty = round(pulls.reduce((s, p) => s + p.qty, 0));
              const what = pulls
                .map((p) => (p.type === 'PO' ? `采购单 ${p.no} 的 ${fmtNum(p.qty)}（原定 ${p.date ?? '-'} 到货）` : `工单 ${p.no} 的 ${fmtNum(p.qty)}（原定 ${p.date ?? '-'} 完工）`))
                .join('、');
              suggestions.push({
                ...base, action: pulls.every((p) => p.type === 'PO') ? 'PURCHASE' : pulls.every((p) => p.type === 'WO') ? 'PRODUCE' : action,
                net_qty: qty, suggested_qty: qty, due_date: req.getTime() > t.getTime() ? req : t, exception: 'EXPEDITE',
                demand_refs: JSON.stringify([...demandRefs, ...pulls]),
                remark: `提前催交：已有在途/在制可满足，无需新下单。请将${what}提前到 ${fmtDate(req)}`.slice(0, 256),
              });
            }
            if (short <= EPS && avail >= ss - EPS) {
              projected = avail;
              continue;
            }
            const net = round(ss - avail);
            const qty = this.lotSize(m, net, action);
            projected = round(avail + qty);
            const due = addDays(req, -(m.lead_time_days || 0));
            if (b) {
              // 自制件：计划订单在开工日（需求日期 − 生产周期）领用下层组件
              const soNos = [...new Set(demandRefs.flatMap((r) => (r.type === 'SO' ? [r.no!] : r.so ?? [])))].slice(0, 20);
              for (const ln of b.lines) {
                await addGross(ln.component_id, qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), due, {
                  type: 'PLAN', qty: 0, date: fmtDate(due), parent: m.code, parent_name: m.name, so: soNos,
                });
                allMids.add(ln.component_id);
              }
            }
            const notes: string[] = [];
            if (due.getTime() < t.getTime()) notes.push('交期紧张：建议日期早于今天');
            if (!demandRefs.length) notes.push('补足安全库存');
            suggestions.push({
              ...base, action, net_qty: net, suggested_qty: qty, due_date: due.getTime() > t.getTime() ? due : t,
              demand_refs: demandRefs.length ? JSON.stringify(demandRefs) : null, remark: notes.join('；').slice(0, 256) || null,
            });
          }
        }
      }
      const cnt = (a: string) => suggestions.filter((s) => s.action === a && !s.exception).length;
      const exp = suggestions.filter((s) => s.exception === 'EXPEDITE').length;
      const run = await tx.mrpRun.create({
        data: {
          no: await this.numbering.nextNo(tx, 'MRP'), run_at: new Date(), run_by: user.full_name, created_by: user.username,
          summary: `生产建议 ${cnt('PRODUCE')} 条，采购建议 ${cnt('PURCHASE')} 条，客供料通知 ${cnt('CUSTOMER_SUPPLY')} 条${exp ? `，提前催交 ${exp} 条` : ''}`,
          suggestions: { create: suggestions },
        },
        include: inc('MrpRun', ['suggestions']),
      });
      return this.serRun(tx, run);
    });
  }

  /** 运算结果：建议 + 需求来源 + 转出单据的当前状态（单号可直接点开；单据取消后提示） */
  private async serRun(c: Tx, run: any) {
    const d = ser('MrpRun', run, ['suggestions']);
    const sugs = (d.suggestions ?? []).map(decorate);
    const nos = new Set<string>();
    for (const s of sugs) {
      if (s.converted_doc_no) nos.add(s.converted_doc_no);
      for (const r of [...s.converted, ...s.expedite]) if (r.no) nos.add(r.no);
    }
    const docs = new Map<string, { kind: string; id: number; status: string }>();
    if (nos.size) {
      for (const p of await c.purchaseOrder.findMany({ where: { no: { in: [...nos] } }, select: { id: true, no: true, status: true } })) docs.set(p.no, { kind: 'PO', id: p.id, status: p.status });
      for (const w of await c.workOrder.findMany({ where: { no: { in: [...nos] } }, select: { id: true, no: true, status: true } })) docs.set(w.no, { kind: 'WO', id: w.id, status: w.status });
    }
    const docOf = (no?: string | null) => (no ? docs.get(no) : undefined);
    d.suggestions = sugs.map((s: any) => {
      const doc = docOf(s.converted_doc_no);
      return {
        ...s,
        converted_doc_id: doc?.id ?? null, converted_doc_kind: doc?.kind ?? null, converted_doc_status: doc?.status ?? null,
        converted: s.converted.map((r: MrpRef) => ({ ...r, id: docOf(r.no)?.id ?? r.id, status: docOf(r.no)?.status ?? null })),
        expedite: s.expedite.map((r: MrpRef) => ({ ...r, status: docOf(r.no)?.status ?? null })),
      };
    });
    return d;
  }

  runs(q: Record<string, string>) {
    return paginate(this.db.client.mrpRun, 'MrpRun', { orderBy: { id: 'desc' } }, q);
  }

  async getRun(id: number) {
    const run = await this.db.client.mrpRun.findUnique({ where: { id }, include: inc('MrpRun', ['suggestions']) });
    if (!run) throw new NotFound('MRP 运算');
    return this.serRun(this.db.client, run);
  }

  /**
   * 结果是否过期：运算之后有新的确认/变更/取消订单、新建或改量改期的工单与采购单、BOM 发布、物料计划参数变化、
   * 非抵消性的库存变动（盘点调整、报废、判退、客供料收货等）。本次运算自己转出的单据不算。
   */
  async staleness(id: number) {
    const c = this.db.client;
    const run = await c.mrpRun.findUnique({ where: { id }, include: { suggestions: true } });
    if (!run) throw new NotFound('MRP 运算');
    const latest = await c.mrpRun.findFirst({ orderBy: { id: 'desc' } });
    const reasons: string[] = [];
    if (latest && latest.id !== run.id) reasons.push(`已有更新的运算 ${latest.no}，当前查看的是旧结果`);
    const own = new Set<string>();
    for (const s of run.suggestions) {
      if (s.converted_doc_no) own.add(s.converted_doc_no);
      for (const r of parseRefs(s.demand_refs)) if (r.role === 'converted' && r.no) own.add(r.no);
    }
    const ownPoIds = new Set((await c.purchaseOrder.findMany({ where: { no: { in: [...own] } }, select: { id: true } })).map((p) => p.id));
    const logs = await c.auditLog.findMany({
      where: {
        ts: { gt: run.run_at },
        entity: { in: ['erp_sales_order', 'erp_sales_order_line', 'mes_work_order', 'erp_purchase_order', 'erp_purchase_order_line', 'eng_bom', 'md_material'] },
      },
      orderBy: { id: 'asc' },
      take: 20000,
    });
    const so = new Set<number>(); // 表头确认/撤销/取消/关闭/改交期
    const soByLine = new Set<number>(); // 行变化所在订单（只算进行中的订单）
    const soLines = new Set<number>();
    const wo = new Set<string>();
    const po = new Set<number>();
    let bom = 0;
    const matParams = new Set<number>();
    const has = (ch: Record<string, any>, ...ks: string[]) => ks.some((k) => k in ch);
    for (const l of logs) {
      let ch: Record<string, any> = {};
      try {
        ch = JSON.parse(l.changes || '{}');
      } catch {
        continue;
      }
      const after = (k: string) => (Array.isArray(ch[k]) ? ch[k][1] : ch[k]);
      switch (l.entity) {
        case 'erp_sales_order':
          if (l.action === 'UPDATE' && (has(ch, 'delivery_date') || (has(ch, 'status') && ['CONFIRMED', 'CANCELLED', 'CLOSED', 'DRAFT'].includes(after('status'))))) so.add(l.entity_id!);
          break;
        case 'erp_sales_order_line':
          if (l.action !== 'UPDATE' || has(ch, 'qty', 'delivery_date', 'material_id')) {
            if (l.action === 'UPDATE') soLines.add(l.entity_id!);
            else if (ch.order_id) soByLine.add(Number(ch.order_id));
          }
          break;
        case 'mes_work_order': {
          if (l.action === 'CREATE' && !own.has(String(ch.no))) wo.add(String(ch.no));
          if (l.action === 'UPDATE' && (has(ch, 'planned_qty', 'planned_start', 'planned_end') || (has(ch, 'status') && after('status') === 'CANCELLED'))) wo.add(`#${l.entity_id}`);
          break;
        }
        case 'erp_purchase_order':
          if (l.action === 'CREATE' && !own.has(String(ch.no))) po.add(l.entity_id!);
          if (l.action === 'UPDATE' && (has(ch, 'expected_date') || (has(ch, 'status') && ['CANCELLED', 'CLOSED'].includes(after('status'))))) po.add(l.entity_id!);
          break;
        case 'erp_purchase_order_line':
          if (l.action === 'UPDATE' && has(ch, 'qty', 'expected_date', 'promised_date')) po.add(-l.entity_id!);
          else if (l.action !== 'UPDATE' && ch.order_id && !ownPoIds.has(Number(ch.order_id)) && !po.has(Number(ch.order_id))) po.add(Number(ch.order_id));
          break;
        case 'eng_bom':
          if (l.action === 'UPDATE' && has(ch, 'status') && ['RELEASED', 'OBSOLETE'].includes(after('status'))) bom++;
          break;
        case 'md_material':
          if (l.action === 'UPDATE' && has(ch, 'safety_stock', 'lead_time_days', 'min_order_qty', 'purchase_factor', 'default_supplier_id')) matParams.add(l.entity_id!);
          break;
      }
    }
    if (soLines.size) {
      for (const ln of await c.salesOrderLine.findMany({ where: { id: { in: [...soLines] } }, select: { order_id: true } })) soByLine.add(ln.order_id);
    }
    if (so.size || soByLine.size) {
      const rows = await c.salesOrder.findMany({ where: { id: { in: [...so, ...soByLine] } }, select: { id: true, no: true, status: true }, orderBy: { id: 'asc' } });
      const relevant = rows.filter((r) => so.has(r.id) || ACTIVE_SO.includes(r.status));
      if (relevant.length) reasons.push(`销售订单有确认/变更/取消：${relevant.map((r) => r.no).slice(0, 5).join('、')}${relevant.length > 5 ? ` 等 ${relevant.length} 张` : ''}`);
    }
    if (wo.size) {
      const ids = [...wo].filter((x) => x.startsWith('#')).map((x) => Number(x.slice(1)));
      const nos = [...wo].filter((x) => !x.startsWith('#'));
      if (ids.length) for (const w of await c.workOrder.findMany({ where: { id: { in: ids } }, select: { no: true } })) nos.push(w.no);
      const uniq = [...new Set(nos)];
      reasons.push(`生产工单有新建/改量改期/取消：${uniq.slice(0, 5).join('、')}${uniq.length > 5 ? ` 等 ${uniq.length} 张` : ''}`);
    }
    if (po.size) {
      const lineIds = [...po].filter((x) => x < 0).map((x) => -x);
      const ids = new Set([...po].filter((x) => x > 0));
      if (lineIds.length) for (const l of await c.purchaseOrderLine.findMany({ where: { id: { in: lineIds } }, select: { order_id: true } })) ids.add(l.order_id);
      const rows = await c.purchaseOrder.findMany({ where: { id: { in: [...ids] } }, select: { no: true } });
      if (rows.length) reasons.push(`采购订单有新建/改量改期/取消：${rows.map((r) => r.no).slice(0, 5).join('、')}${rows.length > 5 ? ` 等 ${rows.length} 张` : ''}`);
    }
    if (bom) reasons.push(`BOM 有 ${bom} 次发布/作废`);
    if (matParams.size) reasons.push(`${matParams.size} 个物料的计划参数（安全库存/提前期/最小订货量/默认供应商）有修改`);
    const moves = await c.stockMove.findMany({ where: { ts: { gt: run.run_at }, move_type: { notIn: [...NEUTRAL_MOVES] } }, select: { material_id: true } });
    if (moves.length) reasons.push(`库存有 ${moves.length} 笔调整/报废/判退/客供料收货等变动（涉及 ${new Set(moves.map((m) => m.material_id)).size} 个物料）`);
    return { stale: reasons.length > 0, run_id: run.id, run_no: run.no, latest_run_id: latest?.id ?? null, reasons };
  }

  /**
   * 建议一键转单：采购建议按供应商合并为采购订单草稿（每条建议一行，到货日 = 建议日期 + 采购提前期；
   * 物料有采购单位时按整数采购单位下单并记录采购单位/单价）；生产建议生成计划工单（按需求来源关联销售订单行，
   * 已被工单/库存覆盖的不重复生成）；客供料建议、提前催交例外跳过。结果过期时需 force 才能转单。
   */
  async convert(ids: number[], user: CurrentUser, force = false) {
    const runIds = [...new Set((await this.db.client.mrpSuggestion.findMany({ where: { id: { in: ids } }, select: { run_id: true } })).map((s) => s.run_id))];
    if (!force) {
      for (const rid of runIds) {
        const st = await this.staleness(rid);
        if (st.stale) throw new BizError(`MRP 结果已过期：${st.reasons.join('；')}。请重新运行 MRP 后再转单（确认无影响可选择“仍然转单”）`);
      }
    }
    return this.db.tx(async (tx) => {
      const sugs = await tx.mrpSuggestion.findMany({ where: { id: { in: ids }, status: 'OPEN' }, orderBy: { id: 'asc' }, include: { material: true, run: true } });
      const createdPos: string[] = [];
      const createdWos: string[] = [];
      const skipped: string[] = [];
      const bySupplier = new Map<number, (MrpSuggestion & { material: Material })[]>();
      for (const s of sugs) {
        if (s.exception === 'EXPEDITE') {
          skipped.push(`${s.material.code}：提前催交例外，无需新建单据（请联系供应商/车间提前交货）`);
          continue;
        }
        if (s.action === 'PURCHASE') {
          if (!s.supplier_id) {
            skipped.push(`${s.material.code}：未设置默认供应商`);
            continue;
          }
          if (!bySupplier.has(s.supplier_id)) bySupplier.set(s.supplier_id, []);
          bySupplier.get(s.supplier_id)!.push(s);
        } else if (s.action === 'PRODUCE') {
          const r = await this.convertProduce(tx, s, user);
          createdWos.push(...r.created);
          skipped.push(...r.skipped);
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

  /** 生产建议转工单：按需求来源的订单行（按交期）拆分并关联订单；安全库存/批量多出部分另建不关联订单的工单 */
  private async convertProduce(tx: Tx, s: MrpSuggestion & { material: Material }, user: CurrentUser) {
    const m = s.material;
    const created: string[] = [];
    const skipped: string[] = [];
    if (!(await releasedBom(tx, m.id))) return { created, skipped: [`${m.code}：无已发布 BOM`] };
    const start = s.due_date ?? today();
    const end = addDays(start, m.lead_time_days || 0);
    const refs = parseRefs(s.demand_refs);
    const soRefs = refs.filter((r) => !r.role && r.type === 'SO' && r.line_id).sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    const converted: MrpRef[] = [];
    const make = async (qty: number, link?: { so_id: number; line_id: number; so_no: string; customer_id: number }) => {
      const wo = await tx.workOrder.create({
        data: {
          no: await this.numbering.nextNo(tx, 'WO'), material_id: m.id, customer_id: link?.customer_id ?? m.customer_id, planned_qty: qty,
          so_id: link?.so_id ?? null, so_line_id: link?.line_id ?? null,
          planned_start: start, planned_end: end, status: 'PLANNED', source: link ? `MRP·${link.so_no}` : 'MRP', created_by: user.username,
        },
      });
      created.push(wo.no);
      converted.push({ role: 'converted', type: 'WO', id: wo.id, no: wo.no, qty, ...(link ? { so: [link.so_no] } : {}) });
    };
    let remain = s.suggested_qty;
    if (soRefs.length) {
      const cov = await coverageForMaterial(tx, m.id);
      const soIds = new Set<number>();
      for (const r of soRefs) {
        if (remain <= EPS) break;
        const lc = cov.lines.find((l) => l.line_id === r.line_id);
        if (!lc || lc.uncovered <= EPS) continue;
        const take = round(Math.min(remain, lc.uncovered));
        const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: lc.so_id } });
        await make(take, { so_id: so.id, line_id: lc.line_id, so_no: so.no, customer_id: so.customer_id });
        lc.uncovered = round(lc.uncovered - take);
        remain = round(remain - take);
        soIds.add(so.id);
      }
      if (soIds.size) await tx.salesOrder.updateMany({ where: { id: { in: [...soIds] }, status: 'CONFIRMED' }, data: { status: 'IN_PRODUCTION' } });
    }
    if (remain > EPS) {
      // 只允许安全库存补货与批量取整的部分不挂订单；其余说明订单需求已被其他工单覆盖（结果过期），不重复生成
      const allowed = soRefs.length ? Math.max(0, round(s.suggested_qty - Math.max(0, s.net_qty - (s.safety_stock || 0)))) : remain;
      const extra = round(Math.min(remain, allowed));
      if (extra > EPS) await make(extra);
      const dup = round(remain - extra);
      if (dup > EPS) {
        const nos = [...new Set(soRefs.map((r) => r.no))].join('、');
        skipped.push(`${m.code}：订单 ${nos} 的 ${fmtNum(dup)} 已有工单/库存覆盖，未重复生成`);
      }
    }
    if (created.length) {
      await tx.mrpSuggestion.update({
        where: { id: s.id },
        data: { status: 'CONVERTED', converted_doc_no: created[0], demand_refs: JSON.stringify([...refs, ...converted]) },
      });
    } else if (soRefs.length) {
      await tx.mrpSuggestion.update({ where: { id: s.id }, data: { status: 'IGNORED', remark: `${s.remark ? `${s.remark}；` : ''}订单需求已由其他工单/库存覆盖`.slice(0, 256) } });
    }
    return { created, skipped };
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
