/**
 * 齐套分析（只读、无副作用，不生成领料单、不占用库存）：
 *   工单需求 = 已下达工单的用料快照（需求 − 已领），计划工单按当前生效 BOM 展开；
 *   可用库存 = 合格库存（不含不合格品区、已过期批次；客供料只算该客户货主的库存）；
 *   多张工单争用同一物料时，按“已开工 → 已下达 → 计划”、计划开工日、优先级的先后顺序分配，后面的工单只能用剩下的；
 *   缺口再用待检库存、在途采购单（按供应商回复交期/预计到货日）、半成品在制工单（按计划完工日）依次补足，
 *   补足缺口的那一笔的日期即“预计齐套日”（ETA）；补不足 = 无 ETA（需采购/通知客户供料）。
 * 销售订单：本订单关联的未完工工单 + 未排产部分（按 BOM 虚拟展开，排在所有已建工单之后）。
 */
import { Injectable } from '@nestjs/common';
import type { Material, Prisma } from '@prisma/client';
import { fmtDate, today } from '../common/dates';
import { NotFound } from '../common/errors';
import { EPS, round } from '../common/num';
import { like, paginate } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';
import { qInt } from './query';
import { coverageFor, isDiscreteUom, OPEN_WO, woMismatches } from './so-plan';

export interface OnOrder {
  type: 'PO' | 'WO' | 'IQC';
  po_id?: number;
  po_no?: string;
  line_id?: number;
  supplier_name?: string | null;
  wo_id?: number;
  wo_no?: string;
  open_qty: number;
  promised_date?: string | null;
  delivery_date?: string | null;
  date: string | null;
  status?: string;
}

export interface KitLine {
  material_id: number;
  material_code: string;
  material_name: string;
  material_spec: string | null;
  uom: string;
  category: string;
  customer_supplied: boolean;
  /** BOM 总需求 / 已领 */
  required_total: number;
  issued: number;
  /** 待领需求（= 总需求 − 已领） */
  required: number;
  /** 分配给本单的可用库存 */
  available: number;
  shortage: number;
  /** 合格库存总量；被排在前面的工单占用的数量 */
  stock_total: number;
  reserved_by_others: number;
  /** 待检（IQC 未完成）数量 */
  inspecting: number;
  on_order: OnOrder[];
  /** 预计齐套日（缺口被待检/在途/在制补足的日期）；无缺口为 null */
  eta: string | null;
  note: string | null;
}

export interface KitResult {
  lines: KitLine[];
  kitted: boolean;
  shortage_count: number;
  eta: string | null;
}

interface Demand {
  key: string;
  rank: [number, number, number, number];
  customer_id: number | null;
  comps: { material_id: number; required_total: number; issued: number; need: number }[];
}

const STATUS_RANK: Record<string, number> = { IN_PROGRESS: 0, RELEASED: 1, PLANNED: 2 };
const far = Date.UTC(9999, 0, 1);
const roundReq = (q: number, uom: string) => (isDiscreteUom(uom) ? Math.ceil(q - EPS) : round(q));
/** 多个预计日期取最晚；任一为空（补不足）则为空 */
const maxEta = (list: (string | null)[]): string | null => (list.some((x) => !x) ? null : ([...list].sort().pop() ?? null));

@Injectable()
export class KittingService {
  constructor(private readonly db: PrismaService) {}

  /** 所有未完工工单（+ 可选的虚拟需求）的齐套结果，key = 'WO:id' / 虚拟需求自定义 key */
  private async compute(c: Tx, virtual: Demand[] = []): Promise<Map<string, KitResult>> {
    const wos = await c.workOrder.findMany({
      where: { status: { in: OPEN_WO } },
      include: { materials: true },
      orderBy: { id: 'asc' },
    });
    const bomCache = new Map<string, Prisma.BomGetPayload<{ include: { lines: { include: { component: true } } } }> | null>();
    const bomOf = async (wo: { material_id: number; bom_id: number | null }) => {
      const k = wo.bom_id ? `id${wo.bom_id}` : `m${wo.material_id}`;
      if (!bomCache.has(k)) {
        bomCache.set(
          k,
          wo.bom_id
            ? await c.bom.findUnique({ where: { id: wo.bom_id }, include: { lines: { include: { component: true }, orderBy: { line_no: 'asc' } } } })
            : await c.bom.findFirst({
                where: { material_id: wo.material_id, status: 'RELEASED', OR: [{ effective_date: null }, { effective_date: { lte: today() } }] },
                orderBy: [{ effective_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
                include: { lines: { include: { component: true }, orderBy: { line_no: 'asc' } } },
              }),
        );
      }
      return bomCache.get(k);
    };
    const demands: Demand[] = [];
    for (const wo of wos) {
      let comps: Demand['comps'] = [];
      if (wo.status !== 'PLANNED' && wo.materials.length) {
        comps = wo.materials.map((m) => ({
          material_id: m.material_id, required_total: m.required_qty, issued: m.issued_qty || 0, need: Math.max(0, round(m.required_qty - (m.issued_qty || 0))),
        }));
      } else {
        const b = await bomOf(wo);
        if (b) {
          comps = b.lines.map((ln) => {
            const req = roundReq(wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), ln.component.uom);
            return { material_id: ln.component_id, required_total: req, issued: 0, need: req };
          });
        }
      }
      demands.push({
        key: `WO:${wo.id}`, customer_id: wo.customer_id,
        rank: [STATUS_RANK[wo.status] ?? 3, wo.planned_start?.getTime() ?? far, wo.priority ?? 3, wo.id],
        comps,
      });
    }
    demands.push(...virtual);
    demands.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.rank[3] - b.rank[3]);

    const mids = [...new Set(demands.flatMap((d) => d.comps.map((x) => x.material_id)))];
    const mats = new Map<number, Material>((await c.material.findMany({ where: { id: { in: mids } } })).map((m) => [m.id, m]));
    const t = today().getTime();
    const stocks = await c.stock.findMany({ where: { material_id: { in: mids }, status: { in: ['AVAILABLE', 'QUARANTINE'] }, qty: { gt: EPS } }, include: { location: true } });
    const ownerKey = (mid: number) => {
      const m = mats.get(mid);
      return m?.owner_customer_id ? `${mid}:C${m.owner_customer_id}` : `${mid}:OWN`;
    };
    const avail = new Map<string, number>();
    const totals = new Map<string, number>();
    const inspecting = new Map<string, number>();
    for (const s of stocks) {
      const m = mats.get(s.material_id);
      const mine = m?.owner_customer_id ? s.owner_customer_id === m.owner_customer_id : s.owner_customer_id === null;
      if (!mine) continue;
      const k = ownerKey(s.material_id);
      if (s.status === 'QUARANTINE') {
        inspecting.set(k, round((inspecting.get(k) ?? 0) + s.qty));
        continue;
      }
      if (s.location.location_type === 'REJECT') continue;
      if (s.expiry_date && s.expiry_date.getTime() < t) continue;
      avail.set(k, round((avail.get(k) ?? 0) + s.qty));
    }
    for (const [k, v] of avail) totals.set(k, v);

    // 在途：采购单未收数量、半成品在制工单未入库数量、待检
    const incoming = new Map<number, OnOrder[]>();
    const push = (mid: number, o: OnOrder) => {
      if (!incoming.has(mid)) incoming.set(mid, []);
      incoming.get(mid)!.push(o);
    };
    const pls = await c.purchaseOrderLine.findMany({
      where: { material_id: { in: mids }, order: { status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIAL_RECEIVED'] } } },
      include: { order: { include: { supplier: true } } },
      orderBy: { id: 'asc' },
    });
    for (const pl of pls) {
      const open = round(pl.qty - (pl.received_qty || 0));
      if (open <= EPS) continue;
      const exp = pl.expected_date ?? pl.order.expected_date;
      push(pl.material_id, {
        type: 'PO', po_id: pl.order_id, po_no: pl.order.no, line_id: pl.id, supplier_name: pl.order.supplier?.short_name || pl.order.supplier?.name || null,
        open_qty: open, promised_date: fmtDate(pl.promised_date), delivery_date: fmtDate(exp), date: fmtDate(pl.promised_date ?? exp), status: pl.order.status,
      });
    }
    const semiWos = await c.workOrder.findMany({ where: { material_id: { in: mids }, status: { in: OPEN_WO } }, orderBy: { id: 'asc' } });
    for (const w of semiWos) {
      const open = round(w.planned_qty - (w.scrap_qty || 0) - (w.received_qty || 0));
      if (open <= EPS) continue;
      push(w.material_id, { type: 'WO', wo_id: w.id, wo_no: w.no, open_qty: open, date: fmtDate(w.planned_end ?? w.planned_start), status: w.status });
    }
    const incomingLeft = new Map<number, (OnOrder & { left: number })[]>();
    for (const mid of mids) {
      const list: (OnOrder & { left: number })[] = [];
      const iq = inspecting.get(ownerKey(mid)) ?? 0;
      if (iq > EPS) list.push({ type: 'IQC', open_qty: iq, date: fmtDate(today()), left: iq });
      const unapproved = (x: { status?: string }) => x.status === 'DRAFT' || x.status === 'SUBMITTED';
      for (const o of incoming.get(mid) ?? []) list.push({ ...o, left: o.open_qty });
      list.sort((a, b) => (unapproved(a) ? 1 : 0) - (unapproved(b) ? 1 : 0) || String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')));
      incomingLeft.set(mid, list);
    }

    const out = new Map<string, KitResult>();
    for (const d of demands) {
      const lines: KitLine[] = [];
      for (const comp of d.comps) {
        const m = mats.get(comp.material_id);
        if (!m) continue;
        const k = ownerKey(m.id);
        const wrongOwner = !!m.owner_customer_id && d.customer_id !== null && m.owner_customer_id !== d.customer_id;
        const total = totals.get(k) ?? 0;
        const left = wrongOwner ? 0 : (avail.get(k) ?? 0);
        const take = round(Math.min(left, comp.need));
        if (!wrongOwner) avail.set(k, round(left - take));
        const shortage = round(comp.need - take);
        let eta: string | null = null;
        let note: string | null = null;
        if (shortage > EPS && !wrongOwner) {
          let rest = shortage;
          let drafted = false;
          for (const o of incomingLeft.get(m.id) ?? []) {
            if (rest <= EPS) break;
            if (o.left <= EPS) continue;
            const use = Math.min(o.left, rest);
            o.left = round(o.left - use);
            rest = round(rest - use);
            eta = o.date;
            if (o.status === 'DRAFT' || o.status === 'SUBMITTED') drafted = true;
            if (!o.date) eta = null;
          }
          if (rest > EPS) {
            eta = null;
            note = m.owner_customer_id ? '客供料：请通知客户补料' : m.category === 'SEMI' || m.category === 'FINISHED' ? '半成品：需安排生产' : '需采购（可运行 MRP）';
          } else if (drafted) {
            note = '依赖未审批的采购单';
          } else if (!eta) {
            note = '在途未填预计到货日';
          }
        } else if (wrongOwner) {
          note = '客供料货主与工单客户不一致，不能使用';
        }
        lines.push({
          material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec, uom: m.uom, category: m.category,
          customer_supplied: !!m.owner_customer_id, required_total: comp.required_total, issued: comp.issued, required: comp.need,
          available: take, shortage, stock_total: total, reserved_by_others: round(Math.max(0, Math.min(total, total - left))),
          inspecting: inspecting.get(k) ?? 0, on_order: (incoming.get(m.id) ?? []).map((o) => ({ ...o })), eta, note,
        });
      }
      const short = lines.filter((l) => l.shortage > EPS);
      out.set(d.key, {
        lines, kitted: short.length === 0, shortage_count: short.length,
        eta: short.length ? maxEta(short.map((l) => l.eta)) : null,
      });
    }
    return out;
  }

  private empty(): KitResult {
    return { lines: [], kitted: true, shortage_count: 0, eta: null };
  }

  /** 各物料的缺料工单（催货清单“影响工单”列）：{material_id → [{wo_id, wo_no, shortage, planned_start}]} */
  async shortWorkOrdersByMaterial(materialIds?: number[]) {
    const c = this.db.client;
    const all = await this.compute(c);
    const wos = new Map((await c.workOrder.findMany({ where: { status: { in: OPEN_WO } }, select: { id: true, no: true, planned_start: true } })).map((w) => [w.id, w]));
    const out = new Map<number, { wo_id: number; wo_no: string; shortage: number; planned_start: string | null }[]>();
    for (const [key, r] of all) {
      if (!key.startsWith('WO:')) continue;
      const w = wos.get(Number(key.slice(3)));
      if (!w) continue;
      for (const l of r.lines) {
        if (l.shortage <= EPS || (materialIds && !materialIds.includes(l.material_id))) continue;
        if (!out.has(l.material_id)) out.set(l.material_id, []);
        out.get(l.material_id)!.push({ wo_id: w.id, wo_no: w.no, shortage: l.shortage, planned_start: fmtDate(w.planned_start) });
      }
    }
    for (const list of out.values()) list.sort((a, b) => String(a.planned_start ?? '9999').localeCompare(String(b.planned_start ?? '9999')));
    return out;
  }

  /** 工单齐套 */
  async workOrder(id: number) {
    const c = this.db.client;
    const wo = await c.workOrder.findUnique({ where: { id }, include: { material: true } });
    if (!wo) throw new NotFound('生产工单');
    if (!OPEN_WO.includes(wo.status)) {
      return { ...this.empty(), wo_id: wo.id, wo_no: wo.no, status: wo.status, applicable: false, message: '工单已完工/关闭/取消，无需齐套检查' };
    }
    const r = (await this.compute(c)).get(`WO:${id}`) ?? this.empty();
    return { ...r, wo_id: wo.id, wo_no: wo.no, status: wo.status, applicable: true, message: null };
  }

  /** 批量：{[wo_id]: {kitted, shortage_count, eta}}（未完工工单才有） */
  async workOrders(ids: number[]) {
    const all = await this.compute(this.db.client);
    const out: Record<number, { kitted: boolean; shortage_count: number; eta: string | null }> = {};
    for (const id of ids) {
      const r = all.get(`WO:${id}`);
      if (r) out[id] = { kitted: r.kitted, shortage_count: r.shortage_count, eta: r.eta };
    }
    return out;
  }

  /** 工单列表（与 /work-orders 相同的筛选），附齐套列；kitting=SHORT 只看缺料、KITTED 只看齐套（仅未完工工单） */
  async workOrderList(q: Record<string, string>) {
    const c = this.db.client;
    const where: Prisma.WorkOrderWhereInput = {};
    if (q.q) where.OR = [{ no: like(q.q) }, { lot_no: like(q.q) }, { material: { code: like(q.q) } }, { material: { name: like(q.q) } }, { sales_order: { no: like(q.q) } }];
    if (q.status) where.status = { in: q.status.split(',') };
    const mid = qInt(q.material_id);
    if (mid) where.material_id = mid;
    const cid = qInt(q.customer_id);
    if (cid) where.customer_id = cid;
    const sid = qInt(q.so_id);
    if (sid) where.so_id = sid;
    if (q.dhr_status) where.dhr_status = q.dhr_status;
    const all = await this.compute(c);
    // 与订单不符（订单变更后待计划员处理）：?mismatch=1 只看这些工单
    const mism = await woMismatches(c);
    const mismOf = new Map<number, (typeof mism)[number]>();
    for (const m of mism) for (const id of m.wo_ids) mismOf.set(id, m);
    if (q.mismatch === '1' || q.mismatch === 'true') (where.AND = [...((where.AND as any[]) ?? []), { id: { in: [...mismOf.keys()] } }]);
    const kit = String(q.kitting || '').toUpperCase();
    if (kit === 'SHORT' || kit === 'KITTED') {
      const ids = [...all.entries()].filter(([, r]) => (kit === 'SHORT' ? !r.kitted : r.kitted)).map(([k]) => Number(k.slice(3)));
      where.AND = [...((where.AND as any[]) ?? []), { id: { in: ids } }];
    }
    const page = await paginate(c.workOrder, 'WorkOrder', { where, orderBy: { id: 'desc' } }, q);
    for (const w of page.items) {
      const mm = mismOf.get(w.id);
      w.mismatch = mm ? { so_id: mm.so_id, so_no: mm.so_no, line_no: mm.line_no, so_qty: mm.so_qty, wo_qty: mm.wo_qty, changed_at: mm.changed_at } : null;
      const r = all.get(`WO:${w.id}`);
      w.kitting = r
        ? {
            kitted: r.kitted, shortage_count: r.shortage_count, eta: r.eta,
            shortages: r.lines.filter((l) => l.shortage > EPS).slice(0, 5).map((l) => ({ material_code: l.material_code, material_name: l.material_name, shortage: l.shortage, uom: l.uom, eta: l.eta })),
          }
        : null;
    }
    return page;
  }

  /** 销售订单齐套：关联的未完工工单 + 未排产部分（按 BOM 虚拟展开） */
  async salesOrder(id: number) {
    const c = this.db.client;
    const so = await c.salesOrder.findUnique({ where: { id }, include: { lines: { include: { material: true }, orderBy: { line_no: 'asc' } } } });
    if (!so) throw new NotFound('销售订单');
    const closed = ['SHIPPED', 'CLOSED', 'CANCELLED'].includes(so.status);
    const virtual: Demand[] = [];
    const uncovered: { line_id: number; line_no: number; material_code: string; qty: number; has_bom: boolean }[] = [];
    if (!closed) {
      const cov = so.status === 'DRAFT' ? null : await coverageFor(c, so.lines.map((l) => l.material_id));
      for (const l of so.lines) {
        const qty = cov ? (cov.get(l.material_id)?.lines.find((x) => x.line_id === l.id)?.uncovered ?? 0) : Math.max(0, round(l.qty - (l.shipped_qty || 0)));
        if (qty <= EPS) continue;
        const b = await c.bom.findFirst({
          where: { material_id: l.material_id, status: 'RELEASED', OR: [{ effective_date: null }, { effective_date: { lte: today() } }] },
          orderBy: [{ effective_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          include: { lines: { include: { component: true } } },
        });
        uncovered.push({ line_id: l.id, line_no: l.line_no, material_code: l.material.code, qty, has_bom: !!b });
        if (!b) continue;
        const d = l.delivery_date ?? so.delivery_date;
        virtual.push({
          key: `SOL:${l.id}`, customer_id: so.customer_id, rank: [3, d?.getTime() ?? far, 3, l.id],
          comps: b.lines.map((ln) => {
            const req = roundReq(qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), ln.component.uom);
            return { material_id: ln.component_id, required_total: req, issued: 0, need: req };
          }),
        });
      }
    }
    const wos = closed ? [] : await c.workOrder.findMany({ where: { so_id: id, status: { in: OPEN_WO } }, orderBy: { id: 'asc' } });
    const all = wos.length || virtual.length ? await this.compute(c, virtual) : new Map<string, KitResult>();
    const parts = [...wos.map((w) => all.get(`WO:${w.id}`)), ...virtual.map((v) => all.get(v.key))].filter((x): x is KitResult => !!x);
    // 按物料汇总（预计齐套日取各部分中最晚的；任一部分无 ETA 则无 ETA）
    const agg = new Map<number, KitLine>();
    const etas = new Map<number, (string | null)[]>();
    for (const p of parts) {
      for (const l of p.lines) {
        if (l.shortage > EPS) etas.set(l.material_id, [...(etas.get(l.material_id) ?? []), l.eta]);
        const a = agg.get(l.material_id);
        if (!a) {
          agg.set(l.material_id, { ...l, on_order: [...l.on_order] });
          continue;
        }
        a.required_total = round(a.required_total + l.required_total);
        a.issued = round(a.issued + l.issued);
        a.required = round(a.required + l.required);
        a.available = round(a.available + l.available);
        a.shortage = round(a.shortage + l.shortage);
        a.reserved_by_others = Math.min(a.reserved_by_others, l.reserved_by_others);
        a.note = a.note ?? l.note;
      }
    }
    for (const [mid, list] of etas) agg.get(mid)!.eta = maxEta(list);
    const lines = [...agg.values()].sort((a, b) => b.shortage - a.shortage || a.material_code.localeCompare(b.material_code));
    const short = lines.filter((l) => l.shortage > EPS);
    return {
      so_id: so.id, so_no: so.no, status: so.status, applicable: !closed,
      lines, kitted: short.length === 0, shortage_count: short.length,
      eta: short.length ? maxEta(short.map((l) => l.eta)) : null,
      work_orders: wos.map((w) => {
        const r = all.get(`WO:${w.id}`);
        return { wo_id: w.id, wo_no: w.no, status: w.status, kitted: r?.kitted ?? true, shortage_count: r?.shortage_count ?? 0, eta: r?.eta ?? null };
      }),
      uncovered,
      message: closed ? '订单已发完/关闭/取消，无需齐套检查' : !parts.length ? '订单需求已由库存或已完工工单满足，无需领料' : null,
    };
  }
}
