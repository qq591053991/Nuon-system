/**
 * 追溯：
 *   反向追溯（序列号 → 工单/批号 → 所用物料批次/供应商/IQC → 每道工序的操作人、设备、测试数据 → 发货）；
 *   正向追溯（物料批次 → 来料 → 领用到哪些工单 → 产出哪些序列号 → 发给了哪些客户），用于召回范围评估。
 */
import { Injectable } from '@nestjs/common';
import { BizError } from '../common/errors';
import { EPS, round } from '../common/num';

/** 退料单（RETURN）冲减领用数量 */
const signed = (ln: { qty: number; issue: { issue_type: string } }) => (ln.issue.issue_type === 'RETURN' ? -ln.qty : ln.qty);
import { like } from '../common/paginate';
import type { Tx } from '../common/prisma.service';
import { keyPartRows } from '../mes/key-parts';

const partnerName = (rc: { supplier?: { name: string } | null; customer?: { name: string } | null }) =>
  rc.supplier ? rc.supplier.name : rc.customer?.name ?? null;

@Injectable()
export class TraceService {
  /** 工单实际领用的物料批次（含来料单、供应商、IQC 结论） */
  private async woMaterials(tx: Tx, woId: number) {
    const rows = new Map<string, Record<string, any>>();
    const lines = await tx.materialIssueLine.findMany({
      where: { issue: { wo_id: woId, status: 'CONFIRMED' } }, orderBy: { id: 'asc' }, include: { material: true, issue: true },
    });
    for (const ln of lines) {
      const k = `${ln.material_id}\u0000${ln.lot_no}`;
      let r = rows.get(k);
      if (!r) {
        r = {
          material_id: ln.material_id, material_code: ln.material.code, material_name: ln.material.name,
          lot_no: ln.lot_no, qty: 0, customer_supplied: !!ln.owner_customer_id,
        };
        rows.set(k, r);
      }
      r.qty = round(r.qty + signed(ln), 4);
    }
    // 已全部退回的批次没有用到产品上，不计入追溯
    for (const [k, r] of rows) if (r.qty <= EPS) rows.delete(k);
    for (const r of rows.values()) {
      const rl = await tx.receiptLine.findFirst({
        where: { material_id: r.material_id, lot_no: r.lot_no }, orderBy: { id: 'asc' },
        include: { receipt: { include: { supplier: true, customer: true } } },
      });
      if (rl) {
        Object.assign(r, { receipt_no: rl.receipt.no, receipt_date: rl.receipt.receipt_date, supplier_name: partnerName(rl.receipt), supplier_lot: rl.supplier_lot });
      }
      const insp = await tx.inspection.findFirst({ where: { material_id: r.material_id, lot_no: r.lot_no }, orderBy: { id: 'desc' } });
      if (insp) Object.assign(r, { iqc_no: insp.no, iqc_status: insp.status });
    }
    return [...rows.values()];
  }

  async traceSerial(tx: Tx, snText: string) {
    const sn = await tx.serialNumber.findUnique({ where: { sn: (snText || '').trim() }, include: { release: true } });
    if (!sn) throw new BizError(`序列号 ${snText} 不存在`);
    const wo = await tx.workOrder.findUniqueOrThrow({
      where: { id: sn.wo_id }, include: { material: true, customer: true, sales_order: true, bom: true, routing: true },
    });
    const recs = await tx.operationRecord.findMany({
      where: { sn_id: sn.id }, orderBy: { id: 'asc' }, include: { equipment: true, values: { orderBy: { id: 'asc' } } },
    });
    // 关键件：装配绑定 + 返工换件（拆下/装上，关联 NCR）
    const kps = await keyPartRows(tx, { sn_id: sn.id });
    const sh = sn.shipment_id
      ? await tx.shipment.findUnique({ where: { id: sn.shipment_id }, include: { customer: true, sales_order: true } })
      : null;
    const ncrs = await tx.ncr.findMany({ where: { sn: sn.sn }, orderBy: { id: 'asc' } });
    return {
      serial: {
        sn: sn.sn, udi: sn.udi, status: sn.status, lot_no: sn.lot_no, completed_at: sn.completed_at, shipped_at: sn.shipped_at,
        // 放行批（DHR 分批放行）：release_status = RELEASED 才能发货
        release_no: sn.release?.no ?? null, release_status: sn.release?.status ?? null,
        released_at: sn.release?.released_at ?? null, released_by: sn.release?.released_by ?? null,
      },
      product: { code: wo.material.code, name: wo.material.name, model: wo.material.model, registration_no: wo.material.registration_no },
      work_order: {
        id: wo.id, no: wo.no, lot_no: wo.lot_no, customer_name: wo.customer?.name ?? null, so_no: wo.sales_order?.no ?? null,
        dhr_status: wo.dhr_status, bom_version: wo.bom?.version ?? null, routing_version: wo.routing?.version ?? null,
      },
      materials: await this.woMaterials(tx, wo.id),
      key_parts: kps.map((k) => ({
        material_code: k.material_code, material_name: k.material_name, lot_no: k.lot_no, part_sn: k.part_sn, ts: k.ts,
        action: k.action, action_text: k.action_text, ncr_no: k.ncr_no, operator_name: k.operator_name, remark: k.remark,
      })),
      records: recs.map((r) => ({
        ts: r.ts, seq: r.seq, op_name: r.op_name, result: r.result, operator_name: r.operator_name,
        equipment_code: r.equipment?.code ?? null, is_rework: r.is_rework,
        values: r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit, lower: v.lower, upper: v.upper, result: v.result })),
      })),
      ncrs: ncrs.map((n) => ({ no: n.no, description: n.description, status: n.status, disposition: n.disposition })),
      shipment: sh
        ? { no: sh.no, ship_date: sh.ship_date, customer_name: sh.customer?.name ?? null, so_no: sh.sales_order?.no ?? null, carrier: sh.carrier, tracking_no: sh.tracking_no }
        : null,
    };
  }

  async traceLot(tx: Tx, materialCode: string, lotNoRaw: string) {
    const m = await tx.material.findUnique({ where: { code: (materialCode || '').trim() } });
    if (!m) throw new BizError(`物料 ${materialCode} 不存在`);
    const lotNo = (lotNoRaw || '').trim();
    const receipts = [];
    const rls = await tx.receiptLine.findMany({
      where: { material_id: m.id, lot_no: lotNo }, orderBy: { id: 'asc' }, include: { receipt: { include: { supplier: true, customer: true } } },
    });
    for (const rl of rls) {
      const insp = rl.inspection_id ? await tx.inspection.findUnique({ where: { id: rl.inspection_id } }) : null;
      receipts.push({
        receipt_no: rl.receipt.no, receipt_type: rl.receipt.receipt_type, receipt_date: rl.receipt.receipt_date,
        partner_name: partnerName(rl.receipt), qty: rl.qty, supplier_lot: rl.supplier_lot,
        iqc_no: insp?.no ?? null, iqc_status: insp?.status ?? null,
      });
    }
    const stock = (await tx.stock.findMany({ where: { material_id: m.id, lot_no: lotNo }, orderBy: { id: 'asc' }, include: { location: true } }))
      .map((s) => ({ location_code: s.location?.code ?? null, status: s.status, qty: s.qty }));
    // 领用到哪些工单（含关键件绑定）
    const woIds = new Map<number, number>();
    const issued = await tx.materialIssueLine.findMany({
      where: { material_id: m.id, lot_no: lotNo, issue: { status: 'CONFIRMED' } }, orderBy: { id: 'asc' }, include: { issue: true },
    });
    for (const ln of issued) woIds.set(ln.issue.wo_id, round((woIds.get(ln.issue.wo_id) ?? 0) + signed(ln), 4));
    // 该批次已全部退回的工单不受影响（召回范围不应扩大）
    for (const [wid, q] of woIds) if (q <= EPS) woIds.delete(wid);
    // 该批号本身就是成品生产批
    for (const wo of await tx.workOrder.findMany({ where: { material_id: m.id, lot_no: lotNo }, orderBy: { id: 'asc' } })) {
      if (!woIds.has(wo.id)) woIds.set(wo.id, 0);
    }
    // 返工换件补领（REWORK_ISSUE，关联 NCR → 工单）
    const reworkMoves = await tx.stockMove.findMany({ where: { material_id: m.id, lot_no: lotNo, move_type: 'REWORK_ISSUE', ref_type: 'NCR' }, orderBy: { id: 'asc' } });
    const reworkNcrIds = [...new Set(reworkMoves.map((mv) => mv.ref_id).filter((x): x is number => !!x))];
    const ncrWo = new Map(
      (reworkNcrIds.length ? await tx.ncr.findMany({ where: { id: { in: reworkNcrIds } }, select: { id: true, wo_id: true } }) : []).map((n) => [n.id, n.wo_id]),
    );
    for (const mv of reworkMoves) {
      const wid = mv.ref_id ? ncrWo.get(mv.ref_id) : null;
      if (wid) woIds.set(wid, round((woIds.get(wid) ?? 0) + mv.qty, 4));
    }
    // 关键件：装配绑定/返工装上 = 该台含此批次；返工拆下 = 已从该台拆除
    const kpRows = await tx.keyPartBinding.findMany({ where: { material_id: m.id, lot_no: lotNo }, select: { sn_id: true, action: true } });
    const kpSns = new Set(kpRows.filter((k) => k.action !== 'REMOVE').map((k) => k.sn_id));
    const kpRemoved = new Set(kpRows.filter((k) => k.action === 'REMOVE').map((k) => k.sn_id));
    const shipments = new Map<number, any>();
    const getShipment = async (id: number) => {
      if (!shipments.has(id)) shipments.set(id, await tx.shipment.findUnique({ where: { id }, include: { customer: true } }));
      return shipments.get(id);
    };
    const workOrders = [];
    const serials = [];
    const customers = new Map<string | null, number>();
    for (const [wid, qty] of woIds) {
      const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: wid }, include: { material: true } });
      const sns = await tx.serialNumber.findMany({ where: { wo_id: wid }, orderBy: { sn: 'asc' } });
      workOrders.push({
        id: wo.id, no: wo.no, lot_no: wo.lot_no, product_code: wo.material.code, product_name: wo.material.name,
        issued_qty: qty, status: wo.status, serial_count: sns.length, shipped_count: sns.filter((s) => s.status === 'SHIPPED').length,
      });
      for (const s of sns) {
        const sh = s.shipment_id ? await getShipment(s.shipment_id) : null;
        const customerName: string | null = sh ? sh.customer?.name ?? null : null;
        if (sh) customers.set(customerName, (customers.get(customerName) ?? 0) + 1);
        serials.push({
          sn: s.sn, wo_no: wo.no, status: s.status, key_part_bound: kpSns.has(s.id), key_part_removed: kpRemoved.has(s.id),
          shipment_no: sh?.no ?? null, customer_name: customerName, ship_date: sh?.ship_date ?? null,
        });
      }
    }
    return {
      material: { code: m.code, name: m.name, spec: m.spec }, lot_no: lotNo, receipts, stock, work_orders: workOrders, serials,
      customers: [...customers].map(([customer_name, qty]) => ({ customer_name, qty })),
      summary: { work_orders: workOrders.length, serials: serials.length, shipped: serials.filter((s) => s.shipment_no).length, customers: customers.size },
    };
  }

  /** 全局搜索：单号、序列号、批号、物料编码/名称一框搞定。 */
  async globalSearch(tx: Tx, qRaw: string | null | undefined, limit = 8) {
    const q = (qRaw || '').trim();
    if (!q) return [];
    const lk = like(q);
    const take = limit;
    const orderBy = { id: 'asc' as const };
    const out: Record<string, any>[] = [];
    for (const m of await tx.material.findMany({ where: { OR: [{ code: lk }, { name: lk }] }, take, orderBy })) {
      out.push({ type: 'material', type_text: '物料', id: m.id, title: `${m.code} ${m.name}`, sub: m.spec });
    }
    for (const s of await tx.serialNumber.findMany({ where: { sn: lk }, take, orderBy, include: { material: true } })) {
      out.push({ type: 'serial', type_text: '序列号', id: s.id, title: s.sn, sub: `${s.material?.name ?? ''} · ${s.status}` });
    }
    for (const w of await tx.workOrder.findMany({ where: { OR: [{ no: lk }, { lot_no: lk }] }, take, orderBy, include: { material: true } })) {
      out.push({ type: 'work_order', type_text: '生产工单', id: w.id, title: w.no, sub: `${w.material?.name ?? ''} 批号 ${w.lot_no || '-'}` });
    }
    for (const o of await tx.salesOrder.findMany({ where: { OR: [{ no: lk }, { customer_po: lk }] }, take, orderBy, include: { customer: true } })) {
      out.push({ type: 'sales_order', type_text: '销售订单', id: o.id, title: o.no, sub: o.customer?.name ?? null });
    }
    for (const o of await tx.purchaseOrder.findMany({ where: { no: lk }, take, orderBy, include: { supplier: true } })) {
      out.push({ type: 'purchase_order', type_text: '采购订单', id: o.id, title: o.no, sub: o.supplier?.name ?? null });
    }
    for (const n of await tx.ncr.findMany({ where: { no: lk }, take, orderBy })) {
      out.push({ type: 'ncr', type_text: '不合格品', id: n.id, title: n.no, sub: (n.description || '').slice(0, 40) });
    }
    for (const i of await tx.inspection.findMany({ where: { no: lk }, take, orderBy, include: { material: true } })) {
      out.push({ type: 'inspection', type_text: '检验单', id: i.id, title: i.no, sub: i.material?.name ?? null });
    }
    for (const sh of await tx.shipment.findMany({ where: { no: lk }, take, orderBy, include: { customer: true } })) {
      out.push({ type: 'shipment', type_text: '发货单', id: sh.id, title: sh.no, sub: sh.customer?.name ?? null });
    }
    const lots = await tx.$queryRaw<{ lot_no: string; code: string; name: string }[]>`
      SELECT DISTINCT s.lot_no, m.code, m.name FROM wms_stock s JOIN md_material m ON m.id = s.material_id
      WHERE s.lot_no ILIKE ${`%${q}%`} ORDER BY s.lot_no, m.code LIMIT ${take}`;
    for (const r of lots) {
      out.push({ type: 'lot', type_text: '批次', id: null, title: r.lot_no, sub: `${r.code} ${r.name}`, material_code: r.code });
    }
    return out;
  }
}
