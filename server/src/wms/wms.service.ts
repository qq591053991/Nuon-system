/**
 * 仓储业务服务（移植自 backend/app/services/wms.py）：采购收货/客供料收货（自动生成 IQC）、生产领料（FEFO + 客供料隔离）、
 * 发货（仅已放行产品）、调拨、盘点，并自动生成应付/应收。
 *
 * 导出方法（tx = 事务客户端，对应 Python 的 db；工单/领料单/销售订单/发货单/盘点单既可传 id 也可传带 id 的记录，方法内会在 tx 中重新读取）：
 *   receive(tx, user, { receipt_type, lines, supplier_id?, customer_id?, po?, delivery_note?, remark? })
 *       → Receipt & { lines }                      收货（采购/客供料/期初/其他）；采购收货更新订单状态并生成应付
 *   createIssue(tx, user, wo, lines?)            → { issue, shortages }   生成领料单（lines 为空 = 按 FEFO 自动分配）
 *   confirmIssue(tx, user, issue)                → MaterialIssue & { lines }  领料过账（扣库存、更新工单已领数量）
 *   availableSerials(tx, materialId, limit=500)  → SerialNumber[]（含 work_order） 可发货序列号（已入库且 DHR 已放行）
 *   createShipment(tx, user, so, lines, { carrier, tracking_no, ship_to, remark }?)
 *       → Shipment & { lines }                     创建发货单（序列号逐台校验放行状态，非序列号产品按 FEFO 分配合格库存）
 *   confirmShipment(tx, user, sh)                → Shipment & { lines }   发货过账（扣库存、序列号出库、更新订单、生成应收）
 *   transfer(tx, user, stockId, qty, toLocationId, remark?) → Stock   库位调拨
 *   createCount(tx, user, warehouseId, remark?)  → StockCount & { lines }  创建盘点单（账面快照）
 *   postCount(tx, user, sc)                      → StockCount & { lines }  盘点过账（差异调整）
 * 返回的记录已按 presenter 视图 include，可直接 ser('Receipt', rc, ['lines']) 等。
 *
 * 在 Nest 容器外（如演示数据脚本）手工构造：
 *   const inv = new InventoryService(), numbering = new NumberingService();
 *   const wms = new WmsService(inv, numbering, new QualityService(inv, numbering, new EsignService()));
 */
import { Injectable } from '@nestjs/common';
import type { MaterialIssue, MaterialIssueLine, PurchaseOrder, Receipt, ReceiptLine, SerialNumber, Shipment, ShipmentLine, Stock, StockCount, StockCountLine, WorkOrder } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round, round2 } from '../common/num';
import { inc } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { InventoryService, STATUS_TEXT, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { QualityService } from '../qms/quality.service';

type IdRef = number | { id: number };
const idOf = (x: IdRef) => (typeof x === 'number' ? x : x.id);

export interface ReceiveLineInput {
  material_id: number;
  qty: number;
  location_id: number;
  po_line_id?: number | null;
  lot_no?: string | null;
  supplier_lot?: string | null;
  mfg_date?: Date | null;
  expiry_date?: Date | null;
}

export interface ReceiveArgs {
  receipt_type: 'PURCHASE' | 'CUSTOMER_SUPPLIED' | 'OPENING' | 'OTHER';
  lines: ReceiveLineInput[];
  supplier_id?: number | null;
  customer_id?: number | null;
  po?: (PurchaseOrder & { lines: { id: number; qty: number; received_qty: number; material_id: number; unit_price: number }[] }) | null;
  delivery_note?: string | null;
  remark?: string | null;
}

/** 手工指定批次领料：stock_id = 库存行 */
export interface IssueLineInput { material_id: number; stock_id: number; qty: number }

export interface IssueShortage {
  material_id: number;
  material_code: string;
  material_name: string;
  required: number;
  shortage: number;
  customer_supplied: boolean;
}

export interface ShipLineInput { so_line_id: number; qty?: number | null; serials?: string[] | null }

export interface ShipmentOptions { carrier?: string | null; tracking_no?: string | null; ship_to?: string | null; remark?: string | null }

const RECEIPT_MOVE: Record<string, string> = { PURCHASE: 'PO_RECEIPT', CUSTOMER_SUPPLIED: 'CS_RECEIPT', OPENING: 'OPENING' };

@Injectable()
export class WmsService {
  constructor(
    private readonly inv: InventoryService,
    private readonly numbering: NumberingService,
    private readonly quality: QualityService,
  ) {}

  private async lotFor(tx: Tx, lotControl: boolean, lotNo: string | null | undefined): Promise<string> {
    if (lotNo) return lotNo.trim();
    return lotControl ? this.numbering.nextNo(tx, 'L') : '';
  }

  // ---------------- 收货 ----------------

  /** 收货：需检验物料 → 待检(QUARANTINE) 并自动生成 IQC 检验单；免检/期初 → 合格。采购收货自动更新订单状态并生成应付。 */
  async receive(tx: Tx, user: CurrentUser, args: ReceiveArgs): Promise<Receipt & { lines: ReceiptLine[] }> {
    const { receipt_type, lines, po } = args;
    const supplier_id = args.supplier_id ?? null;
    const customer_id = args.customer_id ?? null;
    if (!lines?.length) throw new BizError('请至少录入一行收货明细');
    if (receipt_type === 'CUSTOMER_SUPPLIED' && !customer_id) throw new BizError('客供料收货必须指定客户（货主）');
    const rc = await tx.receipt.create({
      data: {
        no: await this.numbering.nextNo(tx, 'RK'), receipt_type, supplier_id, customer_id, po_id: po?.id ?? null,
        receipt_date: today(), status: 'CONFIRMED', delivery_note: args.delivery_note ?? null, remark: args.remark ?? null,
        created_by: user.username,
      },
    });
    const move_type = RECEIPT_MOVE[receipt_type] ?? 'OTHER_RECEIPT';
    const ref: Ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: user.username, remark: args.remark ?? null };
    let ap = 0;
    let i = 0;
    for (const ln of lines) {
      i += 1;
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!m) throw new NotFound('物料');
      const qty = Number(ln.qty || 0);
      if (qty <= 0) throw new BizError(`${m.code} 收货数量必须大于 0`);
      let owner: number | null = null;
      if (m.owner_customer_id) {
        if (!['CUSTOMER_SUPPLIED', 'OPENING', 'OTHER'].includes(receipt_type)) throw new BizError(`${m.code} 是客供料，请使用“客供料收货”`);
        if (customer_id && m.owner_customer_id !== customer_id) throw new BizError(`${m.code} 的货主不是该客户`);
        owner = m.owner_customer_id;
      } else if (receipt_type === 'CUSTOMER_SUPPLIED') {
        throw new BizError(`${m.code} 不是该客户的客供料（请在物料主数据中设置货主）`);
      }
      let poLineId: number | null = null;
      if (po) {
        const pl = ln.po_line_id ? await tx.purchaseOrderLine.findUnique({ where: { id: ln.po_line_id } }) : null;
        if (!pl || pl.order_id !== po.id) throw new BizError('采购订单行不匹配');
        if (pl.material_id !== m.id) throw new BizError('收货物料与订单行物料不一致');
        const remain = round(pl.qty - (pl.received_qty || 0));
        if (qty > remain * 1.05 + EPS) throw new BizError(`${m.code} 超收：订单剩余 ${g(remain)}，本次 ${g(qty)}（允许超收 5%）`); // 允许 5% 超收
        await tx.purchaseOrderLine.update({ where: { id: pl.id }, data: { received_qty: round((pl.received_qty || 0) + qty) } });
        ap += qty * (pl.unit_price || 0);
        poLineId = pl.id;
      }
      const locId = ln.location_id;
      if (!locId || !(await tx.location.findUnique({ where: { id: locId } }))) throw new BizError(`${m.code} 请选择收货库位`);
      const status = m.iqc_required && receipt_type !== 'OPENING' ? 'QUARANTINE' : 'AVAILABLE';
      const lot = await this.lotFor(tx, m.lot_control, ln.lot_no);
      const mfg = dateOnly(ln.mfg_date);
      const exp = dateOnly(ln.expiry_date) ?? (mfg && m.shelf_life_days ? addDays(mfg, m.shelf_life_days) : null);
      const rl = await tx.receiptLine.create({
        data: {
          receipt_id: rc.id, line_no: i, material_id: m.id, po_line_id: poLineId, qty, lot_no: lot, supplier_lot: ln.supplier_lot ?? null,
          location_id: locId, status, mfg_date: mfg, expiry_date: exp,
        },
      });
      await this.inv.addStock(tx, {
        material_id: m.id, location_id: locId, lot_no: lot, status, qty, move_type, ref, owner_customer_id: owner,
        mfg_date: mfg, expiry_date: exp, supplier_id, supplier_lot: ln.supplier_lot ?? null,
      });
      if (status === 'QUARANTINE') await this.quality.createIqc(tx, { receipt: rc, line: rl, material: m, username: user.username });
    }
    if (po) {
      const poLines = await tx.purchaseOrderLine.findMany({ where: { order_id: po.id } });
      const done = poLines.every((l) => (l.received_qty || 0) + EPS >= l.qty);
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: done ? 'RECEIVED' : 'PARTIAL_RECEIVED' } });
      if (ap > 0) {
        const sup = await tx.supplier.findUnique({ where: { id: po.supplier_id } });
        await tx.financeDoc.create({
          data: {
            no: await this.numbering.nextNo(tx, 'AP'), doc_type: 'AP', supplier_id: po.supplier_id, ref_type: 'RECEIPT', ref_no: rc.no,
            doc_date: today(), currency: po.currency, due_date: addDays(today(), sup ? sup.payment_terms_days : 30),
            amount: round2(ap), status: 'OPEN', remark: `采购订单 ${po.no} 入库`, created_by: user.username,
          },
        });
      }
    }
    return (await tx.receipt.findUnique({ where: { id: rc.id }, include: inc('Receipt', ['lines']) })) as any;
  }

  // ---------------- 生产领料 ----------------

  private async pendingIssueQty(tx: Tx, woId: number, materialId: number): Promise<number> {
    const r = await tx.materialIssueLine.aggregate({
      where: { material_id: materialId, issue: { wo_id: woId, status: 'DRAFT' } },
      _sum: { qty: true },
    });
    return round(r._sum.qty ?? 0);
  }

  private checkStockUsable(st: Stock, wo: WorkOrder) {
    if (st.status !== 'AVAILABLE') throw new BizError(`批次 ${st.lot_no} 质量状态为【${STATUS_TEXT[st.status] ?? st.status}】，不能领用`);
    if (st.owner_customer_id && st.owner_customer_id !== wo.customer_id) throw new BizError(`批次 ${st.lot_no} 为其他客户的客供料，不能用于本工单`);
    if (st.expiry_date && st.expiry_date.getTime() < today().getTime()) throw new BizError(`批次 ${st.lot_no} 已过期（${fmtDate(st.expiry_date)}），禁止使用`);
  }

  /** 生成领料单：lines 为空 = 系统按 FEFO 自动分配（扣除未过账领料单占用）；客供料只能用于该客户工单。返回领料单与缺料清单 */
  async createIssue(tx: Tx, user: CurrentUser, woRef: IdRef, lines?: IssueLineInput[] | null): Promise<{ issue: MaterialIssue & { lines: MaterialIssueLine[] }; shortages: IssueShortage[] }> {
    const wo = await tx.workOrder.findUnique({
      where: { id: idOf(woRef) },
      include: { materials: { include: { material: true }, orderBy: { id: 'asc' } } },
    });
    if (!wo) throw new NotFound('工单');
    if (!['RELEASED', 'IN_PROGRESS'].includes(wo.status)) throw new BizError('工单未下达或已完工，不能领料');
    const no = await this.numbering.nextNo(tx, 'LL');
    const shortages: IssueShortage[] = [];
    const out: { material_id: number; lot_no: string; location_id: number; owner_customer_id: number | null; qty: number; expiry_date: Date | null }[] = [];
    const woMats = new Map(wo.materials.map((m) => [m.material_id, m]));
    if (lines?.length) {
      // 手工指定批次
      for (const ln of lines) {
        const m = woMats.get(ln.material_id);
        if (!m) throw new BizError('非本工单 BOM 物料，不能领用');
        const st = ln.stock_id ? await tx.stock.findUnique({ where: { id: ln.stock_id } }) : null;
        if (!st || st.material_id !== m.material_id) throw new BizError('请选择有效的库存批次');
        this.checkStockUsable(st, wo);
        out.push({
          material_id: st.material_id, lot_no: st.lot_no, location_id: st.location_id, owner_customer_id: st.owner_customer_id,
          qty: Number(ln.qty), expiry_date: st.expiry_date,
        });
      }
    } else {
      // 系统按 FEFO 自动分配
      for (const m of wo.materials) {
        const need = round(m.required_qty - (m.issued_qty || 0) - (await this.pendingIssueQty(tx, wo.id, m.material_id)));
        if (need <= EPS) continue;
        const mat = m.material;
        if (mat.owner_customer_id && mat.owner_customer_id !== wo.customer_id) throw new BizError(`${mat.code} 为其他客户的客供料，不能用于本工单`);
        const { alloc, short } = await this.inv.allocate(tx, m.material_id, need);
        for (const [st, q] of alloc) {
          out.push({
            material_id: st.material_id, lot_no: st.lot_no, location_id: st.location_id, owner_customer_id: st.owner_customer_id,
            qty: q, expiry_date: st.expiry_date,
          });
        }
        if (short > EPS) {
          shortages.push({
            material_id: m.material_id, material_code: mat.code, material_name: mat.name, required: need, shortage: short,
            customer_supplied: !!mat.owner_customer_id,
          });
        }
      }
    }
    if (!out.length) {
      throw new BizError('没有可领用的合格库存' + (shortages.length ? `（缺料：${shortages.map((s) => s.material_code).join('、')}）` : '，物料已领齐'));
    }
    const issue = await tx.materialIssue.create({
      data: { no, wo_id: wo.id, status: 'DRAFT', created_by: user.username, lines: { create: out } },
      include: inc('MaterialIssue', ['lines']),
    });
    return { issue: issue as any, shortages };
  }

  /** 领料过账：按领料单批次扣减合格库存（WO_ISSUE），累加工单已领数量 */
  async confirmIssue(tx: Tx, user: CurrentUser, issueRef: IdRef): Promise<MaterialIssue & { lines: MaterialIssueLine[] }> {
    const id = idOf(issueRef);
    const issue = await tx.materialIssue.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: 'asc' } }, work_order: { include: { materials: true } } },
    });
    if (!issue) throw new NotFound('领料单');
    if (issue.status !== 'DRAFT') throw new BizError('领料单已过账或已取消');
    const wo = issue.work_order;
    if (!['RELEASED', 'IN_PROGRESS'].includes(wo.status)) throw new BizError('工单状态不允许领料');
    const woMats = new Map(wo.materials.map((m) => [m.material_id, m]));
    const ref: Ref = { ref_type: 'ISSUE', ref_id: issue.id, ref_no: issue.no, username: user.username, remark: `工单 ${wo.no} 领料` };
    const t = today().getTime();
    for (const ln of issue.lines) {
      const wm = woMats.get(ln.material_id);
      if (!wm) throw new BizError('非本工单 BOM 物料，不能领用');
      if (ln.owner_customer_id && ln.owner_customer_id !== wo.customer_id) throw new BizError('客供料只能用于该客户工单');
      if (ln.expiry_date && ln.expiry_date.getTime() < t) throw new BizError(`批次 ${ln.lot_no} 已过期，禁止使用`);
      await this.inv.removeStock(tx, {
        material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty,
        owner_customer_id: ln.owner_customer_id, move_type: 'WO_ISSUE', ref,
      });
      wm.issued_qty = round((wm.issued_qty || 0) + ln.qty);
      await tx.workOrderMaterial.update({ where: { id: wm.id }, data: { issued_qty: wm.issued_qty } });
    }
    return (await tx.materialIssue.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmed_by: user.full_name, confirmed_at: new Date() },
      include: inc('MaterialIssue', ['lines']),
    })) as any;
  }

  // ---------------- 发货 ----------------

  /** 可发货序列号：已入库(IN_STOCK) 且所在工单 DHR 已放行，按完工先后 */
  availableSerials(tx: Tx, materialId: number, limit = 500): Promise<(SerialNumber & { work_order: WorkOrder })[]> {
    return tx.serialNumber.findMany({
      where: { material_id: materialId, status: 'IN_STOCK', work_order: { dhr_status: 'RELEASED' } },
      orderBy: [{ completed_at: 'asc' }, { sn: 'asc' }],
      take: Math.max(0, Math.trunc(limit)),
      include: { work_order: true },
    });
  }

  /** 创建发货单（草稿）：序列号产品逐台校验（在库 + DHR 已放行），未扫描时按完工先后自动带出；非序列号产品按 FEFO 分配合格库存 */
  async createShipment(tx: Tx, user: CurrentUser, soRef: IdRef, lines: ShipLineInput[], opts: ShipmentOptions = {}): Promise<Shipment & { lines: ShipmentLine[] }> {
    const so = await tx.salesOrder.findUnique({ where: { id: idOf(soRef) } });
    if (!so) throw new NotFound('销售订单');
    if (!['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'].includes(so.status)) throw new BizError('销售订单未确认或已完结，不能发货');
    const no = await this.numbering.nextNo(tx, 'FH');
    const out: { so_line_id: number; material_id: number; lot_no: string; location_id: number; qty: number; serials?: string }[] = [];
    for (const ln of lines ?? []) {
      const sol = await tx.salesOrderLine.findUnique({ where: { id: ln.so_line_id }, include: { material: true } });
      if (!sol || sol.order_id !== so.id) throw new BizError('订单行不匹配');
      let qty = Number(ln.qty || 0);
      let serials = (ln.serials ?? []).filter((s) => s && s.trim()).map((s) => s.trim());
      const m = sol.material;
      if (m.serial_control) {
        if (!serials.length) serials = (await this.availableSerials(tx, m.id, Math.trunc(qty))).map((s) => s.sn);
        if (qty && serials.length !== Math.trunc(qty)) {
          throw new BizError(`${m.code} 发货数量 ${g(qty)} 与扫描序列号数量 ${serials.length} 不一致（可发已放行库存不足？）`);
        }
        qty = serials.length;
      }
      if (qty <= 0) continue;
      const remain = round(sol.qty - (sol.shipped_qty || 0));
      if (qty > remain + EPS) throw new BizError(`${m.code} 发货数量超出订单未发数量 ${g(remain)}`);
      if (m.serial_control) {
        const groups = new Map<string, { lot: string; loc: number; sns: string[] }>();
        for (const s of serials) {
          const sn = await tx.serialNumber.findUnique({ where: { sn: s }, include: { work_order: true } });
          if (!sn || sn.material_id !== m.id) throw new BizError(`序列号 ${s} 不存在或不是物料 ${m.code}`);
          if (sn.status !== 'IN_STOCK') throw new BizError(`序列号 ${s} 状态为【${sn.status}】，不可发货`);
          if (sn.work_order.dhr_status !== 'RELEASED') throw new BizError(`序列号 ${s} 所在批次 ${sn.lot_no} 尚未完成 DHR 审核放行，禁止发货`);
          const key = JSON.stringify([sn.lot_no || '', sn.location_id]);
          if (!groups.has(key)) groups.set(key, { lot: sn.lot_no || '', loc: sn.location_id!, sns: [] });
          groups.get(key)!.sns.push(s);
        }
        for (const { lot, loc, sns } of groups.values()) {
          out.push({ so_line_id: sol.id, material_id: m.id, lot_no: lot, location_id: loc, qty: sns.length, serials: JSON.stringify(sns) });
        }
      } else {
        const { alloc, short } = await this.inv.allocate(tx, m.id, qty);
        if (short > EPS) throw new BizError(`${m.code} 合格可发库存不足，缺 ${g(short)}`);
        for (const [st, q] of alloc) out.push({ so_line_id: sol.id, material_id: m.id, lot_no: st.lot_no, location_id: st.location_id, qty: q });
      }
    }
    if (!out.length) throw new BizError('请录入发货明细');
    return (await tx.shipment.create({
      data: {
        no, so_id: so.id, customer_id: so.customer_id, status: 'DRAFT', carrier: opts.carrier ?? null, tracking_no: opts.tracking_no ?? null,
        ship_to: opts.ship_to || so.ship_to || null, remark: opts.remark ?? null, created_by: user.username, lines: { create: out },
      },
      include: inc('Shipment', ['lines']),
    })) as any;
  }

  /** 发货过账：扣减合格库存（SHIPMENT）、序列号出库（SHIPPED，记录客户）、更新订单已发数量/状态、生成应收 */
  async confirmShipment(tx: Tx, user: CurrentUser, shRef: IdRef): Promise<Shipment & { lines: ShipmentLine[] }> {
    const id = idOf(shRef);
    const sh = await tx.shipment.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: 'asc' }, include: { material: true } }, sales_order: { include: { customer: true } } },
    });
    if (!sh) throw new NotFound('发货单');
    if (sh.status !== 'DRAFT') throw new BizError('发货单已过账或已取消');
    const so = sh.sales_order;
    const ref: Ref = { ref_type: 'SHIPMENT', ref_id: sh.id, ref_no: sh.no, username: user.username, remark: `销售订单 ${so ? so.no : ''} 发货` };
    let ar = 0;
    for (const ln of sh.lines) {
      const sol = ln.so_line_id ? await tx.salesOrderLine.findUnique({ where: { id: ln.so_line_id } }) : null;
      if (sol && ln.qty > round(sol.qty - (sol.shipped_qty || 0)) + EPS) throw new BizError(`${ln.material.code} 发货数量超出订单未发数量`);
      await this.inv.removeStock(tx, {
        material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty, move_type: 'SHIPMENT', ref,
      });
      const serials: string[] = ln.serials ? JSON.parse(ln.serials) : [];
      for (const s of serials) {
        const sn = await tx.serialNumber.findUnique({ where: { sn: s } });
        if (!sn || sn.status !== 'IN_STOCK') throw new BizError(`序列号 ${s} 状态已变更，不可发货`);
        await tx.serialNumber.update({
          where: { id: sn.id },
          data: { status: 'SHIPPED', shipment_id: sh.id, customer_id: sh.customer_id, shipped_at: new Date(), location_id: null },
        });
      }
      if (sol) {
        await tx.salesOrderLine.update({ where: { id: sol.id }, data: { shipped_qty: round((sol.shipped_qty || 0) + ln.qty) } });
        ar += ln.qty * (sol.unit_price || 0);
      }
    }
    await tx.shipment.update({ where: { id }, data: { status: 'SHIPPED', ship_date: today(), shipped_by: user.full_name } });
    if (so) {
      const soLines = await tx.salesOrderLine.findMany({ where: { order_id: so.id } });
      const done = soLines.every((l) => (l.shipped_qty || 0) + EPS >= l.qty);
      await tx.salesOrder.update({ where: { id: so.id }, data: { status: done ? 'SHIPPED' : 'PARTIAL_SHIPPED' } });
      if (ar > 0) {
        const cust = so.customer;
        await tx.financeDoc.create({
          data: {
            no: await this.numbering.nextNo(tx, 'AR'), doc_type: 'AR', customer_id: so.customer_id, ref_type: 'SHIPMENT', ref_no: sh.no,
            doc_date: today(), currency: so.currency, due_date: addDays(today(), cust ? cust.payment_terms_days : 30),
            amount: round2(ar), status: 'OPEN', remark: `销售订单 ${so.no} 发货`, created_by: user.username,
          },
        });
      }
    }
    return (await tx.shipment.findUnique({ where: { id }, include: inc('Shipment', ['lines']) })) as any;
  }

  // ---------------- 调拨 / 盘点 ----------------

  /** 库位调拨/上架：保持批次、质量状态、货主不变 */
  async transfer(tx: Tx, user: CurrentUser, stockId: number, qty: number, toLocationId: number, remark?: string | null): Promise<Stock> {
    const st = await tx.stock.findUnique({ where: { id: stockId } });
    if (!st) throw new NotFound('库存');
    if (st.location_id === toLocationId) throw new BizError('目标库位与原库位相同');
    if (!(await tx.location.findUnique({ where: { id: toLocationId } }))) throw new NotFound('目标库位');
    const no = await this.numbering.nextNo(tx, 'DB');
    return this.inv.moveStock(tx, {
      material_id: st.material_id, lot_no: st.lot_no, qty, from_location_id: st.location_id, to_location_id: toLocationId,
      from_status: st.status, to_status: st.status, move_type: 'TRANSFER', owner_customer_id: st.owner_customer_id,
      ref: { ref_type: 'TRANSFER', ref_id: null, ref_no: no, username: user.username, remark: remark ?? null },
    });
  }

  /** 创建盘点单：按仓库生成账面快照（物料+库位+批次+状态+货主） */
  async createCount(tx: Tx, user: CurrentUser, warehouseId: number, remark?: string | null): Promise<StockCount & { lines: StockCountLine[] }> {
    if (!(await tx.warehouse.findUnique({ where: { id: warehouseId } }))) throw new NotFound('仓库');
    const no = await this.numbering.nextNo(tx, 'PD');
    const stocks = await tx.stock.findMany({ where: { location: { warehouse_id: warehouseId }, qty: { gt: 0 } }, orderBy: { id: 'asc' } });
    return (await tx.stockCount.create({
      data: {
        no, warehouse_id: warehouseId, status: 'OPEN', remark: remark ?? null, created_by: user.username,
        lines: {
          create: stocks.map((st) => ({
            material_id: st.material_id, location_id: st.location_id, lot_no: st.lot_no, status: st.status,
            owner_customer_id: st.owner_customer_id, system_qty: st.qty,
          })),
        },
      },
      include: inc('StockCount', ['lines']),
    })) as any;
  }

  /** 盘点过账：所有行必须已录入实盘数量；盘盈入库 / 盘亏出库（ADJUST） */
  async postCount(tx: Tx, user: CurrentUser, scRef: IdRef): Promise<StockCount & { lines: StockCountLine[] }> {
    const id = idOf(scRef);
    const sc = await tx.stockCount.findUnique({ where: { id }, include: { lines: { orderBy: { id: 'asc' }, include: { material: true } } } });
    if (!sc) throw new NotFound('盘点单');
    if (sc.status !== 'OPEN') throw new BizError('盘点单已过账');
    const ref: Ref = { ref_type: 'STOCK_COUNT', ref_id: sc.id, ref_no: sc.no, username: user.username, remark: '盘点差异调整' };
    for (const ln of sc.lines) {
      if (ln.counted_qty === null || ln.counted_qty === undefined) throw new BizError(`${ln.material.code} 批次 ${ln.lot_no || '-'} 未录入实盘数量`);
    }
    for (const ln of sc.lines) {
      const diff = round(ln.counted_qty! - ln.system_qty);
      const k = { material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: ln.status, owner_customer_id: ln.owner_customer_id, move_type: 'ADJUST', ref };
      if (diff > 0) await this.inv.addStock(tx, { ...k, qty: diff });
      else if (diff < 0) await this.inv.removeStock(tx, { ...k, qty: -diff });
    }
    return (await tx.stockCount.update({
      where: { id },
      data: { status: 'POSTED', posted_by: user.full_name, posted_at: new Date() },
      include: inc('StockCount', ['lines']),
    })) as any;
  }
}
