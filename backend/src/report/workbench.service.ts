/**
 * 岗位工作台（G1）：每个岗位登录后看到“自己的”首页。
 *  - profileOf：按角色定主岗位（厂长 / QA / 质检 / 计划 / 采购 / 销售 / 财务 / 仓管 / 工程 / 操作员 / 管理员）；
 *  - kpis：按岗位给出 KPI 卡（每张卡带下钻 path，path 是带筛选参数的列表页 URL）；
 *  - todos：按岗位给出待办（不再按权限点全部堆给厂长）；
 *  - 岗位专属区块：厂长“待我拍板”、财务应收应付、管理员账号安全、操作员今日报工与上岗资质；
 *  - deliveryRisk：交付风险（交期、进度、缺料估算、阻塞原因，红黄绿），厂长/计划/销售共用；
 *  - outputDetail / fpyDetail：产出与一次直通率下钻。
 * 金额类数据只给有权限的人（财务 finance / 采购 purchase / 销售 sales，厂长已含）。
 */
import { Injectable } from '@nestjs/common';
import { demoPasswordUsers } from '../auth/demo';
import { passwordExpiresAt } from '../auth/password';
import { READ_PERMS, roleList, userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, daysBetween, fmtDate, localDateStr, today } from '../common/dates';
import { num, round, round2 } from '../common/num';
import { PrismaService, type Tx } from '../common/prisma.service';
import { RateBook } from '../erp/currency';
import { KittingService } from '../erp/kitting.service';
import { localStart, pendingReleaseCount } from './report.service';

export type Level = 'error' | 'warning' | 'success';
export interface Kpi { key: string; title: string; value: number | string | null; suffix?: string; hint?: string; level?: Level; path?: string }
export interface TodoItem { key: string; title: string; count: number; path: string; level?: Level }

/** 主岗位优先级（多角色用户取最靠前的） */
const PROFILE_ORDER = ['manager', 'qa', 'qc', 'planner', 'purchaser', 'sales', 'finance', 'warehouse', 'engineer', 'operator', 'admin'];
export function profileOf(user: { roles: string }): string {
  const roles = roleList(user.roles);
  return PROFILE_ORDER.find((r) => roles.includes(r)) ?? roles[0] ?? 'none';
}

/** 待办 / KPI 下钻的目标页（带筛选参数；与 docs/ux-work-rules.md 第五节约定一致） */
export const PATHS = {
  iqc: '/quality/inspections?status=PENDING&type=IQC',
  inspOther: '/quality/inspections?status=PENDING',
  ncrOpen: '/quality/ncrs?status=OPEN',
  ncrOverdue: '/quality/ncrs?overdue=1',
  release: '/quality/release',
  capa: '/quality/capas',
  complaint: '/quality/complaints',
  supplierReturn: '/quality/supplier-returns?status=PENDING',
  rma: '/wms/customer-returns?status=RECEIVED',
  bomSubmitted: '/engineering/boms?status=SUBMITTED',
  routingSubmitted: '/engineering/routings?status=SUBMITTED',
  bomDraft: '/engineering/boms?status=DRAFT',
  routingDraft: '/engineering/routings?status=DRAFT',
  soDraft: '/sales/orders?status=DRAFT',
  soConfirmed: '/sales/orders?status=CONFIRMED',
  soOpen: '/sales/orders?status=CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED',
  soOverdue: '/?risk=overdue',
  poApprove: '/purchase/orders?status=DRAFT',
  poReceive: '/purchase/orders?status=APPROVED,PARTIAL_RECEIVED',
  poChase: '/purchase/chase',
  mrp: '/plan/mrp',
  woShort: '/mes/work-orders?kitting=SHORT',
  woPlanned: '/mes/work-orders?status=PLANNED',
  woWip: '/mes/work-orders?status=RELEASED,IN_PROGRESS',
  woToReceive: '/mes/work-orders?status=IN_PROGRESS,COMPLETED',
  putaway: '/wms/putaway',
  issueDraft: '/wms/issues?status=DRAFT',
  shipDraft: '/wms/shipments?status=DRAFT',
  shipNew: '/wms/shipments?new=1',
  countOpen: '/wms/counts',
  expiring: '/wms/stock?expiring_days=30',
  belowSafety: '/wms/stock?tab=summary&below_safety=1',
  stockSummary: '/wms/stock?tab=summary',
  calib: '/master/equipment',
  supplierQual: '/master/suppliers',
  rates: '/master/exchange-rates',
  arOverdue: '/finance?tab=AR&overdue=1',
  arOpen: '/finance?tab=AR',
  apDue: '/finance?tab=AP&due_within=7',
  apOpen: '/finance?tab=AP',
  payments: '/finance?tab=PAY',
  usersLocked: '/system/users?status=locked',
  usersNoRole: '/system/users?status=no_role',
  usersInitial: '/system/users?status=initial_password',
  usersAll: '/system/users',
  audit: '/system/audit',
  quals: '/system/qualifications',
  station: '/mes/station',
} as const;

/** 大额采购单（本位币）须厂长审批的金额线 */
const PO_APPROVAL_THRESHOLD = Number(process.env.PO_APPROVAL_THRESHOLD || 50000);

const pct = (n: number, total: number) => (total ? round((n / total) * 100, 1) : null);
const OPEN_SO = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'];
const OPEN_WO = ['PLANNED', 'RELEASED', 'IN_PROGRESS'];

/** 一次请求内的计数器（同一数字在待办与 KPI 中只算一次） */
class Counters {
  private memo = new Map<string, Promise<any>>();
  constructor(readonly tx: Tx, private readonly shortage: () => Promise<Map<number, number>>) {}
  private m<T>(k: string, f: () => Promise<T>): Promise<T> {
    if (!this.memo.has(k)) this.memo.set(k, f());
    return this.memo.get(k)!;
  }
  get t() {
    return today();
  }
  pendingIqc = () => this.m('iqc', () => this.tx.inspection.count({ where: { status: 'PENDING', insp_type: 'IQC' } }));
  pendingOtherInsp = () => this.m('insp', () => this.tx.inspection.count({ where: { status: 'PENDING', insp_type: { not: 'IQC' } } }));
  openNcr = () => this.m('ncr', () => this.tx.ncr.count({ where: { status: 'OPEN' } }));
  overdueNcr = () => this.m('ncr_od', () => this.tx.ncr.count({ where: { status: 'OPEN', due_date: { not: null, lt: this.t } } }));
  pendingRelease = () => this.m('rel', () => pendingReleaseCount(this.tx));
  openCapa = () => this.m('capa', () => this.tx.capa.count({ where: { status: { not: 'CLOSED' } } }));
  overdueCapa = () => this.m('capa_od', () => this.tx.capa.count({ where: { status: { not: 'CLOSED' }, due_date: { not: null, lt: this.t } } }));
  openComplaint = () => this.m('cmp', () => this.tx.complaint.count({ where: { status: { not: 'CLOSED' } } }));
  bomSubmitted = () => this.m('bom_s', () => this.tx.bom.count({ where: { status: 'SUBMITTED' } }));
  routingSubmitted = () => this.m('rt_s', () => this.tx.routing.count({ where: { status: 'SUBMITTED' } }));
  bomDraft = () => this.m('bom_d', () => this.tx.bom.count({ where: { status: 'DRAFT' } }));
  routingDraft = () => this.m('rt_d', () => this.tx.routing.count({ where: { status: 'DRAFT' } }));
  soDraft = () => this.m('so_d', () => this.tx.salesOrder.count({ where: { status: 'DRAFT' } }));
  soConfirmed = () => this.m('so_c', () => this.tx.salesOrder.count({ where: { status: 'CONFIRMED' } }));
  openSo = () => this.m('so_open', () => this.tx.salesOrder.findMany({ where: { status: { in: OPEN_SO } }, include: { customer: true }, orderBy: { id: 'asc' } }));
  overdueSo = () => this.m('so_od', async () => (await this.openSo()).filter((s) => s.delivery_date && s.delivery_date.getTime() < this.t.getTime()).length);
  dueSoon = () => this.m('so_7', async () => (await this.openSo()).filter((s) => s.delivery_date && s.delivery_date.getTime() >= this.t.getTime() && s.delivery_date.getTime() <= addDays(this.t, 7).getTime()).length);
  woPlanned = () => this.m('wo_p', () => this.tx.workOrder.count({ where: { status: 'PLANNED' } }));
  woWip = () => this.m('wo_wip', () => this.tx.workOrder.count({ where: { status: { in: ['RELEASED', 'IN_PROGRESS'] } } }));
  woToReceive = () => this.m('wo_fg', async () => {
    const [{ n }] = await this.tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM mes_work_order WHERE status IN ('IN_PROGRESS', 'COMPLETED') AND completed_qty > received_qty`;
    return Number(n);
  });
  /** 缺料工单（与工单列表 kitting=SHORT 同口径：G3 齐套分析；不可用时按估算） */
  woShort = () => this.m('wo_short', async () => (await this.shortage()).size);
  poDraft = () => this.m('po_d', () => this.tx.purchaseOrder.count({ where: { status: { in: ['DRAFT', 'SUBMITTED'] } } }));
  poToReceive = () => this.m('po_r', () => this.tx.purchaseOrder.count({ where: { status: { in: ['APPROVED', 'PARTIAL_RECEIVED'] } } }));
  /** 逾期未到货的采购订单（按行：回复交期 > 行交期 > 单头交期） */
  poOverdue = () => this.m('po_od', async () => {
    const lines = await this.tx.purchaseOrderLine.findMany({
      where: { order: { status: { in: ['APPROVED', 'PARTIAL_RECEIVED'] } } }, include: { order: true },
    });
    const ids = new Set<number>();
    for (const l of lines) {
      const due = l.promised_date ?? l.expected_date ?? l.order.expected_date;
      if (l.received_qty + 1e-9 < l.qty && due && due.getTime() < this.t.getTime()) ids.add(l.order_id);
    }
    return ids.size;
  });
  issueDraft = () => this.m('iss', () => this.tx.materialIssue.count({ where: { status: 'DRAFT' } }));
  shipDraft = () => this.m('ship', () => this.tx.shipment.count({ where: { status: 'DRAFT' } }));
  supplierReturns = () => this.m('sr', () => this.tx.supplierReturn.count({ where: { status: 'PENDING' } }));
  customerReturns = () => this.m('rma', () => this.tx.customerReturn.count({ where: { status: 'RECEIVED' } }));
  countOpen = () => this.m('cnt', () => this.tx.stockCount.count({ where: { status: 'OPEN' } }));
  expiringLots = () => this.m('exp', () => this.tx.stock.count({ where: { qty: { gt: 0 }, expiry_date: { not: null, lte: addDays(this.t, 30) } } }));
  belowSafety = () => this.m('below', async () => {
    const avail = new Map<number, number>();
    for (const r of await this.tx.stock.groupBy({ by: ['material_id'], where: { status: 'AVAILABLE' }, _sum: { qty: true } })) avail.set(r.material_id, r._sum.qty ?? 0);
    return (await this.tx.material.findMany({ where: { safety_stock: { gt: 0 }, is_active: true }, select: { id: true, safety_stock: true } }))
      .filter((m) => (avail.get(m.id) ?? 0) < m.safety_stock).length;
  });
  calibOverdue = () => this.m('cal', () => this.tx.equipment.count({ where: { calibration_required: true, next_calibration_date: { lt: this.t } } }));
  calibDue = () => this.m('cal30', () => this.tx.equipment.count({ where: { calibration_required: true, next_calibration_date: { lte: addDays(this.t, 30) } } }));
  supplierQualDue = () => this.m('supq', () => this.tx.supplier.count({ where: { status: 'QUALIFIED', qualification_expiry: { not: null, lte: addDays(this.t, 60) } } }));
  mrpOpen = (action?: string) => this.m(`mrp_${action ?? ''}`, () => this.tx.mrpSuggestion.count({ where: { status: 'OPEN', ...(action ? { action } : {}) } }));
  /** 已放行可发货：未发完的销售订单中，其成品有合格可用库存（不含已有待过账发货单的订单） */
  shippable = () => this.m('shippable', async () => {
    const sos = await this.tx.salesOrder.findMany({
      where: { status: { in: OPEN_SO }, shipments: { none: { status: 'DRAFT' } } },
      include: { lines: true },
    });
    const avail = await availableFg(this.tx);
    return sos.filter((s) => s.lines.some((l) => l.qty - l.shipped_qty > 1e-9 && (avail.get(l.material_id) ?? 0) > 1e-9)).map((s) => s.id);
  });
  /** 大额待审批采购单（本位币 ≥ 阈值） */
  bigPoDraft = () => this.m('po_big', async () => {
    const pos = await this.tx.purchaseOrder.findMany({ where: { status: { in: ['DRAFT', 'SUBMITTED'] } } });
    const book = await RateBook.load(this.tx);
    return pos.filter((p) => (book.toBase(p.total_amount, p.currency, this.t) ?? 0) >= PO_APPROVAL_THRESHOLD).length;
  });
}

/** 成品合格可用库存（自有，不含客供） */
async function availableFg(tx: Tx): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  for (const r of await tx.stock.groupBy({ by: ['material_id'], where: { status: 'AVAILABLE', owner_customer_id: null, material: { category: 'FINISHED' } }, _sum: { qty: true } })) {
    m.set(r.material_id, r._sum.qty ?? 0);
  }
  return m;
}

/**
 * 工单缺料估算（只读，G3 齐套分析不可用时的兜底）：按计划开工先后把合格可用库存依次分给未完工工单，
 * 剩余需求（需求 − 已领）分不到的即为缺口。返回 wo_id → 缺料物料数。
 */
export async function shortageByWo(tx: Tx): Promise<Map<number, number>> {
  const wos = await tx.workOrder.findMany({
    where: { status: { in: OPEN_WO } }, include: { materials: true },
    orderBy: [{ planned_start: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  });
  const avail = new Map<number, number>();
  for (const r of await tx.stock.groupBy({ by: ['material_id'], where: { status: 'AVAILABLE' }, _sum: { qty: true } })) avail.set(r.material_id, r._sum.qty ?? 0);
  const out = new Map<number, number>();
  for (const w of wos) {
    let n = 0;
    for (const m of w.materials) {
      const need = Math.max(0, m.required_qty - m.issued_qty);
      if (need <= 1e-9) continue;
      const a = avail.get(m.material_id) ?? 0;
      if (a + 1e-9 < need) n++;
      avail.set(m.material_id, Math.max(0, a - need));
    }
    if (n) out.set(w.id, n);
  }
  return out;
}

const kpi = (k: Kpi): Kpi => k;

@Injectable()
export class WorkbenchService {
  constructor(private readonly db: PrismaService, private readonly kitting: KittingService) {}

  /**
   * 未完工工单缺料：wo_id → 缺料物料数（只含缺料的工单）。
   * 优先用 G3 齐套分析（含客供料、按优先级分配、与工单列表 kitting=SHORT 同口径）；出错时退回本地估算。
   */
  async shortages(tx: Tx): Promise<{ map: Map<number, number>; eta: Map<number, string | null>; source: 'kitting' | 'estimate' }> {
    try {
      const ids = (await tx.workOrder.findMany({ where: { status: { in: OPEN_WO } }, select: { id: true } })).map((w) => w.id);
      const r = ids.length ? await this.kitting.workOrders(ids) : {};
      const map = new Map<number, number>();
      const eta = new Map<number, string | null>();
      for (const [k, v] of Object.entries(r)) {
        if (!v.kitted) map.set(Number(k), v.shortage_count || 1);
        eta.set(Number(k), v.eta ?? null);
      }
      return { map, eta, source: 'kitting' };
    } catch {
      return { map: await shortageByWo(tx), eta: new Map(), source: 'estimate' };
    }
  }

  private counters(tx: Tx) {
    let p: Promise<Map<number, number>> | null = null;
    return new Counters(tx, () => (p ??= this.shortages(tx).then((x) => x.map)));
  }

  /** 待办（按岗位）：厂长只看要他拍板的事，不再把各岗位的活都堆给他 */
  async todos(tx: Tx, user: CurrentUser): Promise<TodoItem[]> {
    const roles = new Set(roleList(user.roles));
    const c = this.counters(tx);
    const items: TodoItem[] = [];
    const add = async (who: string[], key: string, title: string, count: () => Promise<number>, path: string, level?: Level) => {
      if (!who.some((r) => roles.has(r))) return;
      const n = await count();
      if (n) items.push({ key, title, count: n, path, ...(level ? { level } : {}) });
    };
    // 厂长：要他拍板/关注的
    await add(['manager'], 'so_overdue', '已逾期未发完的销售订单', c.overdueSo, PATHS.soOverdue, 'error');
    await add(['manager'], 'po_big', `待审批的大额采购单（≥${PO_APPROVAL_THRESHOLD.toLocaleString()}）`, c.bigPoDraft, PATHS.poApprove, 'warning');
    await add(['manager', 'qa'], 'ncr_overdue', '超期未处置的不合格品（NCR）', c.overdueNcr, PATHS.ncrOverdue, 'error');
    // 质量
    await add(['qc', 'qa'], 'iqc', '待检验的来料（IQC）', c.pendingIqc, PATHS.iqc);
    await add(['qc', 'qa'], 'insp_other', '待检验的过程/成品检验单', c.pendingOtherInsp, PATHS.inspOther);
    await add(['qa'], 'dhr', '待审核放行的生产批（DHR，含可分批放行）', c.pendingRelease, PATHS.release);
    await add(['qa'], 'ncr', '待评审处置的不合格品（NCR）', c.openNcr, PATHS.ncrOpen);
    await add(['qa'], 'bom_submitted', '待批准的 BOM', c.bomSubmitted, PATHS.bomSubmitted);
    await add(['qa'], 'routing_submitted', '待批准的工艺路线', c.routingSubmitted, PATHS.routingSubmitted);
    await add(['qa'], 'capa', '进行中的 CAPA', c.openCapa, PATHS.capa);
    await add(['qa'], 'complaint', '未结案的客户投诉/不良事件', c.openComplaint, PATHS.complaint);
    // 计划
    await add(['planner'], 'wo_short', '缺料的生产工单', c.woShort, PATHS.woShort, 'warning');
    await add(['planner'], 'so_no_wo', '已确认待排产的销售订单', c.soConfirmed, PATHS.soConfirmed);
    await add(['planner'], 'wo_planned', '待下达的生产工单', c.woPlanned, PATHS.woPlanned);
    // 采购
    await add(['purchaser'], 'po_draft', '待审批的采购订单', c.poDraft, PATHS.poApprove);
    await add(['purchaser', 'planner'], 'po_overdue', '逾期未到货的采购订单（催货）', c.poOverdue, PATHS.poChase, 'warning');
    await add(['purchaser'], 'mrp_purchase', 'MRP 待转采购的建议', () => c.mrpOpen('PURCHASE'), PATHS.mrp);
    await add(['purchaser'], 'supplier_qual', '资质 60 天内到期的供应商', c.supplierQualDue, PATHS.supplierQual);
    // 仓管
    await add(['warehouse'], 'po_receive', '待收货的采购订单', c.poToReceive, PATHS.poReceive);
    await add(['warehouse'], 'issue', '待发料的领料单', c.issueDraft, PATHS.issueDraft);
    await add(['warehouse'], 'ship', '待过账的发货单', c.shipDraft, PATHS.shipDraft);
    await add(['warehouse'], 'shippable', '已放行可发货的销售订单', async () => (await c.shippable()).length, PATHS.shipNew);
    await add(['warehouse'], 'fg', '待完工入库的工单', c.woToReceive, PATHS.woToReceive);
    await add(['warehouse', 'qa'], 'supplier_return', '待出库的退供应商单', c.supplierReturns, PATHS.supplierReturn);
    await add(['warehouse', 'qa'], 'rma', '待处置的客户退货（RMA）', c.customerReturns, PATHS.rma);
    await add(['warehouse'], 'count_open', '进行中的盘点单', c.countOpen, PATHS.countOpen);
    await add(['warehouse'], 'expiring', '30 天内到期/已过期的批次', c.expiringLots, PATHS.expiring, 'warning');
    await add(['warehouse', 'purchaser'], 'below_safety', '低于安全库存的物料', c.belowSafety, PATHS.belowSafety);
    // 工程
    await add(['engineer'], 'bom', '待提交的 BOM 草稿', c.bomDraft, PATHS.bomDraft);
    await add(['engineer'], 'routing', '待提交的工艺路线草稿', c.routingDraft, PATHS.routingDraft);
    await add(['engineer'], 'calib', '校准过期的设备', c.calibOverdue, PATHS.calib, 'error');
    // 销售
    await add(['sales'], 'so_draft', '待确认的销售订单', c.soDraft, PATHS.soDraft);
    await add(['sales'], 'so_overdue_sales', '已逾期未发完的销售订单', c.overdueSo, PATHS.soOverdue, 'error');
    // 财务 / 管理员
    if (roles.has('finance')) items.push(...(await this.financeTodos(tx)));
    if (roles.has('admin')) items.push(...(await this.securityTodos(tx)));
    return items;
  }

  /** 工作台：主岗位 + KPI 卡（带下钻 path）+ 岗位专属区块 */
  async workbench(tx: Tx, user: CurrentUser) {
    const profile = profileOf(user);
    const roles = new Set(roleList(user.roles));
    const perms = userPermissions(user);
    const c = this.counters(tx);
    const kpis: Kpi[] = [];
    const seen = new Set<string>();
    const push = (...ks: Kpi[]) => ks.forEach((k) => !seen.has(k.key) && (seen.add(k.key), kpis.push(k)));
    const warnIf = (n: number, level: Level = 'warning'): Level | undefined => (n > 0 ? level : undefined);
    const ordered = PROFILE_ORDER.filter((r) => roles.has(r));
    const sections: Record<string, any> = {};

    for (const r of ordered) {
      if (r === 'manager') {
        const open = await c.openSo();
        const od = await c.overdueSo();
        const sd = await this.outputAndFpy(tx);
        push(
          kpi({ key: 'open_so', title: '在手销售订单', value: open.length, hint: `7 天内到期 ${await c.dueSoon()} 张`, path: PATHS.soOpen }),
          kpi({ key: 'overdue_so', title: '逾期订单', value: od, hint: '交期已过未发完', level: warnIf(od, 'error'), path: PATHS.soOverdue }),
          kpi({ key: 'wip_wo', title: '在制工单', value: await c.woWip(), hint: `缺料工单 ${await c.woShort()} 张`, path: PATHS.woWip }),
          kpi({ key: 'today_output', title: '今日产出（台）', value: sd.today_output, hint: `近 7 天日均 ${sd.avg7}`, path: '#output' }),
          kpi({
            key: 'fpy', title: '一次直通率 FPY', value: sd.fpy, suffix: sd.fpy != null ? '%' : undefined, hint: sd.fpy == null ? '近 30 天无测试记录' : '近 30 天，目标 ≥ 95%',
            level: sd.fpy == null ? undefined : sd.fpy >= 95 ? 'success' : sd.fpy >= 90 ? 'warning' : 'error', path: '#fpy',
          }),
          kpi({ key: 'pending_release', title: '待放行批次', value: await c.pendingRelease(), hint: 'DHR 待 QA 审核', path: PATHS.release }),
          kpi({ key: 'open_ncr', title: '待处置 NCR', value: await c.openNcr(), hint: `其中超期 ${await c.overdueNcr()} 张`, level: warnIf(await c.overdueNcr(), 'error'), path: PATHS.ncrOpen }),
          kpi({ key: 'pending_iqc', title: '待检来料 IQC', value: await c.pendingIqc(), path: PATHS.iqc }),
          kpi({ key: 'calibration_due', title: '校准到期仪器', value: await c.calibDue(), hint: '30 天内到期/已过期', level: warnIf(await c.calibOverdue(), 'error'), path: PATHS.calib }),
          kpi({ key: 'expiring_lots', title: '临期批次', value: await c.expiringLots(), hint: '30 天内到期', path: PATHS.expiring }),
        );
        sections.approvals = (await this.todos(tx, { ...user, roles: 'manager' })).filter((t) => ['so_overdue', 'po_big', 'ncr_overdue'].includes(t.key));
      } else if (r === 'qa') {
        push(
          kpi({ key: 'pending_release', title: '待放行批次', value: await c.pendingRelease(), hint: 'DHR 待审核', level: warnIf(await c.pendingRelease()), path: PATHS.release }),
          kpi({ key: 'open_ncr', title: '待处置 NCR', value: await c.openNcr(), level: warnIf(await c.openNcr()), path: PATHS.ncrOpen }),
          kpi({ key: 'overdue_ncr', title: '超期 NCR', value: await c.overdueNcr(), hint: '超过处置期限', level: warnIf(await c.overdueNcr(), 'error'), path: PATHS.ncrOverdue }),
          kpi({ key: 'eng_submitted', title: '待批准 BOM/工艺', value: (await c.bomSubmitted()) + (await c.routingSubmitted()), hint: `BOM ${await c.bomSubmitted()} · 工艺 ${await c.routingSubmitted()}`, path: (await c.bomSubmitted()) || !(await c.routingSubmitted()) ? PATHS.bomSubmitted : PATHS.routingSubmitted }),
          kpi({ key: 'open_capa', title: '进行中 CAPA', value: await c.openCapa(), hint: `超期 ${await c.overdueCapa()} 项`, level: warnIf(await c.overdueCapa(), 'error'), path: PATHS.capa }),
          kpi({ key: 'open_complaint', title: '未结客诉', value: await c.openComplaint(), path: PATHS.complaint }),
        );
      } else if (r === 'qc') {
        const rate = await this.iqcPassRate(tx);
        push(
          kpi({ key: 'pending_iqc', title: '待检来料 IQC', value: await c.pendingIqc(), level: warnIf(await c.pendingIqc()), path: PATHS.iqc }),
          kpi({ key: 'pending_insp', title: '待检过程/成品', value: await c.pendingOtherInsp(), path: PATHS.inspOther }),
          kpi({ key: 'iqc_rate', title: 'IQC 合格率', value: rate.rate ?? '暂无数据', suffix: rate.rate != null ? '%' : undefined, hint: `近 30 天已检 ${rate.total} 批` }),
          kpi({ key: 'open_ncr', title: '待处置 NCR', value: await c.openNcr(), path: PATHS.ncrOpen }),
        );
      } else if (r === 'planner') {
        push(
          kpi({ key: 'wo_short', title: '缺料工单', value: await c.woShort(), hint: '未完工工单齐套检查', level: warnIf(await c.woShort()), path: PATHS.woShort }),
          kpi({ key: 'so_confirmed', title: '待排产订单', value: await c.soConfirmed(), path: PATHS.soConfirmed }),
          kpi({ key: 'wo_planned', title: '待下达工单', value: await c.woPlanned(), path: PATHS.woPlanned }),
          kpi({ key: 'overdue_so', title: '逾期订单', value: await c.overdueSo(), level: warnIf(await c.overdueSo(), 'error'), path: PATHS.soOverdue }),
          kpi({ key: 'wip_wo', title: '在制工单', value: await c.woWip(), path: PATHS.woWip }),
          kpi({ key: 'po_overdue', title: '逾期未到货采购单', value: await c.poOverdue(), level: warnIf(await c.poOverdue()), path: PATHS.poChase }),
        );
      } else if (r === 'purchaser') {
        push(
          kpi({ key: 'po_draft', title: '待审批采购单', value: await c.poDraft(), path: PATHS.poApprove }),
          kpi({ key: 'po_overdue', title: '逾期未到货', value: await c.poOverdue(), hint: '按回复交期/交期', level: warnIf(await c.poOverdue(), 'error'), path: PATHS.poChase }),
          kpi({ key: 'po_receive', title: '在途采购单', value: await c.poToReceive(), path: PATHS.poReceive }),
          kpi({ key: 'mrp_purchase', title: 'MRP 采购建议', value: await c.mrpOpen('PURCHASE'), hint: '待转采购单', path: PATHS.mrp }),
          kpi({ key: 'below_safety', title: '低于安全库存', value: await c.belowSafety(), level: warnIf(await c.belowSafety()), path: PATHS.belowSafety }),
          kpi({ key: 'supplier_qual', title: '供应商资质到期', value: await c.supplierQualDue(), hint: '60 天内', path: PATHS.supplierQual }),
        );
      } else if (r === 'sales') {
        const open = await c.openSo();
        push(
          kpi({ key: 'so_draft', title: '待确认订单', value: await c.soDraft(), path: PATHS.soDraft }),
          kpi({ key: 'open_so', title: '在手订单', value: open.length, path: PATHS.soOpen }),
          kpi({ key: 'overdue_so', title: '逾期订单', value: await c.overdueSo(), level: warnIf(await c.overdueSo(), 'error'), path: PATHS.soOverdue }),
          kpi({ key: 'due_soon', title: '7 天内到期', value: await c.dueSoon(), path: '#risk' }),
          kpi({ key: 'shippable', title: '可发货订单', value: (await c.shippable()).length, hint: '成品已放行有库存', path: PATHS.soOpen }),
        );
      } else if (r === 'finance') {
        sections.finance = await this.financeSection(tx);
        const f = sections.finance;
        push(
          kpi({ key: 'ar_open', title: '应收余额', value: f.ar_open_base, suffix: f.base_currency, hint: `${f.ar_open_count} 张未结`, path: PATHS.arOpen }),
          kpi({ key: 'ar_overdue', title: '逾期应收', value: f.ar_overdue_base, suffix: f.base_currency, hint: `${f.ar_overdue.length} 张已过到期日`, level: warnIf(f.ar_overdue.length, 'error'), path: PATHS.arOverdue }),
          kpi({ key: 'ap_due', title: '7 天内到期应付', value: f.ap_due_base, suffix: f.base_currency, hint: `${f.ap_due.length} 张（含已逾期）`, level: warnIf(f.ap_due.length), path: PATHS.apDue }),
          kpi({ key: 'ap_open', title: '应付余额', value: f.ap_open_base, suffix: f.base_currency, hint: `${f.ap_open_count} 张未结`, path: PATHS.apOpen }),
          kpi({ key: 'month_received', title: '本月已收款', value: f.month_received_base, suffix: f.base_currency, hint: `已付款 ${f.month_paid_base.toLocaleString()}`, path: PATHS.payments }),
          kpi({ key: 'missing_rates', title: '缺汇率币别', value: f.missing_rates.length, hint: f.missing_rates.length ? f.missing_rates.join('、') : '汇率齐全', level: warnIf(f.missing_rates.length), path: PATHS.rates }),
        );
      } else if (r === 'warehouse') {
        push(
          kpi({ key: 'po_receive', title: '待收货', value: await c.poToReceive(), path: PATHS.poReceive }),
          kpi({ key: 'issue', title: '待发料', value: await c.issueDraft(), path: PATHS.issueDraft }),
          kpi({ key: 'shippable', title: '可发货', value: (await c.shippable()).length + (await c.shipDraft()), path: (await c.shipDraft()) ? PATHS.shipDraft : PATHS.shipNew }),
          kpi({ key: 'fg', title: '待完工入库', value: await c.woToReceive(), path: PATHS.woToReceive }),
          kpi({ key: 'supplier_return', title: '退供应商待出库', value: await c.supplierReturns(), path: PATHS.supplierReturn }),
          kpi({ key: 'expiring', title: '临期/过期批次', value: await c.expiringLots(), level: warnIf(await c.expiringLots()), path: PATHS.expiring }),
        );
      } else if (r === 'engineer') {
        push(
          kpi({ key: 'bom_draft', title: 'BOM 草稿', value: await c.bomDraft(), path: PATHS.bomDraft }),
          kpi({ key: 'routing_draft', title: '工艺路线草稿', value: await c.routingDraft(), path: PATHS.routingDraft }),
          kpi({ key: 'eng_submitted', title: '待 QA 批准', value: (await c.bomSubmitted()) + (await c.routingSubmitted()), path: PATHS.bomSubmitted }),
          kpi({ key: 'calib', title: '校准过期设备', value: await c.calibOverdue(), hint: `30 天内到期 ${await c.calibDue()} 台`, level: warnIf(await c.calibOverdue(), 'error'), path: PATHS.calib }),
        );
      } else if (r === 'operator') {
        sections.operator = await this.operatorSection(tx, user);
        const o = sections.operator;
        push(
          kpi({ key: 'my_today', title: '今日我过站', value: o.my_today, suffix: '次', hint: `合格 ${o.my_today_pass} · 不合格 ${o.my_today_fail}` }),
          kpi({ key: 'my_quals', title: '我的上岗资质', value: o.quals.length, suffix: '项', hint: o.expiring ? `${o.expiring} 项 30 天内到期` : '均在有效期内', level: o.expiring ? 'warning' : undefined }),
          kpi({ key: 'wip_wo', title: '生产中工单', value: o.active_wos.length, path: PATHS.station }),
        );
      } else if (r === 'admin') {
        sections.security = await this.securitySection(tx);
        const s = sections.security;
        push(
          kpi({ key: 'locked', title: '已锁定账号', value: s.locked.length, level: warnIf(s.locked.length, 'error'), path: PATHS.usersLocked }),
          kpi({ key: 'failed_24h', title: '24 小时登录失败', value: s.failed_24h, level: s.failed_24h >= 10 ? 'warning' : undefined, path: PATHS.audit + '?entity=sys_login' }),
          kpi({ key: 'no_role', title: '待分配角色', value: s.no_role.length, level: warnIf(s.no_role.length), path: PATHS.usersNoRole }),
          kpi({ key: 'initial_pwd', title: '初始密码未改', value: s.initial_password.length, hint: s.demo_password.length ? `其中 ${s.demo_password.length} 个仍用公开演示密码` : '须本人首次登录修改', level: warnIf(s.initial_password.length, 'error'), path: PATHS.usersInitial }),
          kpi({ key: 'pwd_expiring', title: '密码 7 天内到期', value: s.pwd_expiring.length, hint: s.pwd_expiring.map((u: any) => u.username).slice(0, 3).join('、') || undefined, path: PATHS.usersAll }),
          kpi({ key: 'unsealed', title: '审计待封存', value: s.unsealed, hint: `已封存 ${s.sealed} 条（哈希链）`, path: PATHS.audit }),
        );
      }
    }
    // 金额只给有权限的人：在手订单金额（销售/财务）、库存金额（财务/采购）
    if (READ_PERMS.salesAmount.some((p) => perms.has(p)) && (roles.has('manager') || roles.has('sales'))) {
      const open = await c.openSo();
      const book = await RateBook.load(tx);
      let total = 0;
      const missing = new Set<string>();
      for (const o of open) {
        const v = book.toBase(o.total_amount, o.currency, c.t);
        if (v === null) missing.add(o.currency);
        else total += v;
      }
      const k = kpis.find((x) => x.key === 'open_so');
      if (k) k.hint = `金额 ${book.base} ${round2(total).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}${missing.size ? `（缺 ${[...missing].join('、')} 汇率未计入）` : ''}`;
    }
    if (READ_PERMS.stockValue.some((p) => perms.has(p)) && roles.has('manager')) {
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        SELECT ROUND(COALESCE(SUM(s.qty::numeric * m.std_cost), 0), 2)::float8 AS value FROM wms_stock s JOIN md_material m ON m.id = s.material_id`;
      push(kpi({ key: 'stock_value', title: '库存金额', value: Math.round(Number(value) || 0), suffix: '元', hint: `低于安全库存 ${await c.belowSafety()} 项`, path: PATHS.stockSummary }));
    }
    return { profile, roles: [...roles], kpis, sections };
  }

  /** 今日产出、近 7 天日均、近 30 天 FPY（按序列号首次测试） */
  private async outputAndFpy(tx: Tx) {
    const t = today();
    const start = addDays(t, -6);
    const counts = new Map<string, number>();
    for (const s of await tx.serialNumber.findMany({ where: { completed_at: { gte: localStart(start) } }, select: { completed_at: true } })) {
      const d = localDateStr(s.completed_at!);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const total7 = [...counts.values()].reduce((a, b) => a + b, 0);
    const fpy = await this.fpyStats(tx);
    return { today_output: counts.get(fmtDate(t)!) ?? 0, avg7: round(total7 / 7, 1), fpy: fpy.overall };
  }

  private async fpyStats(tx: Tx) {
    const since = localStart(addDays(today(), -30));
    const recs = await tx.operationRecord.findMany({
      where: { ts: { gte: since }, sn_id: { not: null } }, orderBy: { id: 'asc' }, select: { op_name: true, sn_id: true, result: true },
    });
    const first = new Map<string, { op: string; sn: number; result: string }>();
    for (const r of recs) {
      const k = `${r.op_name}\u0000${r.sn_id}`;
      if (!first.has(k)) first.set(k, { op: r.op_name, sn: r.sn_id!, result: r.result });
    }
    const vals = [...first.values()];
    const sns = new Set(vals.map((v) => v.sn));
    let passedAll = 0;
    for (const sn of sns) if (vals.every((v) => v.sn !== sn || v.result === 'PASS')) passedAll++;
    return { overall: sns.size ? pct(passedAll, sns.size) : null };
  }

  private async iqcPassRate(tx: Tx) {
    const since = localStart(addDays(today(), -30));
    const done = await tx.inspection.findMany({ where: { insp_type: 'IQC', inspected_at: { gte: since } }, select: { status: true } });
    return { total: done.length, rate: done.length ? pct(done.filter((i) => i.status === 'PASSED').length, done.length) : null };
  }

  /** 财务：应收应付余额、逾期应收、7 天内到期应付、本月收付款、缺汇率 */
  async financeSection(tx: Tx) {
    const t = today();
    const book = await RateBook.load(tx);
    const docs = await tx.financeDoc.findMany({
      where: { status: { not: 'PAID' } }, include: { customer: true, supplier: true }, orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
    const row = (d: (typeof docs)[number]) => {
      const balance = round2(num(d.amount) - num(d.paid_amount));
      return {
        id: d.id, no: d.no, doc_type: d.doc_type, partner: d.customer?.name ?? d.supplier?.name ?? null, ref_no: d.ref_no, currency: d.currency,
        balance, base_balance: book.toBase(balance, d.currency, t), due_date: fmtDate(d.due_date),
        days_overdue: d.due_date && d.due_date.getTime() < t.getTime() ? daysBetween(t, d.due_date) : 0,
      };
    };
    const rows = docs.map(row);
    const sum = (xs: typeof rows) => round2(xs.reduce((s, x) => s + (x.base_balance ?? 0), 0));
    const ar = rows.filter((r) => r.doc_type === 'AR');
    const ap = rows.filter((r) => r.doc_type === 'AP');
    const arOverdue = ar.filter((r) => r.days_overdue > 0).sort((a, b) => b.days_overdue - a.days_overdue);
    const apDue = ap.filter((r) => r.due_date && dateOnly(r.due_date)!.getTime() <= addDays(t, 7).getTime());
    const monthStart = dateOnly(`${localDateStr().slice(0, 7)}-01`)!;
    const pays = await tx.payment.findMany({ where: { pay_date: { gte: monthStart }, status: { not: 'VOID' } }, include: { doc: true } });
    let rec = 0;
    let paid = 0;
    for (const p of pays) {
      const v = p.base_amount != null ? num(p.base_amount) : book.toBase(p.amount, p.doc.currency, p.pay_date) ?? 0;
      if (p.doc.doc_type === 'AR') rec += v;
      else paid += v;
    }
    return {
      base_currency: book.base,
      ar_open_count: ar.length, ar_open_base: sum(ar),
      ap_open_count: ap.length, ap_open_base: sum(ap),
      ar_overdue: arOverdue.slice(0, 20), ar_overdue_base: sum(arOverdue),
      ap_due: apDue.slice(0, 20), ap_due_base: sum(apDue),
      month_received_base: round2(rec), month_paid_base: round2(paid),
      missing_rates: [...book.missing].sort(),
    };
  }

  private async financeTodos(tx: Tx): Promise<TodoItem[]> {
    const f = await this.financeSection(tx);
    const out: TodoItem[] = [];
    if (f.ar_overdue.length) out.push({ key: 'ar_overdue', title: '逾期未收的应收单', count: f.ar_overdue.length, path: PATHS.arOverdue, level: 'error' });
    if (f.ap_due.length) out.push({ key: 'ap_due', title: '7 天内到期的应付单', count: f.ap_due.length, path: PATHS.apDue, level: 'warning' });
    if (f.missing_rates.length) out.push({ key: 'missing_rates', title: `缺少汇率的币别（${f.missing_rates.join('、')}）`, count: f.missing_rates.length, path: PATHS.rates, level: 'warning' });
    return out;
  }

  /** 管理员：账号安全 */
  async securitySection(tx: Tx) {
    const now = Date.now();
    const users = await tx.user.findMany({ orderBy: { id: 'asc' } });
    const brief = (u: (typeof users)[number], extra: Record<string, unknown> = {}) => ({ id: u.id, username: u.username, full_name: u.full_name, department: u.department, ...extra });
    const active = users.filter((u) => u.is_active);
    const locked = active.filter((u) => u.locked_until && u.locked_until.getTime() > now).map((u) => brief(u, { locked_until: u.locked_until }));
    const noRole = active.filter((u) => !u.roles).map((u) => brief(u));
    // 初始密码未改：管理员设置/重置后本人未改、从未设置过密码、或仍使用公开演示密码
    const demo = (await demoPasswordUsers(this.db, { activeOnly: true }).catch(() => [])).map((u) => brief(u));
    const demoIds = new Set(demo.map((u) => u.id));
    const initial = active
      .filter((u) => u.auth_source === 'LOCAL' && (u.must_change_password || !u.password_changed_at || demoIds.has(u.id)))
      .map((u) => brief(u, { last_login_at: u.last_login_at, demo_password: demoIds.has(u.id) }));
    const pwdExpiring = active
      .map((u) => ({ u, at: passwordExpiresAt(u) }))
      .filter(({ u, at }) => at && !u.must_change_password && at.getTime() - now <= 7 * 86_400_000)
      .map(({ u, at }) => brief(u, { password_expires_at: at }));
    const failed24 = await tx.auditLog.count({ where: { entity: 'sys_login', action: 'LOGIN_FAILED', ts: { gte: new Date(now - 86_400_000) } } });
    const unsealed = await tx.auditLog.count({ where: { seal_no: null } });
    const sealed = await tx.auditLog.count({ where: { seal_no: { not: null } } });
    const recentFailed = await tx.auditLog.findMany({
      where: { entity: 'sys_login', action: 'LOGIN_FAILED', ts: { gte: new Date(now - 86_400_000) } }, orderBy: { id: 'desc' }, take: 8,
      select: { ts: true, username: true, changes: true },
    });
    return {
      locked, no_role: noRole, initial_password: initial, demo_password: demo, pwd_expiring: pwdExpiring,
      failed_24h: failed24, recent_failed: recentFailed.map((r) => {
        let reason: string | null = null;
        try {
          reason = JSON.parse(r.changes || '{}').reason ?? null;
        } catch {
          /* ignore */
        }
        return { ts: r.ts, username: r.username, reason };
      }),
      unsealed, sealed, inactive: users.length - active.length, total: users.length,
    };
  }

  private async securityTodos(tx: Tx): Promise<TodoItem[]> {
    const s = await this.securitySection(tx);
    const out: TodoItem[] = [];
    if (s.locked.length) out.push({ key: 'users_locked', title: '已锁定的账号（待解锁）', count: s.locked.length, path: PATHS.usersLocked, level: 'error' });
    if (s.no_role.length) out.push({ key: 'users_no_role', title: '待分配角色的账号', count: s.no_role.length, path: PATHS.usersNoRole, level: 'warning' });
    if (s.demo_password.length) out.push({ key: 'users_demo_pwd', title: '仍使用公开演示密码的账号', count: s.demo_password.length, path: PATHS.usersInitial, level: 'error' });
    return out;
  }

  /** 操作员：今日我过站、我的上岗资质、生产中工单 */
  async operatorSection(tx: Tx, user: CurrentUser) {
    const t = today();
    const recs = await tx.operationRecord.groupBy({ by: ['result'], where: { operator: user.username, ts: { gte: localStart(t) } }, _count: { _all: true } });
    const n = (r: string) => recs.find((x) => x.result === r)?._count._all ?? 0;
    const quals = await tx.qualification.findMany({ where: { user_id: user.id, is_active: true }, orderBy: { op_code: 'asc' } });
    const valid = quals.filter((q) => !q.expires_at || q.expires_at.getTime() >= t.getTime());
    const wos = await tx.workOrder.findMany({ where: { status: { in: ['RELEASED', 'IN_PROGRESS'] } }, include: { material: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }], take: 10 });
    return {
      my_today: n('PASS') + n('FAIL'), my_today_pass: n('PASS'), my_today_fail: n('FAIL'),
      quals: valid.map((q) => ({ op_code: q.op_code, level: q.level, expires_at: fmtDate(q.expires_at) })),
      expiring: valid.filter((q) => q.expires_at && q.expires_at.getTime() <= addDays(t, 30).getTime()).length,
      active_wos: wos.map((w) => ({
        id: w.id, no: w.no, material_code: w.material?.code, material_name: w.material?.name, planned_qty: w.planned_qty, completed_qty: w.completed_qty, status: w.status,
      })),
    };
  }

  /**
   * 交付风险：每张未发完的销售订单 —— 交期、剩余天数、进度、计划完工、缺料（估算）、阻塞原因，红黄绿。
   *  红：已逾期；或计划完工晚于交期；或 ≤3 天到期仍未备好货；或 ≤7 天到期且缺料/未排产。
   *  黄：有任何阻塞原因，或 ≤7 天到期未备好货。
   */
  async deliveryRisk(tx: Tx) {
    const t = today();
    const sos = await tx.salesOrder.findMany({
      where: { status: { in: OPEN_SO } }, include: { customer: true, lines: { include: { material: true } } },
      orderBy: [{ delivery_date: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
    const soIds = sos.map((s) => s.id);
    const wos = await tx.workOrder.findMany({ where: { so_id: { in: soIds }, status: { not: 'CANCELLED' } }, orderBy: { id: 'asc' } });
    const woIds = wos.map((w) => w.id);
    const ncrs = await tx.ncr.groupBy({ by: ['wo_id'], where: { wo_id: { in: woIds }, status: 'OPEN' }, _count: { _all: true } });
    const ncrBy = new Map(ncrs.map((r) => [r.wo_id!, r._count._all]));
    const kit = await this.shortages(tx);
    const short = kit.map;
    // 成品合格库存按交期先后分给订单
    const fg = await availableFg(tx);
    const rows: any[] = [];
    for (const so of sos) {
      const my = wos.filter((w) => w.so_id === so.id);
      const ordered = so.lines.reduce((s, l) => s + l.qty, 0);
      const shipped = so.lines.reduce((s, l) => s + l.shipped_qty, 0);
      const remaining = Math.max(0, ordered - shipped);
      let readyQty = 0;
      for (const l of so.lines) {
        const need = Math.max(0, l.qty - l.shipped_qty);
        const a = fg.get(l.material_id) ?? 0;
        const take = Math.min(need, a);
        readyQty += take;
        fg.set(l.material_id, a - take);
      }
      const planned = my.reduce((s, w) => s + w.planned_qty, 0);
      const completed = my.reduce((s, w) => s + w.completed_qty, 0);
      const received = my.reduce((s, w) => s + w.received_qty, 0);
      const releasedQty = my.reduce((s, w) => s + w.released_qty, 0);
      const toRelease = my.filter((w) => w.dhr_status === 'OPEN').reduce((s, w) => s + Math.max(0, w.received_qty - w.released_qty), 0);
      const plannedEnd = my.map((w) => w.planned_end).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
      const due = so.delivery_date ?? so.lines.map((l) => l.delivery_date).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null;
      const daysLeft = due ? daysBetween(due, t) : null;
      const shortage = my.reduce((s, w) => s + (short.get(w.id) ?? 0), 0);
      const openNcr = my.reduce((s, w) => s + (ncrBy.get(w.id) ?? 0), 0);
      // 未排产 = 剩余未发 − 已备成品 − 工单中尚未放行的数量（在制/待放行都算已安排）
      const unscheduled = Math.max(0, remaining - readyQty - Math.max(0, planned - releasedQty));
      const ready = remaining > 0 && readyQty + 1e-9 >= remaining;
      const reasons: string[] = [];
      if (daysLeft !== null && daysLeft < 0) reasons.push(`已逾期 ${-daysLeft} 天`);
      if (unscheduled > 1e-9) reasons.push(`未排产 ${round(unscheduled, 2)} 台`);
      if (my.some((w) => w.status === 'PLANNED')) reasons.push('工单未下达');
      const etas = my.map((w) => kit.eta.get(w.id)).filter((x): x is string => !!x).sort();
      if (shortage) reasons.push(`缺料 ${shortage} 项${etas.length ? `（预计 ${etas[etas.length - 1].slice(5)} 齐套）` : ''}`);
      if (plannedEnd && due && plannedEnd.getTime() > due.getTime()) reasons.push(`计划完工 ${fmtDate(plannedEnd)!.slice(5)} 晚于交期`);
      if (openNcr) reasons.push(`NCR 未处置 ${openNcr} 张`);
      if (toRelease > 1e-9) reasons.push(`待 QA 放行 ${round(toRelease, 2)} 台`);
      if (ready) reasons.push('成品已备齐，可发货');
      const blocking = reasons.filter((r) => !r.startsWith('成品已备齐'));
      let level: 'red' | 'yellow' | 'green' = 'green';
      const late = plannedEnd && due && plannedEnd.getTime() > due.getTime();
      if ((daysLeft !== null && daysLeft < 0) || late || (daysLeft !== null && daysLeft <= 3 && !ready) || (daysLeft !== null && daysLeft <= 7 && (shortage > 0 || unscheduled > 1e-9))) level = 'red';
      else if (blocking.length || (daysLeft !== null && daysLeft <= 7 && !ready)) level = 'yellow';
      rows.push({
        id: so.id, no: so.no, customer_name: so.customer?.name ?? null, customer_po: so.customer_po, status: so.status,
        delivery_date: fmtDate(due), days_left: daysLeft,
        ordered_qty: round(ordered, 4), shipped_qty: round(shipped, 4), completed_qty: round(Math.min(completed, ordered), 4),
        received_qty: round(received, 4), released_qty: round(releasedQty, 4), ready_qty: round(readyQty, 4),
        // 完工进度：已完工（含已发）与“已发 + 已备成品”取大；发货进度单列
        progress: ordered ? round((Math.min(ordered, Math.max(completed, shipped + readyQty)) / ordered) * 100, 0) : 0,
        ship_progress: ordered ? round((shipped / ordered) * 100, 0) : 0,
        planned_end: fmtDate(plannedEnd),
        work_orders: my.map((w) => ({ id: w.id, no: w.no, status: w.status, planned_end: fmtDate(w.planned_end), shortage: short.get(w.id) ?? 0 })),
        shortage_count: shortage, shortage_source: kit.source, open_ncr: openNcr,
        reasons: blocking.length ? blocking : reasons, level,
        products: so.lines.map((l) => `${l.material?.code ?? ''}×${l.qty}`).join('，'),
      });
    }
    const rank = { red: 0, yellow: 1, green: 2 } as const;
    rows.sort((a, b) => rank[a.level as keyof typeof rank] - rank[b.level as keyof typeof rank] || (a.days_left ?? 9999) - (b.days_left ?? 9999));
    return {
      as_of: fmtDate(t),
      summary: { red: rows.filter((r) => r.level === 'red').length, yellow: rows.filter((r) => r.level === 'yellow').length, green: rows.filter((r) => r.level === 'green').length },
      items: rows,
    };
  }

  /** 产出下钻：某日完工的序列号，按工单汇总 */
  async outputDetail(tx: Tx, dateStr?: string) {
    const d = dateOnly(dateStr || localDateStr()) ?? today();
    const sns = await tx.serialNumber.findMany({
      where: { completed_at: { gte: localStart(d), lt: localStart(addDays(d, 1)) } }, include: { work_order: true, material: true }, orderBy: { completed_at: 'asc' },
    });
    const by = new Map<number, any>();
    for (const s of sns) {
      const g = by.get(s.wo_id) ?? { wo_id: s.wo_id, wo_no: s.work_order.no, material_code: s.material?.code, material_name: s.material?.name, qty: 0, serials: [] as string[] };
      g.qty++;
      if (g.serials.length < 200) g.serials.push(s.sn);
      by.set(s.wo_id, g);
    }
    return { date: fmtDate(d), total: sns.length, work_orders: [...by.values()] };
  }

  /** FPY 下钻：近 30 天各工序首次测试结果与首次不合格明细 */
  async fpyDetail(tx: Tx, opName?: string) {
    const since = localStart(addDays(today(), -30));
    const recs = await tx.operationRecord.findMany({
      where: { ts: { gte: since }, sn_id: { not: null }, ...(opName ? { op_name: opName } : {}) },
      orderBy: { id: 'asc' }, include: { serial: true, work_order: true },
    });
    const first = new Map<string, (typeof recs)[number]>();
    for (const r of recs) {
      const k = `${r.op_name}\u0000${r.sn_id}`;
      if (!first.has(k)) first.set(k, r);
    }
    const ops = new Map<string, { op_name: string; tested: number; passed: number }>();
    const fails = [];
    for (const r of first.values()) {
      const o = ops.get(r.op_name) ?? { op_name: r.op_name, tested: 0, passed: 0 };
      o.tested++;
      if (r.result === 'PASS') o.passed++;
      else fails.push({ id: r.id, ts: r.ts, op_name: r.op_name, sn: r.serial?.sn, wo_id: r.wo_id, wo_no: r.work_order.no, operator: r.operator_name || r.operator, remark: r.remark });
      ops.set(r.op_name, o);
    }
    return {
      ops: [...ops.values()].map((o) => ({ ...o, failed: o.tested - o.passed, fpy: pct(o.passed, o.tested) })),
      fails: fails.reverse().slice(0, 200),
    };
  }
}
