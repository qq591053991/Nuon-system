/**
 * 销售订单排产覆盖（订单生成工单预览、MRP 生产建议转工单关联订单、齐套分析共用）。
 *
 * 每个订单行的“未覆盖数量”（= 还需要新排产的数量）按以下规则计算，保证订单生成工单与 MRP 互相知道对方：
 *   1) 本行已排产 = 关联本行的非取消工单（计划 − 报废）之和；已发货超过已排产时按已发货计；
 *      剩余 = 订单数量 − max(已排产, 已发货)。
 *   2) 可抵扣的“自由供给” = 成品库存（合格 + 待检/待放行，扣除关联工单已入库未发货的部分）
 *      + 未关联订单的在制工单未入库数量（如手工建的、旧版 MRP 转出的工单）；
 *      按交期先后（同交期按订单号、行号）分摊给同一产品的各订单行。
 *   3) 未覆盖数量 = 剩余 − 分摊到本行的自由供给。
 * 生成工单时默认按未覆盖数量生成，计划员可在预览中修改。
 */
import type { Tx } from '../common/prisma.service';
import { addDays, fmtDate, today } from '../common/dates';
import { EPS, round } from '../common/num';

export const ACTIVE_SO = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'];

/** 离散计量单位（数量按整数计，需求向上取整；与工单用料快照的取整规则一致） */
const DISCRETE_UOM = new Set(['PCS', 'PC', 'EA', 'SET', '个', '台', '只', '套', '片', '件', '张', '根', '块', '颗', '盒', '本']);
export const isDiscreteUom = (uom?: string | null) => DISCRETE_UOM.has((uom || '').trim().toUpperCase()) || DISCRETE_UOM.has((uom || '').trim());
/** 仍会产出的工单（未取消；已完工但未全部入库的也算） */
export const LIVE_WO = ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED'];
export const OPEN_WO = ['PLANNED', 'RELEASED', 'IN_PROGRESS'];

export interface FreeSource {
  type: 'STOCK' | 'WO';
  qty: number;
  id?: number;
  no?: string;
}

export interface LineCoverage {
  line_id: number;
  so_id: number;
  so_no: string;
  line_no: number;
  material_id: number;
  qty: number;
  shipped_qty: number;
  /** 关联本行的非取消工单数量（计划 − 报废） */
  wo_qty: number;
  wo_nos: string[];
  /** 本行剩余（未被本行工单/发货覆盖） */
  residual: number;
  /** 分摊到本行的自由供给 */
  free_qty: number;
  free_sources: FreeSource[];
  /** 未覆盖数量 = 建议新生成工单数量 */
  uncovered: number;
  delivery_date: string | null;
}

export interface MaterialCoverage {
  lines: LineCoverage[];
  /** 自由成品库存、未关联订单的工单（扣除分摊后余量） */
  free_stock: number;
  free_wos: { id: number; no: string; qty: number; status: string; planned_end: string | null }[];
}

const woOut = (w: { planned_qty: number; scrap_qty: number }) => Math.max(0, round(w.planned_qty - (w.scrap_qty || 0)));
const woFuture = (w: { planned_qty: number; scrap_qty: number; received_qty: number }) =>
  Math.max(0, round(w.planned_qty - (w.scrap_qty || 0) - (w.received_qty || 0)));

/** 一个产品在所有进行中订单上的覆盖情况（按交期分摊自由供给） */
export async function coverageForMaterial(tx: Tx, materialId: number): Promise<MaterialCoverage> {
  const soLines = await tx.salesOrderLine.findMany({
    where: { material_id: materialId, order: { status: { in: ACTIVE_SO } } },
    include: { order: true },
  });
  const wos = await tx.workOrder.findMany({ where: { material_id: materialId, status: { in: LIVE_WO } }, orderBy: { id: 'asc' } });
  const stockAgg = await tx.stock.aggregate({ where: { material_id: materialId, status: { in: ['AVAILABLE', 'QUARANTINE'] } }, _sum: { qty: true } });
  const lineIds = new Set(soLines.map((l) => l.id));

  let earmarked = 0;
  const lines: LineCoverage[] = soLines.map((l) => {
    const mine = wos.filter((w) => w.so_line_id === l.id);
    const woQty = round(mine.reduce((s, w) => s + woOut(w), 0));
    const received = round(mine.reduce((s, w) => s + (w.received_qty || 0), 0));
    earmarked += Math.max(0, received - (l.shipped_qty || 0));
    const residual = Math.max(0, round(l.qty - Math.max(woQty, l.shipped_qty || 0)));
    const d = l.delivery_date ?? l.order.delivery_date;
    return {
      line_id: l.id, so_id: l.order_id, so_no: l.order.no, line_no: l.line_no, material_id: l.material_id, qty: l.qty,
      shipped_qty: l.shipped_qty || 0, wo_qty: woQty, wo_nos: mine.map((w) => w.no), residual, free_qty: 0, free_sources: [],
      uncovered: residual, delivery_date: fmtDate(d),
    };
  });

  // 自由供给：库存（扣除关联工单已入库未发部分）+ 未关联订单（或关联的订单行已不在进行中）的工单未入库数量
  let stock = Math.max(0, round((stockAgg._sum.qty ?? 0) - earmarked));
  const freeWos = wos
    .filter((w) => !w.so_line_id || !lineIds.has(w.so_line_id))
    .map((w) => ({ id: w.id, no: w.no, qty: woFuture(w), status: w.status, planned_end: fmtDate(w.planned_end) }))
    .filter((w) => w.qty > EPS)
    .sort((a, b) => String(a.planned_end ?? '9999').localeCompare(String(b.planned_end ?? '9999')) || a.id - b.id);

  const order = [...lines].sort(
    (a, b) => String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999')) || a.so_id - b.so_id || a.line_no - b.line_no,
  );
  const woLeft = freeWos.map((w) => ({ ...w }));
  for (const ln of order) {
    let need = ln.residual;
    if (need <= EPS) continue;
    if (stock > EPS) {
      const take = round(Math.min(stock, need));
      stock = round(stock - take);
      need = round(need - take);
      ln.free_sources.push({ type: 'STOCK', qty: take });
    }
    for (const w of woLeft) {
      if (need <= EPS) break;
      if (w.qty <= EPS) continue;
      const take = round(Math.min(w.qty, need));
      w.qty = round(w.qty - take);
      need = round(need - take);
      ln.free_sources.push({ type: 'WO', id: w.id, no: w.no, qty: take });
    }
    ln.free_qty = round(ln.residual - need);
    ln.uncovered = need;
  }
  return { lines, free_stock: stock, free_wos: freeWos };
}

/** 多个产品的覆盖情况（按产品缓存） */
export async function coverageFor(tx: Tx, materialIds: number[]): Promise<Map<number, MaterialCoverage>> {
  const out = new Map<number, MaterialCoverage>();
  for (const mid of [...new Set(materialIds)]) out.set(mid, await coverageForMaterial(tx, mid));
  return out;
}

/** 某订单行的覆盖情况 */
export function lineCoverage(cov: Map<number, MaterialCoverage>, materialId: number, lineId: number): LineCoverage | undefined {
  return cov.get(materialId)?.lines.find((l) => l.line_id === lineId);
}

/**
 * 按交期倒排：计划完工 = 交期（无交期时 = 开工 + 生产周期），计划开工 = 交期 − 生产周期，不早于今天。
 * tight = 开工被压缩到今天（交期紧张）。
 */
export function backSchedule(delivery: Date | null | undefined, leadDays: number): { start: Date; end: Date; tight: boolean } {
  const t = today();
  const lead = Math.max(0, leadDays || 0);
  if (!delivery) return { start: t, end: addDays(t, lead), tight: false };
  const ideal = addDays(delivery, -lead);
  const tight = ideal.getTime() < t.getTime();
  const start = tight ? t : ideal;
  return { start, end: delivery.getTime() < start.getTime() ? start : delivery, tight };
}

export interface WoMismatch {
  so_id: number;
  so_no: string;
  line_id: number;
  line_no: number;
  material_code: string;
  /** 订单行数量 */
  so_qty: number;
  /** 关联本行的未取消工单（计划 − 报废）数量合计 */
  wo_qty: number;
  /** 关联本行的未取消工单（含已完工），adjustable_ids 为其中还能调整的（计划/已下达/生产中） */
  wo_ids: number[];
  adjustable_ids: number[];
  /** 订单变更时间（最近一次订单行数量变化），无则 null */
  changed_at: string | null;
}

/**
 * 订单与工单不符（订单变更后计划员待处理）：进行中订单的行，已有关联工单，但
 * 订单数量 ≠ 关联未取消工单（计划 − 报废）数量合计（订单加量 → 需补排；减量 → 需调减工单）。
 */
export async function woMismatches(db: Tx): Promise<WoMismatch[]> {
  const lines = await db.salesOrderLine.findMany({
    where: { order: { status: { in: ACTIVE_SO } }, work_orders: { some: { status: { not: 'CANCELLED' } } } },
    include: { order: true, material: true, work_orders: { where: { status: { not: 'CANCELLED' } }, orderBy: { id: 'asc' } } },
    orderBy: [{ order_id: 'asc' }, { line_no: 'asc' }],
  });
  const out: WoMismatch[] = [];
  for (const l of lines) {
    // 报废的不算产出：计划 − 报废（补做报废数量的工单不算“不符”）
    const woQty = round(l.work_orders.reduce((s, w) => s + w.planned_qty - (w.scrap_qty || 0), 0));
    if (Math.abs(woQty - l.qty) <= EPS) continue;
    out.push({
      so_id: l.order_id, so_no: l.order.no, line_id: l.id, line_no: l.line_no, material_code: l.material.code, so_qty: l.qty, wo_qty: woQty,
      wo_ids: l.work_orders.map((w) => w.id), adjustable_ids: l.work_orders.filter((w) => OPEN_WO.includes(w.status)).map((w) => w.id),
      changed_at: null,
    });
  }
  if (out.length) {
    const logs = await db.auditLog.findMany({
      where: { entity: 'erp_sales_order_line', entity_id: { in: out.map((m) => m.line_id) }, action: 'UPDATE', changes: { contains: '"qty"' } },
      orderBy: { id: 'desc' },
      select: { entity_id: true, ts: true },
    });
    for (const m of out) m.changed_at = logs.find((x) => x.entity_id === m.line_id)?.ts.toISOString() ?? null;
  }
  return out;
}
