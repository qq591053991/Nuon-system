/**
 * 仓储业务服务：采购收货/客供料收货（自动生成 IQC）、生产领料（FEFO + 客供料隔离）、
 * 发货（仅已放行产品）、调拨、盘点，并自动生成应付/应收。
 *
 * 导出方法（tx = 事务客户端；工单/领料单/销售订单/发货单/盘点单既可传 id 也可传带 id 的记录，方法内会在 tx 中重新读取）：
 *   receive(tx, user, { receipt_type, lines, supplier_id?, customer_id?, po?, delivery_note?, remark? })
 *       → Receipt & { lines }                      收货（采购/客供料/期初/其他）；采购收货更新订单状态并生成应付
 *   createIssue(tx, user, wo, lines?)            → { issue, shortages }   生成领料单（lines 为空 = 按 FEFO 自动分配）
 *   confirmIssue(tx, user, issue, { partial }?)  → MaterialIssue & { lines }  领料过账（扣库存、更新工单已领数量；拣料模式只过账已拣行，partial 时未拣行转新单）
 *   availableSerials(tx, materialId, limit=500)  → SerialNumber[]（含 work_order） 可发货序列号（已入库且属于已放行的放行批）
 *   createShipment(tx, user, so, lines, { carrier, tracking_no, ship_to, remark }?)
 *       → Shipment & { lines }                     创建发货单（序列号逐台校验放行状态，非序列号产品按 FEFO 分配合格库存）
 *   confirmShipment(tx, user, sh)                → Shipment & { lines }   发货过账（扣库存、序列号出库、更新订单、生成应收）
 *   transfer(tx, user, stockId, qty?, toLocationId, remark?, confirm?) → Stock   库位调拨/上架（库位放置规则校验；qty 空 = 全部）
 *   createCount(tx, user, warehouseId, remark?, { location_ids, blind }?) → StockCount & { lines }  创建盘点单（账面快照，同一范围仅一张进行中）
 *   postCount(tx, user, sc, { uncounted_as_book }?) → StockCount & { lines }  盘点过账（实盘 − 过账时当前账面）
 * 拣料、冲销、盘点辅助、扫码校验见 ops.service.ts；库位建议见 placement.ts。
 * 返回的记录已按 presenter 视图 include，可直接 ser('Receipt', rc, ['lines']) 等。
 *
 * 在 Nest 容器外（如演示数据脚本）手工构造：
 *   const inv = new InventoryService(), numbering = new NumberingService();
 *   const wms = new WmsService(inv, numbering, new QualityService(inv, numbering, new EsignService(new AuthService(db))));
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, MaterialIssue, MaterialIssueLine, PurchaseOrder, Receipt, ReceiptLine, SerialNumber, Shipment, ShipmentLine, Stock, StockCount, StockCountLine, WorkOrder } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, fmtDate, today } from '../common/dates';
import { RateBook, bookingOf } from '../erp/currency';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, num, round, round2 } from '../common/num';
import { lineAmount, MoneySum, poReceiptAmount } from '../common/money';
import { inc } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { InventoryService, STATUS_TEXT, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { QualityService } from '../qms/quality.service';
import { suggestLocation } from './placement';
import { confirmMaterialReturn } from './returns.service';

type IdRef = number | { id: number };
const idOf = (x: IdRef) => (typeof x === 'number' ? x : x.id);
/** 盘点范围（逗号分隔的库位 ID）→ 数组；为空 = 整仓 */
export const parseIds = (s?: string | null): number[] => String(s ?? '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);

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
  po?: (PurchaseOrder & { lines: { id: number; qty: number; received_qty: number; material_id: number; unit_price: Prisma.Decimal | number }[] }) | null;
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
    const ap = new MoneySum(); // 应付金额（十进制精确累加，每行按分四舍五入）
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
        ap.add(poReceiptAmount(pl, qty)); // 有采购单位时按采购单价折算，整行收齐 = 订单行金额
        poLineId = pl.id;
      }
      const locId = ln.location_id || (await suggestLocation(tx, m))?.id;
      if (!locId || !(await tx.location.findUnique({ where: { id: locId } }))) throw new BizError(`${m.code} 请选择收货库位`);
      // 库位放置规则：自有料不能进客供料仓、客供料不能进自有仓（按货主判断）
      const place = await this.inv.checkPlacement(tx, { material_id: m.id, location_id: locId, owner_customer_id: owner });
      if (place.errors.length) throw new BizError(`第 ${i} 行：${place.errors.join('；')}`);
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
      if (ap.value > 0) {
        const sup = await tx.supplier.findUnique({ where: { id: po.supplier_id } });
        await tx.financeDoc.create({
          data: {
            no: await this.numbering.nextNo(tx, 'AP'), doc_type: 'AP', supplier_id: po.supplier_id, ref_type: 'RECEIPT', ref_no: rc.no,
            doc_date: today(), currency: po.currency, due_date: addDays(today(), sup ? sup.payment_terms_days : 30),
            amount: ap.value, ...bookingOf(await RateBook.load(tx), ap.value, po.currency, today()), // 记账汇率与本位币金额
            status: 'OPEN', remark: `采购订单 ${po.no} 入库`, created_by: user.username,
          },
        });
      }
    }
    return (await tx.receipt.findUnique({ where: { id: rc.id }, include: inc('Receipt', ['lines']) })) as any;
  }

  // ---------------- 生产领料 ----------------

  private async pendingIssueQty(tx: Tx, woId: number, materialId: number): Promise<number> {
    const r = await tx.materialIssueLine.aggregate({
      where: { material_id: materialId, issue: { wo_id: woId, status: 'DRAFT', issue_type: 'ISSUE' } }, // 未过账退料单不算待领
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
      const drafts = await tx.materialIssue.findMany({ where: { wo_id: wo.id, status: 'DRAFT', issue_type: 'ISSUE' }, orderBy: { id: 'asc' } });
      if (drafts.length && !shortages.length) {
        throw new BizError(`工单 ${wo.no} 已有待过账领料单 ${drafts.map((d) => d.no).join('、')}，未领物料都已在单上。请到“生产领料”拣料过账，或作废后重新生成`);
      }
      if (shortages.length) {
        throw new BizError(`没有可领用的合格库存（缺料：${shortages.map((s) => s.material_code).join('、')}）` +
          (drafts.length ? `；已有待过账领料单 ${drafts.map((d) => d.no).join('、')}` : ''));
      }
      throw new BizError(`工单 ${wo.no} 的物料已全部领齐（已过账），无需再生成领料单`);
    }
    const issue = await tx.materialIssue.create({
      data: { no, wo_id: wo.id, status: 'DRAFT', created_by: user.username, lines: { create: out } },
      include: inc('MaterialIssue', ['lines']),
    });
    return { issue: issue as any, shortages };
  }

  /**
   * 领料过账：按领料单批次扣减合格库存（WO_ISSUE），累加工单已领数量。
   * 拣料模式（行已录实拣数 picked_qty）：只过账已拣行；仍有未拣行时须 partial=true（部分过账），未拣行转入新的待过账领料单。
   */
  async confirmIssue(tx: Tx, user: CurrentUser, issueRef: IdRef, opts: { partial?: boolean } = {}): Promise<MaterialIssue & { lines: MaterialIssueLine[] }> {
    const id = idOf(issueRef);
    await tx.$queryRaw`SELECT id FROM wms_issue WHERE id = ${id} FOR UPDATE`; // 防止并发重复过账
    const head = await tx.materialIssue.findUnique({ where: { id }, include: { lines: { orderBy: { id: 'asc' }, include: { location: true } } } });
    if (head && head.issue_type !== 'RETURN' && head.status === 'DRAFT' && head.lines.some((l) => l.picked_qty !== null)) {
      const unpicked = head.lines.filter((l) => l.picked_qty === null);
      if (unpicked.length && !opts.partial) {
        throw new BizError(`还有 ${unpicked.length} 行未拣（库位 ${[...new Set(unpicked.map((l) => l.location?.code))].join('、')}），请继续拣料；或选择“部分过账”，未拣行转入新领料单`);
      }
      if (unpicked.length) {
        const rest = await tx.materialIssue.create({
          data: { no: await this.numbering.nextNo(tx, 'LL'), wo_id: head.wo_id, status: 'DRAFT', created_by: user.username, remark: `由 ${head.no} 部分过账转入的未拣行` },
        });
        await tx.materialIssueLine.updateMany({ where: { id: { in: unpicked.map((l) => l.id) } }, data: { issue_id: rest.id } });
        await tx.materialIssue.update({ where: { id }, data: { remark: [head.remark, `部分过账：未拣 ${unpicked.length} 行转入 ${rest.no}`].filter(Boolean).join('；') } });
      }
    } else if (opts.partial && head?.status === 'DRAFT') {
      throw new BizError('还没有已拣的行：请先扫码拣料（录入实拣数量），再部分过账');
    }
    const issue = await tx.materialIssue.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: 'asc' } }, work_order: { include: { materials: true } } },
    });
    if (!issue) throw new NotFound('领料单');
    // 生产退料单（RETURN）：过账逻辑见 returns.service.ts（库存加回合格、扣减工单已领数量）
    if (issue.issue_type === 'RETURN') return confirmMaterialReturn(tx, this.inv, user, id);
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

  /** 可发货序列号：已入库(IN_STOCK) 且属于已放行的放行批（DHR 分批放行，release_id 不为空），按完工先后 */
  availableSerials(tx: Tx, materialId: number, limit = 500): Promise<(SerialNumber & { work_order: WorkOrder })[]> {
    return tx.serialNumber.findMany({
      where: { material_id: materialId, status: 'IN_STOCK', release_id: { not: null }, release: { status: 'RELEASED' } },
      orderBy: [{ completed_at: 'asc' }, { sn: 'asc' }],
      take: Math.max(0, Math.trunc(limit)),
      include: { work_order: true },
    });
  }

  /** 创建发货单（草稿）：序列号产品逐台校验（在库 + 属于已放行的放行批），未扫描时按完工先后自动带出；非序列号产品按 FEFO 分配合格库存 */
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
          const sn = await tx.serialNumber.findUnique({ where: { sn: s }, include: { work_order: true, release: true } });
          if (!sn || sn.material_id !== m.id) throw new BizError(`序列号 ${s} 不存在或不是物料 ${m.code}`);
          if (sn.status !== 'IN_STOCK') throw new BizError(`序列号 ${s} 状态为【${sn.status}】，不可发货`);
          if (!sn.release_id || !sn.release) throw new BizError(`序列号 ${s} 所在批次 ${sn.lot_no} 尚未完成 DHR 审核放行，禁止发货`);
          if (sn.release.status !== 'RELEASED') throw new BizError(`序列号 ${s} 所在放行批 ${sn.release.no} 已被 QA 拒绝放行（冻结），禁止发货`);
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
    await tx.$queryRaw`SELECT id FROM wms_shipment WHERE id = ${id} FOR UPDATE`; // 防止并发重复过账
    const sh = await tx.shipment.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: 'asc' }, include: { material: true } }, sales_order: { include: { customer: true } } },
    });
    if (!sh) throw new NotFound('发货单');
    if (sh.status !== 'DRAFT') throw new BizError('发货单已过账或已取消');
    const so = sh.sales_order;
    const ref: Ref = { ref_type: 'SHIPMENT', ref_id: sh.id, ref_no: sh.no, username: user.username, remark: `销售订单 ${so ? so.no : ''} 发货` };
    // 应收：同一订单行（可能分多个批次发出）先合并数量，再按“数量 × 单价”十进制计算并四舍五入到分
    const arLines = new Map<number, { qty: number; price: Prisma.Decimal }>();
    for (const ln of sh.lines) {
      const sol = ln.so_line_id ? await tx.salesOrderLine.findUnique({ where: { id: ln.so_line_id } }) : null;
      if (sol && ln.qty > round(sol.qty - (sol.shipped_qty || 0)) + EPS) throw new BizError(`${ln.material.code} 发货数量超出订单未发数量`);
      await this.inv.removeStock(tx, {
        material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty, move_type: 'SHIPMENT', ref,
      });
      const serials: string[] = ln.serials ? JSON.parse(ln.serials) : [];
      for (const s of serials) {
        const sn = await tx.serialNumber.findUnique({ where: { sn: s }, include: { release: true } });
        if (!sn || sn.status !== 'IN_STOCK') throw new BizError(`序列号 ${s} 状态已变更，不可发货`);
        if (sn.release?.status !== 'RELEASED') throw new BizError(`序列号 ${s} 未放行（DHR 未审核放行或放行批已被拒绝），禁止发货`);
        await tx.serialNumber.update({
          where: { id: sn.id },
          data: { status: 'SHIPPED', shipment_id: sh.id, customer_id: sh.customer_id, shipped_at: new Date(), location_id: null },
        });
      }
      if (sol) {
        await tx.salesOrderLine.update({ where: { id: sol.id }, data: { shipped_qty: round((sol.shipped_qty || 0) + ln.qty) } });
        const acc = arLines.get(sol.id) ?? { qty: 0, price: sol.unit_price };
        acc.qty = round(acc.qty + ln.qty);
        arLines.set(sol.id, acc);
      }
    }
    const ar = new MoneySum();
    for (const { qty, price } of arLines.values()) ar.add(lineAmount(qty, price));
    await tx.shipment.update({ where: { id }, data: { status: 'SHIPPED', ship_date: today(), shipped_by: user.full_name } });
    if (so) {
      const soLines = await tx.salesOrderLine.findMany({ where: { order_id: so.id } });
      const done = soLines.every((l) => (l.shipped_qty || 0) + EPS >= l.qty);
      await tx.salesOrder.update({ where: { id: so.id }, data: { status: done ? 'SHIPPED' : 'PARTIAL_SHIPPED' } });
      if (ar.value > 0) {
        const cust = so.customer;
        await tx.financeDoc.create({
          data: {
            no: await this.numbering.nextNo(tx, 'AR'), doc_type: 'AR', customer_id: so.customer_id, ref_type: 'SHIPMENT', ref_no: sh.no,
            doc_date: today(), currency: so.currency, due_date: addDays(today(), cust ? cust.payment_terms_days : 30),
            amount: ar.value, ...bookingOf(await RateBook.load(tx), ar.value, so.currency, today()), // 记账汇率与本位币金额
            status: 'OPEN', remark: `销售订单 ${so.no} 发货`, created_by: user.username,
          },
        });
      }
    }
    return (await tx.shipment.findUnique({ where: { id }, include: inc('Shipment', ['lines']) })) as any;
  }

  // ---------------- 调拨 / 盘点 ----------------

  /**
   * 库位调拨/上架：保持批次、质量状态、货主不变。qty 为空 = 整行全部。
   * 库位规则：自有料/客供料与仓库不匹配直接拒绝；湿敏物料放非防潮柜须 confirm=true（操作人已确认）。
   */
  async transfer(tx: Tx, user: CurrentUser, stockId: number, qty: number | null | undefined, toLocationId: number, remark?: string | null, confirm = false): Promise<Stock> {
    const st = await tx.stock.findUnique({ where: { id: stockId }, include: { location: true } });
    if (!st) throw new BizError('该库存行已不存在（可能已被领用或调走），请重新扫码');
    const loc = await tx.location.findUnique({ where: { id: toLocationId } });
    if (!loc) throw new NotFound('目标库位');
    if (st.location_id === toLocationId) throw new BizError('目标库位与原库位相同');
    const q = qty === null || qty === undefined ? st.qty : Number(qty);
    if (!(q > 0)) throw new BizError('调拨数量必须大于 0');
    const place = await this.inv.checkPlacement(tx, { material_id: st.material_id, location_id: toLocationId, owner_customer_id: st.owner_customer_id });
    if (place.errors.length) throw new BizError(place.errors.join('；'));
    if (place.warnings.length && !confirm) throw new BizError(`${place.warnings.join('；')}。如确需放入，请确认后再提交`);
    qty = q;
    const no = await this.numbering.nextNo(tx, 'DB');
    return this.inv.moveStock(tx, {
      material_id: st.material_id, lot_no: st.lot_no, qty, from_location_id: st.location_id, to_location_id: toLocationId,
      from_status: st.status, to_status: st.status, move_type: 'TRANSFER', owner_customer_id: st.owner_customer_id,
      ref: { ref_type: 'TRANSFER', ref_id: null, ref_no: no, username: user.username, remark: remark ?? null },
    });
  }

  /**
   * 创建盘点单：按仓库（或仓库内指定库位范围）生成账面快照（物料+库位+批次+状态+货主），明细按 库位→物料→批号 排序。
   * 同一仓库内盘点范围不能与另一张“进行中”的盘点单重叠（整仓与任何范围都重叠），防止重复调账。
   */
  async createCount(tx: Tx, user: CurrentUser, warehouseId: number, remark?: string | null, opts: { location_ids?: number[] | null; blind?: boolean } = {}): Promise<StockCount & { lines: StockCountLine[] }> {
    // 锁定仓库行：并发建单在此排队，保证“同一范围只有一张进行中盘点单”
    const [wh] = await tx.$queryRaw<{ id: number; name: string }[]>`SELECT id, name FROM md_warehouse WHERE id = ${warehouseId} FOR UPDATE`;
    if (!wh) throw new NotFound('仓库');
    const locIds = [...new Set((opts.location_ids ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b);
    if (locIds.length) {
      const locs = await tx.location.findMany({ where: { id: { in: locIds } } });
      const bad = locs.filter((l) => l.warehouse_id !== warehouseId);
      if (locs.length !== locIds.length) throw new BizError('盘点范围中有不存在的库位');
      if (bad.length) throw new BizError(`库位 ${bad.map((l) => l.code).join('、')} 不属于仓库 ${wh.name}`);
    }
    const open = await tx.stockCount.findMany({ where: { warehouse_id: warehouseId, status: 'OPEN' }, orderBy: { id: 'asc' } });
    for (const o of open) {
      const theirs = parseIds(o.location_ids);
      const overlap = !theirs.length || !locIds.length ? (theirs.length ? theirs : locIds) : theirs.filter((x) => locIds.includes(x));
      if (!theirs.length || !locIds.length || overlap.length) {
        const codes = overlap.length ? (await tx.location.findMany({ where: { id: { in: overlap } }, orderBy: { code: 'asc' } })).map((l) => l.code) : [];
        throw new BizError(
          `仓库 ${wh.name} 已有进行中的盘点单 ${o.no}（范围：${theirs.length ? '指定库位' : '整仓'}${codes.length ? `，重叠库位 ${codes.join('、')}` : ''}）。` +
            '同一库位同时只能有一张盘点单，请先过账或作废该盘点单',
        );
      }
    }
    const no = await this.numbering.nextNo(tx, 'PD');
    const stocks = await tx.stock.findMany({
      where: { location: { warehouse_id: warehouseId }, qty: { gt: 0 }, ...(locIds.length ? { location_id: { in: locIds } } : {}) },
      include: { location: true, material: true },
    });
    stocks.sort((a, b) => a.location.code.localeCompare(b.location.code) || a.material.code.localeCompare(b.material.code) || a.lot_no.localeCompare(b.lot_no) || a.id - b.id);
    const sc = await tx.stockCount.create({
      data: {
        no, warehouse_id: warehouseId, status: 'OPEN', remark: remark ?? null, created_by: user.username,
        location_ids: locIds.length ? locIds.join(',') : null, blind: !!opts.blind,
      },
    });
    // 逐行按排序插入（id 递增 = 库位路线顺序）
    for (const st of stocks) {
      await tx.stockCountLine.create({
        data: {
          count_id: sc.id, material_id: st.material_id, location_id: st.location_id, lot_no: st.lot_no, status: st.status,
          owner_customer_id: st.owner_customer_id, system_qty: st.qty,
        },
      });
    }
    return (await tx.stockCount.findUnique({ where: { id: sc.id }, include: inc('StockCount', ['lines']) })) as any;
  }

  /**
   * 盘点过账：调整量 = 实盘数 − 过账时的当前账面（不是建单快照），避免快照后的收发料被重复调整；盘盈入库 / 盘亏出库（ADJUST）。
   * uncounted_as_book = true：未录实盘的行按当前账面处理（不调整，需操作人确认）；否则所有行必须已录实盘。
   */
  async postCount(tx: Tx, user: CurrentUser, scRef: IdRef, opts: { uncounted_as_book?: boolean } = {}): Promise<StockCount & { lines: StockCountLine[] }> {
    const id = idOf(scRef);
    await tx.$queryRaw`SELECT id FROM wms_stock_count WHERE id = ${id} FOR UPDATE`; // 防止并发重复过账
    const sc = await tx.stockCount.findUnique({ where: { id }, include: { lines: { orderBy: { id: 'asc' }, include: { material: true, location: true } } } });
    if (!sc) throw new NotFound('盘点单');
    if (sc.status !== 'OPEN') throw new BizError(sc.status === 'CANCELLED' ? '盘点单已作废，不能过账' : '盘点单已过账');
    const ref: Ref = { ref_type: 'STOCK_COUNT', ref_id: sc.id, ref_no: sc.no, username: user.username, remark: '盘点差异调整' };
    const uncounted = sc.lines.filter((ln) => ln.counted_qty === null || ln.counted_qty === undefined);
    if (uncounted.length && !opts.uncounted_as_book) {
      const ln = uncounted[0];
      throw new BizError(`还有 ${uncounted.length} 行未录入实盘数量（如 ${ln.location.code} ${ln.material.code} 批次 ${ln.lot_no || '-'}）。请盘完，或确认“未盘行按账面”后过账`);
    }
    for (const ln of sc.lines) {
      const k = { material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: ln.status, owner_customer_id: ln.owner_customer_id };
      const book = await this.inv.lockedQty(tx, k);
      if (ln.counted_qty === null || ln.counted_qty === undefined) {
        // 未盘行按当前账面：记录实盘 = 账面，不产生调整
        await tx.stockCountLine.update({ where: { id: ln.id }, data: { counted_qty: book } });
        continue;
      }
      const diff = round(ln.counted_qty - book);
      const mk = { ...k, move_type: 'ADJUST', ref };
      if (diff > EPS) await this.inv.addStock(tx, { ...mk, qty: diff });
      else if (diff < -EPS) await this.inv.removeStock(tx, { ...mk, qty: -diff });
    }
    return (await tx.stockCount.update({
      where: { id },
      data: { status: 'POSTED', posted_by: user.full_name, posted_at: new Date() },
      include: inc('StockCount', ['lines']),
    })) as any;
  }
}
