/** 经营驾驶舱与“我的待办”（按权限）。日期按工厂时区计算。 */
import { Injectable } from '@nestjs/common';
import { userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, localDateStr, today } from '../common/dates';
import { g, round, round2 } from '../common/num';
import type { Tx } from '../common/prisma.service';
import { config } from '../config';
import { CurrencyTotals, RateBook } from '../erp/currency';

/** 某时刻在工厂时区相对 UTC 的偏移（毫秒） */
function tzOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** 纯日期（UTC 零点表示）→ 该日在工厂时区的 00:00 对应的时刻 */
export function localStart(d: Date): Date {
  const first = new Date(d.getTime() - tzOffsetMs(d));
  return new Date(d.getTime() - tzOffsetMs(first));
}

const pct = (n: number, total: number) => round((n / total) * 100, 1);

@Injectable()
export class ReportService {
  async dashboard(tx: Tx) {
    const t = today();
    const tMs = t.getTime();
    const openSo = await tx.salesOrder.findMany({
      where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'] } }, orderBy: { id: 'asc' }, include: { customer: true },
    });
    const overdueSo = openSo.filter((s) => s.delivery_date && s.delivery_date.getTime() < tMs);
    const woStatus: Record<string, number> = {};
    for (const r of await tx.workOrder.groupBy({ by: ['status'], _count: { _all: true } })) woStatus[r.status] = r._count._all;
    const wip = await tx.workOrder.findMany({
      where: { status: { in: ['RELEASED', 'IN_PROGRESS'] } }, select: { planned_qty: true, completed_qty: true, scrap_qty: true },
    });
    const wipQty = wip.reduce((s, w) => s + w.planned_qty - w.completed_qty - w.scrap_qty, 0);

    // 近 14 天产出（序列号完工）
    const start = addDays(t, -13);
    const output = new Map<string, number>();
    for (const s of await tx.serialNumber.findMany({ where: { completed_at: { gte: localStart(start) } }, select: { completed_at: true } })) {
      const d = localDateStr(s.completed_at!);
      output.set(d, (output.get(d) ?? 0) + 1);
    }
    const days = Array.from({ length: 14 }, (_, i) => fmtDate(addDays(start, i))!);

    // 一次直通率（按工序，近 30 天，按序列号首次测试结果）
    const since = localStart(addDays(t, -30));
    const first = new Map<string, { op: string; sn: number; result: string }>();
    const names: string[] = [];
    const recs = await tx.operationRecord.findMany({
      where: { ts: { gte: since }, sn_id: { not: null } }, orderBy: { id: 'asc' }, select: { op_name: true, sn_id: true, result: true },
    });
    for (const r of recs) {
      const k = `${r.op_name}\u0000${r.sn_id}`;
      if (!first.has(k)) first.set(k, { op: r.op_name, sn: r.sn_id!, result: r.result });
      if (!names.includes(r.op_name)) names.push(r.op_name);
    }
    const firstVals = [...first.values()];
    const fpy = names.map((op) => {
      const res = firstVals.filter((v) => v.op === op);
      return { op_name: op, tested: res.length, fpy: pct(res.filter((v) => v.result === 'PASS').length, res.length) };
    });
    let overallFpy: number | null = null;
    if (first.size) {
      const sns = new Set(firstVals.map((v) => v.sn));
      let passedAll = 0;
      for (const sn of sns) if (firstVals.every((v) => v.sn !== sn || v.result === 'PASS')) passedAll++;
      overallFpy = pct(passedAll, sns.size);
    }

    const iqcDone = await tx.inspection.findMany({ where: { inspected_at: { gte: since } }, select: { status: true } });
    const iqcRate = iqcDone.length ? pct(iqcDone.filter((i) => i.status === 'PASSED').length, iqcDone.length) : null;
    const ncrSrc = await tx.ncr.groupBy({ by: ['source'], where: { created_at: { gte: since } }, _count: { _all: true } });

    // 在手订单金额：按币别汇总，再按今日适用汇率折算本位币（缺汇率的币别不计入，并在预警中提示）
    const book = await RateBook.load(tx);
    const soByCur = new CurrencyTotals();
    for (const o of openSo) soByCur.add(o.currency, o.total_amount);
    const soBase = soByCur.toBase(book, t);
    const openSoByCurrency = soByCur.byCurrency(book.base);

    // 库存金额（标准成本，本位币）：数量转 numeric 后与 Decimal 单价相乘，避免浮点误差
    const [{ value: stockValue }] = await tx.$queryRaw<{ value: number }[]>`
      SELECT ROUND(COALESCE(SUM(s.qty::numeric * m.std_cost), 0), 2)::float8 AS value FROM wms_stock s JOIN md_material m ON m.id = s.material_id`;
    const avail = new Map<number, number>();
    for (const r of await tx.stock.groupBy({ by: ['material_id'], where: { status: 'AVAILABLE' }, _sum: { qty: true } })) {
      avail.set(r.material_id, r._sum.qty ?? 0);
    }
    const below = (await tx.material.findMany({ where: { safety_stock: { gt: 0 }, is_active: true }, orderBy: { id: 'asc' } }))
      .filter((m) => (avail.get(m.id) ?? 0) < m.safety_stock);
    const expiring = await tx.stock.count({ where: { qty: { gt: 0 }, expiry_date: { not: null, lte: addDays(t, 30) } } });
    const calDue = await tx.equipment.findMany({
      where: { calibration_required: true, next_calibration_date: { lte: addDays(t, 30) } }, orderBy: { next_calibration_date: 'asc' },
    });
    const supExp = await tx.supplier.findMany({
      where: { status: 'QUALIFIED', qualification_expiry: { not: null, lte: addDays(t, 60) } }, orderBy: { id: 'asc' },
    });
    const expired = (d: Date | null) => !!d && d.getTime() < tMs;

    return {
      kpi: {
        open_so: openSo.length,
        open_so_amount: soBase.amount,
        open_so_by_currency: openSoByCurrency,
        base_currency: book.base,
        missing_rates: soBase.missing,
        overdue_so: overdueSo.length,
        wip_wo: (woStatus.RELEASED ?? 0) + (woStatus.IN_PROGRESS ?? 0),
        wip_qty: round2(wipQty),
        today_output: output.get(fmtDate(t)!) ?? 0,
        fpy: overallFpy,
        pending_iqc: await tx.inspection.count({ where: { status: 'PENDING' } }),
        iqc_pass_rate: iqcRate,
        open_ncr: await tx.ncr.count({ where: { status: 'OPEN' } }),
        open_capa: await tx.capa.count({ where: { status: { not: 'CLOSED' } } }),
        pending_release: await tx.workOrder.count({ where: { status: 'COMPLETED', dhr_status: 'OPEN' } }),
        stock_value: round2(Number(stockValue) || 0),
        below_safety: below.length,
        expiring_lots: expiring,
        calibration_due: calDue.length,
      },
      wo_status: woStatus,
      output_trend: days.map((d) => ({ date: d, qty: output.get(d) ?? 0 })),
      fpy_by_op: fpy,
      ncr_by_source: ncrSrc.map((r) => ({ source: r.source, count: r._count._all })),
      alerts: [
        ...soBase.missing.map((c) => ({
          level: 'warning',
          text: `缺少 ${c} → ${book.base} 汇率，在手订单金额未包含 ${c} ${(openSoByCurrency.find((x) => x.currency === c)?.amount ?? 0).toFixed(2)}（请在“基础资料 → 汇率”中维护）`,
        })),
        ...calDue.map((e) => ({
          level: expired(e.next_calibration_date) ? 'error' : 'warning',
          text: `设备 ${e.code} ${e.name} 校准${expired(e.next_calibration_date) ? '已过期' : '即将到期'}（${fmtDate(e.next_calibration_date)}）`,
        })),
        ...supExp.map((s) => ({ level: 'warning', text: `供应商 ${s.name} 资质将于 ${fmtDate(s.qualification_expiry)} 到期` })),
        ...below.slice(0, 10).map((m) => ({ level: 'warning', text: `物料 ${m.code} ${m.name} 低于安全库存（${g(avail.get(m.id) ?? 0)}/${g(m.safety_stock)}）` })),
        ...overdueSo.slice(0, 10).map((s) => ({ level: 'error', text: `销售订单 ${s.no}（${s.customer?.name ?? ''}）已逾期，交期 ${fmtDate(s.delivery_date)}` })),
      ],
    };
  }

  async todos(tx: Tx, user: CurrentUser) {
    const p = userPermissions(user);
    const items: { key: string; title: string; count: number; path: string }[] = [];
    const add = async (perm: string, key: string, title: string, count: () => Promise<number>, path: string) => {
      if (!p.has(perm)) return;
      const n = await count();
      if (n) items.push({ key, title, count: n, path });
    };
    await add('qc', 'iqc', '待检验的来料（IQC）', () => tx.inspection.count({ where: { status: 'PENDING' } }), '/quality/inspections');
    await add('qa', 'ncr', '待评审处置的不合格品（NCR）', () => tx.ncr.count({ where: { status: 'OPEN' } }), '/quality/ncrs');
    await add('qa', 'dhr', '待审核放行的生产批（DHR）', () => tx.workOrder.count({ where: { status: 'COMPLETED', dhr_status: 'OPEN' } }), '/quality/release');
    await add('qa', 'capa', '进行中的 CAPA', () => tx.capa.count({ where: { status: { not: 'CLOSED' } } }), '/quality/capas');
    await add('qa', 'complaint', '未关闭的客户投诉/不良事件', () => tx.complaint.count({ where: { status: { not: 'CLOSED' } } }), '/quality/complaints');
    await add('qa', 'bom_submitted', '待批准的 BOM', () => tx.bom.count({ where: { status: 'SUBMITTED' } }), '/engineering/boms?status=SUBMITTED');
    await add('qa', 'routing_submitted', '待批准的工艺路线', () => tx.routing.count({ where: { status: 'SUBMITTED' } }), '/engineering/routings?status=SUBMITTED');
    await add('plan', 'so_no_wo', '已确认待排产的销售订单', () => tx.salesOrder.count({ where: { status: 'CONFIRMED' } }), '/sales/orders');
    await add('plan', 'wo_planned', '待下达的生产工单', () => tx.workOrder.count({ where: { status: 'PLANNED' } }), '/mes/work-orders');
    await add('purchase', 'po_draft', '待审批的采购订单', () => tx.purchaseOrder.count({ where: { status: 'DRAFT' } }), '/purchase/orders');
    await add('wms', 'po_receive', '待收货的采购订单', () => tx.purchaseOrder.count({ where: { status: { in: ['APPROVED', 'PARTIAL_RECEIVED'] } } }), '/purchase/orders');
    await add('wms', 'issue', '待过账的领料单', () => tx.materialIssue.count({ where: { status: 'DRAFT' } }), '/wms/issues');
    await add('wms', 'ship', '待过账的发货单', () => tx.shipment.count({ where: { status: 'DRAFT' } }), '/wms/shipments');
    await add('wms', 'fg', '待完工入库的工单', async () => {
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM mes_work_order WHERE status IN ('IN_PROGRESS', 'COMPLETED') AND completed_qty > received_qty`;
      return Number(n);
    }, '/mes/work-orders');
    await add('engineering', 'bom', '待提交的 BOM 草稿', () => tx.bom.count({ where: { status: 'DRAFT' } }), '/engineering/boms?status=DRAFT');
    await add('engineering', 'routing', '待提交的工艺路线草稿', () => tx.routing.count({ where: { status: 'DRAFT' } }), '/engineering/routings?status=DRAFT');
    await add('master', 'calib', '校准过期的设备', () => tx.equipment.count({ where: { calibration_required: true, next_calibration_date: { lt: today() } } }), '/master/equipment');
    await add('sales', 'so_draft', '待确认的销售订单', () => tx.salesOrder.count({ where: { status: 'DRAFT' } }), '/sales/orders');
    return items;
  }
}
