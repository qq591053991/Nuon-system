/** 采购订单：草稿 → 审批（合格供方校验，GMP 采购控制）→ 收货（IQC、应付由仓储服务生成）→ 关闭 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, daysBetween, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { dec, lineAmount, money, MoneySum, price6 } from '../common/money';
import { EPS, g, round } from '../common/num';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser, serList } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { config } from '../config';
import { userPermissions } from '../auth';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { WmsService, type ReceiveLineInput } from '../wms/wms.service';
import type { PoDto, PoLineDto, ReceiveDto } from './erp.dto';
import { bookingOf, RateBook } from './currency';
import { KittingService } from './kitting.service';
import { calcPoLine } from './po-line';
import { qInt } from './query';

const CH = ['lines'];
/** 进行中（待到货）的采购订单状态 */
export const OPEN_PO = ['APPROVED', 'PARTIAL_RECEIVED'];
const SUPPLIER_STATUS: Record<string, string> = { QUALIFIED: '合格供方', PENDING: '待评审', SUSPENDED: '暂停供货', DISQUALIFIED: '已取消资格' };

/** 供应商回复交期是纯日期：统一输出 YYYY-MM-DD */
const fixLine = (l: any) => (l && l.promised_date instanceof Date ? { ...l, promised_date: fmtDate(l.promised_date) } : l);
const fixPo = (po: any) => (po?.lines ? { ...po, lines: po.lines.map(fixLine) } : po);
const ymd = (d: Date | null | undefined) => (d ? fmtDate(d) : '-');

export interface PoChangeInput {
  reason: string;
  expected_date?: string | null;
  lines?: {
    id: number;
    expected_date?: string | null;
    promised_date?: string | null;
    qty?: number | null;
    unit_price?: number | null;
    purchase_qty?: number | null;
    purchase_price?: number | null;
  }[];
}

export interface MaterialPurchaseInput {
  purchase_uom?: string | null;
  purchase_factor?: number | null;
  default_supplier_id?: number | null;
  lead_time_days?: number | null;
  min_order_qty?: number | null;
}

@Injectable()
export class PurchaseService {
  constructor(
    private readonly db: PrismaService,
    private readonly numbering: NumberingService,
    private readonly wms: WmsService,
    private readonly esign: EsignService,
    private readonly kitting: KittingService,
  ) {}

  /** 校验并生成订单行：客供料不能采购 */
  private async poLines(tx: Tx, lines: PoLineDto[]) {
    if (!lines?.length) throw new BizError('请至少录入一行采购明细');
    const out: Prisma.PurchaseOrderLineUncheckedCreateWithoutOrderInput[] = [];
    const total = new MoneySum();
    for (const [i, ln] of lines.entries()) {
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!m) throw new NotFound('物料');
      if (m.owner_customer_id) throw new BizError(`${m.code} 是客供料，不能采购`);
      // 采购单位换算：qty/unit_price 为库存单位，purchase_* 记录下单单位（见 po-line.ts）
      const c = calcPoLine(m, ln, i + 1);
      total.add(c.amount);
      out.push({
        line_no: i + 1, material_id: m.id, ...c,
        expected_date: dateOnly(ln.expected_date), remark: ln.remark ?? null,
      });
    }
    return { lines: out, total: total.value };
  }

  private async checkSupplier(tx: Tx, id: number) {
    if (!(await tx.supplier.findUnique({ where: { id } }))) throw new NotFound('供应商');
  }

  /** 列表：单号/供应商/物料编码名称搜索，按状态、供应商、物料、下单日期、币别、逾期筛选；支持 sort/order 排序 */
  private poWhere(q: Record<string, string>): Prisma.PurchaseOrderWhereInput {
    const and: Prisma.PurchaseOrderWhereInput[] = [];
    const where: Prisma.PurchaseOrderWhereInput = { AND: and };
    if (q.q) {
      const s = like(q.q);
      and.push({ OR: [{ no: s }, { remark: s }, { supplier: { OR: [{ name: s }, { code: s }, { short_name: s }] } }, { lines: { some: { material: { OR: [{ code: s }, { name: s }] } } } }] });
    }
    if (q.material) {
      const s = like(q.material);
      and.push({ lines: { some: { material: { OR: [{ code: s }, { name: s }, { spec: s }] } } } });
    }
    const mid = qInt(q.material_id);
    if (mid) and.push({ lines: { some: { material_id: mid } } });
    if (q.status) where.status = inList(q.status);
    const sid = qInt(q.supplier_id);
    if (sid) where.supplier_id = sid;
    if (q.currency) where.currency = inList(q.currency.toUpperCase());
    const from = dateOnly(q.date_from);
    const to = dateOnly(q.date_to);
    if (from || to) where.order_date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q.overdue === '1' || q.overdue === 'true') {
      const t = today();
      and.push({ status: { in: OPEN_PO } });
      and.push({ OR: [{ expected_date: { lt: t } }, { lines: { some: { OR: [{ promised_date: { lt: t } }, { promised_date: null, expected_date: { lt: t } }] } } }] });
    }
    return where;
  }

  async list(q: Record<string, string>) {
    const page = await paginate(this.db.client.purchaseOrder, 'PurchaseOrder', { where: this.poWhere(q), orderBy: { id: 'desc' }, children: CH }, q);
    page.items = page.items.map(fixPo);
    return page;
  }

  /** 采购订单明细（按行，导出 Excel 用）：筛选条件同列表 */
  async lines(q: Record<string, string>) {
    const size = Math.min(Math.max(Number(q.page_size) || 20, 1), 5000);
    const page = Math.max(Number(q.page) || 1, 1);
    const where: Prisma.PurchaseOrderLineWhereInput = { order: this.poWhere(q) };
    const [total, rows] = await Promise.all([
      this.db.client.purchaseOrderLine.count({ where }),
      this.db.client.purchaseOrderLine.findMany({
        where, include: { material: true, order: { include: { supplier: true } } }, orderBy: [{ order_id: 'desc' }, { line_no: 'asc' }], skip: (page - 1) * size, take: size,
      }),
    ]);
    const items = rows.map((l) => ({
      id: l.id, po_no: l.order.no, po_status: l.order.status, order_date: fmtDate(l.order.order_date), supplier_code: l.order.supplier.code, supplier_name: l.order.supplier.name,
      currency: l.order.currency, line_no: l.line_no, material_code: l.material.code, material_name: l.material.name, material_spec: l.material.spec, uom: l.material.uom,
      qty: l.qty, received_qty: l.received_qty || 0, open_qty: ['CLOSED', 'CANCELLED'].includes(l.order.status) ? 0 : Math.max(0, round(l.qty - (l.received_qty || 0))),
      unit_price: dec(l.unit_price).toNumber(), amount: dec(l.amount).toNumber(), purchase_uom: l.purchase_uom, purchase_qty: l.purchase_qty,
      purchase_price: l.purchase_price === null ? null : dec(l.purchase_price).toNumber(),
      expected_date: fmtDate(l.expected_date ?? l.order.expected_date), promised_date: fmtDate(l.promised_date), remark: l.remark, buyer: l.order.created_by, approved_by: l.order.approved_by,
    }));
    return { items, total, page, page_size: size };
  }

  /** 详情（含收货记录） */
  async get(id: number) {
    const c = this.db.client;
    const po = await c.purchaseOrder.findUnique({ where: { id }, include: inc('PurchaseOrder', CH) });
    if (!po) throw new NotFound('采购订单');
    const d = fixPo(ser('PurchaseOrder', po, CH));
    d.receipts = serList('Receipt', await c.receipt.findMany({ where: { po_id: id }, orderBy: { id: 'asc' }, include: inc('Receipt', CH) }), CH);
    d.approval = await this.bigness(c, po);
    // 被厂长退回（草稿 + 最近一次退回签名）：采购员在单据上直接看到退回人、时间与原因（无需审计权限）
    d.rejection = null;
    if (po.status === 'DRAFT') {
      const s = await c.eSignature.findFirst({ where: { entity: 'erp_purchase_order', entity_id: id, meaning: '大额采购单退回' }, orderBy: { id: 'desc' } });
      if (s) d.rejection = { by: s.full_name, at: s.ts, reason: s.reason };
    }
    return d;
  }

  create(user: CurrentUser, b: PoDto) {
    return this.db.tx(async (tx) => {
      await this.checkSupplier(tx, b.supplier_id);
      const { lines, total } = await this.poLines(tx, b.lines);
      const po = await tx.purchaseOrder.create({
        data: {
          no: await this.numbering.nextNo(tx, 'PO'), status: 'DRAFT', created_by: user.username,
          supplier_id: b.supplier_id, order_date: dateOnly(b.order_date) ?? today(), expected_date: dateOnly(b.expected_date),
          currency: b.currency ?? 'CNY', remark: b.remark ?? null, total_amount: total, lines: { create: lines },
        },
        include: inc('PurchaseOrder', CH),
      });
      return fixPo(ser('PurchaseOrder', po, CH));
    });
  }

  /** 修改草稿：未传的字段不变；显式 null 清空可选字段（必填字段 order_date/currency 传 null 时保持不变） */
  update(id: number, b: PoDto) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFound('采购订单');
      if (po.status === 'SUBMITTED') throw new BizError('采购单已提交厂长审批，不能修改；如需修改请厂长【退回】后再改');
      if (po.status !== 'DRAFT') throw new BizError('只有草稿状态可以修改');
      const supplierId = b.supplier_id ?? po.supplier_id;
      if (supplierId !== po.supplier_id) await this.checkSupplier(tx, supplierId);
      const { lines, total } = await this.poLines(tx, b.lines);
      const row = await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplier_id: supplierId,
          order_date: b.order_date ? dateOnly(b.order_date)! : undefined,
          expected_date: b.expected_date === undefined ? undefined : dateOnly(b.expected_date),
          currency: b.currency ?? undefined,
          remark: b.remark,
          total_amount: total,
          lines: { deleteMany: {}, create: lines },
        },
        include: inc('PurchaseOrder', CH),
      });
      return fixPo(ser('PurchaseOrder', row, CH));
    });
  }

  /**
   * 大额采购单判定：订单金额折本位币（今日适用汇率）≥ PO_APPROVAL_THRESHOLD 时须厂长（po_big_approve）电子签名审批；
   * 缺汇率无法折算时按大额处理（宁可多一道审批）。
   */
  async bigness(c: Tx, po: { total_amount: Prisma.Decimal | number; currency: string }) {
    const threshold = config.poApprovalThreshold;
    const book = await RateBook.load(c);
    const base = book.toBase(po.total_amount, po.currency, today());
    const big = threshold > 0 && (base === null || base + 0.005 >= threshold);
    return { threshold, base_currency: book.base, base_amount: base, missing_rate: base === null, big };
  }

  /** 供应商合格供方校验（审批、提交审批前） */
  private checkQualified(sup: { name: string; status: string; qualification_expiry: Date | null }) {
    if (sup.status !== 'QUALIFIED') {
      throw new BizError(
        `供应商【${sup.name}】当前为“${SUPPLIER_STATUS[sup.status] ?? sup.status}”，不在合格供方名录内，采购订单不能审批（GMP 采购控制）。` +
          '请联系质量部完成供应商评审，评为“合格供方”后再审批；急用可改选其他合格供应商。',
      );
    }
    if (sup.qualification_expiry && sup.qualification_expiry.getTime() < today().getTime()) {
      throw new BizError(`供应商【${sup.name}】资质已于 ${fmtDate(sup.qualification_expiry)} 过期，采购订单不能审批。请联系质量部完成供应商再评价（更新资质有效期）后再审批。`);
    }
  }

  private bigText(b: { base_amount: number | null; threshold: number; base_currency: string; missing_rate: boolean }, currency: string) {
    return b.missing_rate
      ? `缺少 ${currency} 今日汇率，无法折算本位币，按大额采购单处理`
      : `金额折合 ${b.base_currency} ${money(b.base_amount!).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} ≥ 大额审批标准 ${b.threshold.toLocaleString('zh-CN')}`;
  }

  /**
   * 审批：供应商必须在合格供方名录内且资质未过期。
   * 大额采购单（见 bigness）只能由厂长（po_big_approve）电子签名审批（草稿直接批或批“待审批”）；采购员须先【提交审批】。
   */
  approve(id: number, user: CurrentUser, signature?: SignatureDto | null) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: true } });
      if (!po) throw new NotFound('采购订单');
      if (!['DRAFT', 'SUBMITTED'].includes(po.status)) throw new BizError('只有草稿或待审批的采购单可以审批');
      this.checkQualified(po.supplier);
      const b = await this.bigness(tx, po);
      const canBig = userPermissions(user).has('po_big_approve');
      if (b.big) {
        if (!canBig) {
          throw new BizError(
            po.status === 'SUBMITTED'
              ? `采购单 ${po.no} 已提交厂长审批（${this.bigText(b, po.currency)}），请等待厂长批准`
              : `采购单 ${po.no} ${this.bigText(b, po.currency)}，须厂长审批：请点【提交审批】`,
          );
        }
        await this.esign.sign(tx, user, signature, '大额采购单审批', 'erp_purchase_order', po.id, po.no);
      } else if (!userPermissions(user).has('purchase') && !canBig) {
        throw new BizError('无权限审批采购单');
      }
      const row = await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'APPROVED', approved_by: user.full_name, approved_at: new Date() },
        include: inc('PurchaseOrder', CH),
      });
      return { ...fixPo(ser('PurchaseOrder', row, CH)), approval: b };
    });
  }

  /** 采购员提交大额采购单给厂长审批（草稿 → 待审批 SUBMITTED；不能再修改，厂长可批准或退回） */
  submit(id: number, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: true, lines: true } });
      if (!po) throw new NotFound('采购订单');
      if (po.status !== 'DRAFT') throw new BizError('只有草稿可以提交审批');
      if (!po.lines.length) throw new BizError('请至少录入一行采购明细');
      this.checkQualified(po.supplier);
      const b = await this.bigness(tx, po);
      if (!b.big) throw new BizError(`采购单金额未达大额审批标准（${b.threshold.toLocaleString('zh-CN')}），请直接【审批】`);
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'SUBMITTED' }, include: inc('PurchaseOrder', CH) });
      await tx.auditLog.create({
        data: {
          username: user.username, full_name: user.full_name, entity: 'erp_purchase_order', entity_id: id, action: 'UPDATE',
          changes: JSON.stringify({ 变更类型: '提交审批', 单号: po.no, 变更原因: '大额采购单提交厂长审批', 变更内容: [this.bigText(b, po.currency)] }),
        },
      });
      return { ...fixPo(ser('PurchaseOrder', row, CH)), approval: b };
    });
  }

  /** 厂长退回大额采购单（待审批 → 草稿，填写原因、电子签名），采购员修改后可再次提交 */
  reject(id: number, user: CurrentUser, reason: string, signature?: SignatureDto | null) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFound('采购订单');
      if (po.status !== 'SUBMITTED') throw new BizError('只有待审批的采购单可以退回');
      const why = String(reason ?? '').trim();
      if (why.length < 2) throw new BizError('请填写退回原因（如：单价偏高，请再议价）');
      await this.esign.sign(tx, user, { password: signature?.password ?? '', reason: why }, '大额采购单退回', 'erp_purchase_order', po.id, po.no);
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'DRAFT' }, include: inc('PurchaseOrder', CH) });
      await tx.auditLog.create({
        data: {
          username: user.username, full_name: user.full_name, entity: 'erp_purchase_order', entity_id: id, action: 'UPDATE',
          changes: JSON.stringify({ 变更类型: '退回', 单号: po.no, 变更原因: why, 变更内容: ['厂长退回大额采购单，状态 待审批 → 草稿'] }),
        },
      });
      return fixPo(ser('PurchaseOrder', row, CH));
    });
  }

  cancel(id: number) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!po) throw new NotFound('采购订单');
      if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(po.status) || po.lines.some((l) => (l.received_qty || 0) > 0)) {
        throw new BizError('已收货的订单不能取消，请使用“关闭”');
      }
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' }, include: inc('PurchaseOrder', CH) });
      return fixPo(ser('PurchaseOrder', row, CH));
    });
  }

  close(id: number) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFound('采购订单');
      if (!['APPROVED', 'PARTIAL_RECEIVED', 'RECEIVED'].includes(po.status)) throw new BizError('当前状态不能关闭');
      const row = await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED' }, include: inc('PurchaseOrder', CH) });
      return fixPo(ser('PurchaseOrder', row, CH));
    });
  }

  /** 采购收货：调用仓储收货（自动生成 IQC 检验单、更新订单收货状态、生成应付） */
  receive(id: number, b: ReceiveDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: { orderBy: { line_no: 'asc' } } } });
      if (!po) throw new NotFound('采购订单');
      if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) throw new BizError('采购订单未审批或已完结，不能收货');
      const lines: ReceiveLineInput[] = [];
      for (const ln of b.lines) {
        const pl = await tx.purchaseOrderLine.findUnique({ where: { id: ln.po_line_id } });
        if (!pl) throw new NotFound('采购订单行');
        lines.push({
          po_line_id: ln.po_line_id, qty: ln.qty, location_id: ln.location_id, lot_no: ln.lot_no ?? null, supplier_lot: ln.supplier_lot ?? null,
          mfg_date: dateOnly(ln.mfg_date), expiry_date: dateOnly(ln.expiry_date), material_id: pl.material_id,
        });
      }
      // confirm_placement：湿敏物料放非防潮库位等需确认的放置（仓储服务校验，未确认时 400 “【需确认】…”）
      const args: Parameters<WmsService['receive']>[2] & { confirm_placement?: boolean } = {
        receipt_type: 'PURCHASE', lines, supplier_id: po.supplier_id, po, delivery_note: b.delivery_note ?? null, remark: b.remark ?? null,
        confirm_placement: !!b.confirm_placement,
      };
      const rc = await this.wms.receive(tx, user, args);
      // 应付单按收货日适用汇率记账（记账汇率 + 本位币金额）
      const aps = await tx.financeDoc.findMany({ where: { ref_type: 'RECEIPT', ref_no: rc.no, exchange_rate: null } });
      if (aps.length) {
        const book = await RateBook.load(tx);
        for (const d of aps) {
          const bk = bookingOf(book, d.amount, d.currency, d.doc_date);
          if (bk.exchange_rate !== null) await tx.financeDoc.update({ where: { id: d.id }, data: bk });
        }
      }
      const row = await tx.receipt.findUnique({ where: { id: rc.id }, include: inc('Receipt', CH) });
      return ser('Receipt', row, CH);
    });
  }

  // ---------------- 审批后变更（交期 / 单价 / 数量 / 供应商回复交期），留痕 ----------------

  /**
   * 已审批（含部分到货）的采购订单变更：改表头预计到货、行预计到货、供应商回复交期、单价、数量。
   * 必须填写变更原因；字段级前后值由审计追踪自动记录，另写一条“变更原因 + 变更内容”的审计记录，详情页“变更记录”可查。
   * 数量不能小于已收货数量；已收货部分的应付单不随单价变更（提示通知财务）。
   */
  change(id: number, b: PoChangeInput, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: { include: { material: true }, orderBy: { line_no: 'asc' } } } });
      if (!po) throw new NotFound('采购订单');
      if (!OPEN_PO.includes(po.status)) {
        throw new BizError(po.status === 'DRAFT' ? '草稿状态请直接修改订单' : '只有已审批、尚未到齐的采购订单可以变更（已到齐/已关闭/已取消的订单不能变更）');
      }
      const reason = String(b.reason ?? '').trim();
      if (reason.length < 2) throw new BizError('请填写变更原因（如：供应商回复交期推迟、价格调整、数量调整）');
      const diffs: string[] = [];
      const poData: Prisma.PurchaseOrderUpdateInput = {};
      if (b.expected_date !== undefined) {
        const v = dateOnly(b.expected_date);
        if ((v?.getTime() ?? null) !== (po.expected_date?.getTime() ?? null)) {
          poData.expected_date = v;
          diffs.push(`表头预计到货 ${ymd(po.expected_date)} → ${ymd(v)}`);
        }
      }
      const amounts = new Map(po.lines.map((l) => [l.id, l.amount]));
      for (const ln of b.lines ?? []) {
        const pl = po.lines.find((l) => l.id === Number(ln.id));
        if (!pl) throw new NotFound('采购订单行');
        const tag = `第 ${pl.line_no} 行 ${pl.material.code}`;
        const data: Prisma.PurchaseOrderLineUpdateInput = {};
        for (const k of ['expected_date', 'promised_date'] as const) {
          if (ln[k] === undefined) continue;
          const v = dateOnly(ln[k]);
          if ((v?.getTime() ?? null) !== (pl[k]?.getTime() ?? null)) {
            data[k] = v;
            diffs.push(`${tag} ${k === 'expected_date' ? '预计到货' : '供应商回复交期'} ${ymd(pl[k])} → ${ymd(v)}`);
          }
        }
        const factor = pl.purchase_uom && pl.purchase_qty ? pl.qty / pl.purchase_qty : 0;
        let qty = pl.qty;
        let price = dec(pl.unit_price).toNumber();
        let pq = pl.purchase_qty;
        let pp = pl.purchase_price === null ? null : dec(pl.purchase_price).toNumber();
        if (factor) {
          // 按采购单位下单的行：按采购单位改数量/单价（换算率沿用下单时）
          if (ln.purchase_qty !== undefined && ln.purchase_qty !== null) pq = Number(ln.purchase_qty);
          else if (ln.qty !== undefined && ln.qty !== null) pq = round(Number(ln.qty) / factor, 6);
          if (ln.purchase_price !== undefined && ln.purchase_price !== null) pp = price6(ln.purchase_price);
          else if (ln.unit_price !== undefined && ln.unit_price !== null) pp = price6(dec(ln.unit_price).times(factor));
          if (!(pq! > 0)) throw new BizError(`${tag} 数量必须大于 0`);
          if (Math.abs(pq! - Math.round(pq!)) > 1e-6) {
            throw new BizError(`${tag} 按${pl.purchase_uom}下单，数量须为整数${pl.purchase_uom}（填写了 ${g(pq)}）`);
          }
          qty = round(pq! * factor);
          price = price6(dec(pp ?? 0).div(factor));
        } else {
          if (ln.qty !== undefined && ln.qty !== null) qty = round(Number(ln.qty));
          if (ln.unit_price !== undefined && ln.unit_price !== null) price = price6(ln.unit_price);
          if (!(qty > 0)) throw new BizError(`${tag} 数量必须大于 0`);
        }
        const unit = factor ? pl.purchase_uom! : pl.material.uom;
        if (qty + EPS < (pl.received_qty || 0)) {
          throw new BizError(`${tag} 数量不能小于已收货数量 ${g(pl.received_qty)} ${pl.material.uom}；不再到货的余量请直接【关闭】订单`);
        }
        if (Math.abs(qty - pl.qty) > EPS) {
          data.qty = qty;
          if (factor) data.purchase_qty = pq;
          diffs.push(`${tag} 数量 ${factor ? `${g(pl.purchase_qty)} → ${g(pq)} ${unit}（${g(pl.qty)} → ${g(qty)} ${pl.material.uom}）` : `${g(pl.qty)} → ${g(qty)} ${unit}`}`);
        }
        const oldShown = factor ? dec(pl.purchase_price ?? 0) : dec(pl.unit_price);
        const newShown = factor ? dec(pp ?? 0) : dec(price);
        if (!oldShown.equals(newShown)) {
          data.unit_price = price;
          if (factor) data.purchase_price = pp;
          const note = pl.received_qty > 0 ? `（已收货 ${g(pl.received_qty)} ${pl.material.uom} 的应付单按原价已生成，如需调整请通知财务）` : '';
          diffs.push(`${tag} 单价 ${oldShown.toString()} → ${newShown.toString()} /${unit}${note}`);
        }
        if (data.qty !== undefined || data.unit_price !== undefined) {
          data.amount = factor ? lineAmount(pq, pp) : lineAmount(qty, price);
          amounts.set(pl.id, dec(data.amount as number));
        }
        if (Object.keys(data).length) await tx.purchaseOrderLine.update({ where: { id: pl.id }, data });
      }
      if (!diffs.length) throw new BizError('没有需要变更的内容');
      const total = new MoneySum();
      amounts.forEach((v) => total.add(v));
      poData.total_amount = total.value;
      const lines = await tx.purchaseOrderLine.findMany({ where: { order_id: id } });
      const got = lines.some((l) => (l.received_qty || 0) > 0);
      const done = lines.every((l) => (l.received_qty || 0) + EPS >= l.qty);
      poData.status = done ? 'RECEIVED' : got ? 'PARTIAL_RECEIVED' : 'APPROVED';
      if (poData.status !== po.status) diffs.push(`状态 ${po.status} → ${poData.status}`);
      await tx.purchaseOrder.update({ where: { id }, data: poData });
      await tx.auditLog.create({
        data: {
          username: user.username, full_name: user.full_name, entity: 'erp_purchase_order', entity_id: id, action: 'UPDATE',
          changes: JSON.stringify({ 变更类型: '审批后变更', 单号: po.no, 变更原因: reason, 变更内容: diffs }),
        },
      });
      const row = await tx.purchaseOrder.findUnique({ where: { id }, include: inc('PurchaseOrder', CH) });
      return { ...fixPo(ser('PurchaseOrder', row, CH)), change: { reason, items: diffs } };
    });
  }

  /** 变更记录（审批后变更，含原因） */
  async changes(id: number) {
    const logs = await this.db.client.auditLog.findMany({ where: { entity: 'erp_purchase_order', entity_id: id }, orderBy: { id: 'desc' } });
    const out: { id: number; ts: Date; username: string | null; full_name: string | null; reason: string; items: string[] }[] = [];
    for (const l of logs) {
      try {
        const c = JSON.parse(l.changes || '{}');
        if (c && c['变更原因']) out.push({ id: l.id, ts: l.ts, username: l.username, full_name: l.full_name, reason: c['变更原因'], items: c['变更内容'] ?? [] });
      } catch {
        /* 非 JSON 内容忽略 */
      }
    }
    return out;
  }

  // ---------------- 催货清单 ----------------

  /**
   * 未到齐的采购订单行：未交数量、应到日期（供应商回复交期优先，其次行/表头预计到货）、逾期天数、最近收货日。
   * 筛选：supplier_id、q（单号/物料/供应商）、material_id、state（OVERDUE 逾期 / DUE_SOON 3 天内到期 / ON_TRACK / NO_DATE，可逗号多选）、due_within（N 天内到期含逾期）。
   * 排序：sort = overdue_days | due_date | open_qty | open_amount | po_no | supplier_name | material_code，order = asc|desc。
   */
  async chase(q: Record<string, string>) {
    const t = today();
    const and: Prisma.PurchaseOrderLineWhereInput[] = [];
    const where: Prisma.PurchaseOrderLineWhereInput = { AND: and, order: { status: { in: OPEN_PO } } };
    const sid = qInt(q.supplier_id);
    if (sid) and.push({ order: { supplier_id: sid } });
    const mid = qInt(q.material_id);
    if (mid) and.push({ material_id: mid });
    if (q.q) {
      const s = like(q.q);
      and.push({ OR: [{ order: { no: s } }, { order: { supplier: { name: s } } }, { material: { OR: [{ code: s }, { name: s }, { spec: s }] } }] });
    }
    if (q.buyer) and.push({ order: { created_by: q.buyer } });
    const lines = await this.db.client.purchaseOrderLine.findMany({
      where,
      include: { material: true, order: { include: { supplier: true } }, receipt_lines: { include: { receipt: { select: { receipt_date: true } } } } },
    });
    const DUE_SOON_DAYS = 3;
    let rows = lines
      .map((l) => {
        const open = round(l.qty - (l.received_qty || 0));
        const due = l.promised_date ?? l.expected_date ?? l.order.expected_date;
        const overdue = due ? daysBetween(t, due) : null;
        const state = overdue === null ? 'NO_DATE' : overdue > 0 ? 'OVERDUE' : overdue >= -DUE_SOON_DAYS ? 'DUE_SOON' : 'ON_TRACK';
        const last = l.receipt_lines.map((r) => r.receipt.receipt_date.getTime()).sort((a, b) => b - a)[0];
        const factor = l.purchase_uom && l.purchase_qty ? l.qty / l.purchase_qty : 0;
        return {
          id: l.id, po_id: l.order_id, po_no: l.order.no, po_status: l.order.status, line_no: l.line_no,
          supplier_id: l.order.supplier_id, supplier_name: l.order.supplier.name, supplier_contact: l.order.supplier.contact, supplier_phone: l.order.supplier.phone,
          material_id: l.material_id, material_code: l.material.code, material_name: l.material.name, material_spec: l.material.spec, uom: l.material.uom,
          qty: l.qty, received_qty: l.received_qty || 0, open_qty: open,
          purchase_uom: l.purchase_uom, open_purchase_qty: factor ? round(open / factor, 4) : null,
          unit_price: dec(l.unit_price).toNumber(), open_amount: money(dec(open).times(l.unit_price)), currency: l.order.currency,
          order_date: fmtDate(l.order.order_date), expected_date: fmtDate(l.expected_date ?? l.order.expected_date), promised_date: fmtDate(l.promised_date),
          due_date: fmtDate(due), overdue_days: overdue === null ? null : Math.max(overdue, 0), days_to_due: overdue === null ? null : -overdue, state,
          last_receipt_date: last ? fmtDate(new Date(last)) : null, buyer: l.order.created_by, remark: l.remark,
        };
      })
      .filter((r) => r.open_qty > EPS);
    // 影响工单：这些物料缺料的未完工工单（齐套分析口径）
    const short = await this.kitting.shortWorkOrdersByMaterial([...new Set(rows.map((r) => r.material_id))]);
    for (const r of rows as any[]) r.affected_wos = (short.get(r.material_id) ?? []).slice(0, 5);
    const counts = {
      total: rows.length,
      overdue: rows.filter((r) => r.state === 'OVERDUE').length,
      due_soon: rows.filter((r) => r.state === 'DUE_SOON').length,
      no_date: rows.filter((r) => r.state === 'NO_DATE').length,
      suppliers: new Set(rows.filter((r) => r.state === 'OVERDUE').map((r) => r.supplier_id)).size,
    };
    if (q.overdue === '1' || q.overdue === 'true') rows = rows.filter((r) => r.state === 'OVERDUE');
    if (q.state) {
      const st = new Set(q.state.split(','));
      rows = rows.filter((r) => st.has(r.state));
    }
    if (q.due_within) {
      const n = Number(q.due_within);
      rows = rows.filter((r) => r.days_to_due !== null && r.days_to_due <= n);
    }
    const SORTS = ['overdue_days', 'due_date', 'open_qty', 'open_amount', 'po_no', 'supplier_name', 'material_code', 'promised_date', 'expected_date'];
    const key = SORTS.includes(q.sort) ? (q.sort as keyof (typeof rows)[number]) : null;
    const dir = q.order === 'asc' || q.order === 'ascend' ? 1 : -1;
    const cmp = (a: any, b: any) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);
    rows.sort((a, b) =>
      key
        ? cmp(a[key], b[key]) * (a[key] === null || b[key] === null ? 1 : dir) || cmp(a.po_no, b.po_no)
        : cmp(b.overdue_days ?? -1, a.overdue_days ?? -1) || cmp(a.due_date, b.due_date) || cmp(a.po_no, b.po_no) || a.line_no - b.line_no,
    );
    const page = Math.max(Number(q.page) || 1, 1);
    const size = Math.min(Math.max(Number(q.page_size) || 20, 1), 5000);
    return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size, counts, today: fmtDate(t) };
  }

  // ---------------- 物料采购属性（采购自行维护） ----------------

  /** 可采购物料（非客供料）的采购属性，附最近一次采购价 */
  async materials(q: Record<string, string>) {
    const and: Prisma.MaterialWhereInput[] = [];
    const where: Prisma.MaterialWhereInput = { AND: and, owner_customer_id: null };
    where.category = q.category ? inList(q.category) : { in: ['RAW', 'PACKAGING', 'CONSUMABLE', 'SEMI'] };
    if (q.is_active !== undefined && q.is_active !== '') where.is_active = ['1', 'true'].includes(q.is_active);
    if (q.q) and.push({ OR: [{ code: like(q.q) }, { name: like(q.q) }, { spec: like(q.q) }] });
    const sid = qInt(q.supplier_id);
    if (sid) where.default_supplier_id = sid;
    if (q.has_purchase_uom === '1') and.push({ purchase_uom: { not: null } }, { NOT: { purchase_uom: '' } });
    const page = await paginate(this.db.client.material, 'Material', { where, orderBy: { code: 'asc' } }, q);
    const ids = page.items.map((m: any) => m.id as number);
    const last = await this.db.client.purchaseOrderLine.findMany({
      where: { material_id: { in: ids }, order: { status: { notIn: ['DRAFT', 'CANCELLED'] } } },
      orderBy: { id: 'desc' },
      include: { order: { include: { supplier: true } } },
    });
    const byMat = new Map<number, (typeof last)[number]>();
    for (const l of last) if (!byMat.has(l.material_id)) byMat.set(l.material_id, l);
    page.items = page.items.map((m: any) => {
      const l = byMat.get(m.id);
      return {
        ...m,
        last_price: l ? dec(l.unit_price).toNumber() : null,
        last_purchase_price: l?.purchase_price ? dec(l.purchase_price).toNumber() : null,
        last_purchase_uom: l?.purchase_uom ?? null,
        last_currency: l?.order.currency ?? null,
        last_po_no: l?.order.no ?? null,
        last_po_id: l?.order_id ?? null,
        last_supplier_name: l?.order.supplier.name ?? null,
        last_order_date: l ? fmtDate(l.order.order_date) : null,
      };
    });
    return page;
  }

  /** 采购维护物料采购属性：采购单位与换算率、默认供应商、采购提前期、最小订购量（不影响已下单的订单行） */
  updateMaterialPurchase(id: number, b: MaterialPurchaseInput) {
    return this.db.tx(async (tx) => {
      const m = await tx.material.findUnique({ where: { id } });
      if (!m) throw new NotFound('物料');
      if (m.owner_customer_id) throw new BizError(`${m.code} 是客供料，由客户供料，不需要维护采购属性`);
      const data: Prisma.MaterialUncheckedUpdateInput = {};
      if (b.purchase_uom !== undefined || b.purchase_factor !== undefined) {
        let uom = b.purchase_uom === undefined ? m.purchase_uom : (b.purchase_uom ?? '').trim() || null;
        let factor = b.purchase_factor === undefined || b.purchase_factor === null ? m.purchase_factor : Number(b.purchase_factor);
        if (uom && uom === m.uom) [uom, factor] = [null, 1];
        if (uom) {
          if (!(factor > 0)) throw new BizError(`请填写换算率：1 ${uom} = 多少 ${m.uom}（必须大于 0）`);
          if (Math.abs(factor - 1) < EPS) throw new BizError(`1 ${uom} = 1 ${m.uom} 时无需设置采购单位，请清空采购单位`);
        } else factor = 1;
        data.purchase_uom = uom;
        data.purchase_factor = round(factor, 6);
      }
      if (b.default_supplier_id !== undefined) {
        if (b.default_supplier_id !== null && !(await tx.supplier.findUnique({ where: { id: Number(b.default_supplier_id) } }))) throw new NotFound('供应商');
        data.default_supplier_id = b.default_supplier_id === null ? null : Number(b.default_supplier_id);
      }
      if (b.lead_time_days !== undefined && b.lead_time_days !== null) {
        if (!Number.isInteger(Number(b.lead_time_days)) || Number(b.lead_time_days) < 0) throw new BizError('采购提前期请填写 0 或正整数（天）');
        data.lead_time_days = Number(b.lead_time_days);
      }
      if (b.min_order_qty !== undefined && b.min_order_qty !== null) {
        if (!(Number(b.min_order_qty) >= 0)) throw new BizError('最小订购量不能为负数');
        data.min_order_qty = round(Number(b.min_order_qty));
      }
      const row = await tx.material.update({ where: { id }, data, include: inc('Material') });
      return ser('Material', row);
    });
  }
}
