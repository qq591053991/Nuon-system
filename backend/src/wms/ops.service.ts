/**
 * 仓库作业（条码扫码 / 冲销）服务（RFID 作业见 src/rfid，复用本服务的拣料、盘点、完工入库、退货扫码）：
 *   receiveContext(tx, poKey)                       条码收货：扫采购单号 → 未收行 + 物料属性 + 建议库位
 *   placementCheck(tx, args)                        扫库位：解析库位编码并校验放置规则（错误 / 需确认的警告）
 *   putawayList(tx, q)                              待上架清单（暂存区、放置不合规、不在默认库位）
 *   scan(tx, code)                                  扫码解析：库位 / 批号 / 原厂批号 / 序列号 / 物料编码 → 库存行
 *   pickLine / replaceLine                          拣料模式：录实拣数（短缺自动从下一 FEFO 批次补足）、扫到其他批次时替换
 *   reverseIssue / reverseShipment / reverseCount   冲销（反向库存流水 + 电子签名 + 原因；被后续单据引用时拦截）
 *   enrichCount / saveCountLines / addCountLine / cancelCount   盘点：当前账面、建单/录入后有收发提示（须重新清点）、盘盈新增行、作废
 *   serialCheck / rmaScan                           发货 / 客户退货扫码校验（具体拒绝原因）
 *   updateTracking                                  运单号补录
 *   fgReceiptSerials                                完工入库逐台扫码核对
 */
import { Injectable } from '@nestjs/common';
import type { MaterialIssue, WorkOrder } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, num, round } from '../common/num';
import { inc, ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, STATUS_TEXT, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { putawayReason, suggestLocation, type SuggestedLocation } from './placement';
import { keyOf, lotLedger } from './returns.service';
import { parseIds } from './wms.service';

const PO_TEXT: Record<string, string> = { DRAFT: '草稿（未审批）', APPROVED: '已审批', PARTIAL_RECEIVED: '部分到货', RECEIVED: '已到货', CLOSED: '已关闭', CANCELLED: '已取消' };
const SN_TEXT: Record<string, string> = {
  CREATED: '待生产', IN_PROCESS: '在制', NG: '不良待处置', COMPLETED: '完工待入库', IN_STOCK: '在库', SHIPPED: '已发货', SCRAPPED: '已报废', RETURNED: '客户退回',
};
const DOC_TEXT: Record<string, string> = { DRAFT: '待过账', CONFIRMED: '已过账', CANCELLED: '已作废', SHIPPED: '已发货', REVERSED: '已冲销', OPEN: '进行中', POSTED: '已过账' };

const stockKey = (s: { location_id: number; lot_no: string; owner_customer_id: number | null }) => `${s.location_id}|${s.lot_no}|${s.owner_customer_id ?? ''}`;

export interface PickResult { issue: any; messages: string[] }

@Injectable()
export class WmsOpsService {
  constructor(
    private readonly inv: InventoryService,
    private readonly numbering: NumberingService,
    private readonly esign: EsignService,
  ) {}

  // ---------------- 收货 / 库位 ----------------

  /** 收货上下文（条码收货与 RFID 收货台共用）：按采购单号（或 id）取未收完的订单行、物料属性（批次/保质期/MSL/检验/GTIN）与建议库位 */
  async receiveContext(tx: Tx, key: string) {
    const k = String(key ?? '').trim();
    if (!k) throw new BizError('请扫描采购订单号');
    const where = /^\d{1,8}$/.test(k) ? { OR: [{ id: Number(k) }, { no: k }] } : { no: { equals: k, mode: 'insensitive' as const } };
    const po = await tx.purchaseOrder.findFirst({ where, include: { supplier: true, lines: { orderBy: { line_no: 'asc' }, include: { material: true } } } });
    if (!po) throw new BizError(`未找到采购订单“${k}”，请核对后重扫（扫采购订单 / 送货单上的采购单号）`);
    if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) {
      throw new BizError(`采购订单 ${po.no} 当前状态为【${PO_TEXT[po.status] ?? po.status}】，不能收货${po.status === 'DRAFT' ? '（请采购先审批）' : ''}`);
    }
    const cache = new Map<number, SuggestedLocation | null>();
    const lines = [];
    for (const l of po.lines) {
      const m = l.material;
      if (!cache.has(m.id)) cache.set(m.id, await suggestLocation(tx, m));
      const remaining = Math.max(0, round(l.qty - (l.received_qty || 0)));
      lines.push({
        po_line_id: l.id, line_no: l.line_no, material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec, uom: m.uom,
        qty: l.qty, received_qty: l.received_qty || 0, remaining, max_qty: round(remaining * 1.05),
        purchase_uom: l.purchase_uom ?? null, purchase_factor: m.purchase_factor,
        lot_control: m.lot_control, shelf_life_days: m.shelf_life_days, msl_level: m.msl_level, iqc_required: m.iqc_required, gtin: m.gtin,
        expected_date: l.expected_date ?? po.expected_date ?? null,
        suggest_location: cache.get(m.id) ?? null,
      });
    }
    return {
      po: { id: po.id, no: po.no, status: po.status, supplier_id: po.supplier_id, supplier_name: po.supplier?.name ?? null, expected_date: po.expected_date },
      lines,
    };
  }

  /** 解析库位（id 或编码）并校验放置规则：errors 后端会拒绝；warnings（湿敏物料放非防潮柜）需操作人确认 */
  async placementCheck(tx: Tx, a: { material_id: number; location_id?: number | null; location_code?: string | null; owner_customer_id?: number | null }) {
    const code = String(a.location_code ?? '').trim();
    const loc = a.location_id
      ? await tx.location.findUnique({ where: { id: a.location_id }, include: { warehouse: true } })
      : code ? await tx.location.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, include: { warehouse: true } }) : null;
    if (!loc) return { ok: false, errors: [`库位“${code || a.location_id || ''}”不存在，请重扫库位条码`], warnings: [], location: null };
    const r = await this.inv.checkPlacement(tx, { material_id: a.material_id, location_id: loc.id, owner_customer_id: a.owner_customer_id });
    return {
      ok: !r.errors.length, errors: r.errors, warnings: r.warnings,
      location: { id: loc.id, code: loc.code, name: loc.name, location_type: loc.location_type, warehouse_name: loc.warehouse?.name ?? null, warehouse_type: loc.warehouse?.warehouse_type ?? null },
    };
  }

  async suggest(tx: Tx, materialId: number) {
    const m = await tx.material.findUnique({ where: { id: materialId } });
    if (!m) throw new NotFound('物料');
    return suggestLocation(tx, m);
  }

  /** 待上架清单（见 placement.putawayReason） */
  async putawayList(tx: Tx, q: { warehouse_id?: number; include_quarantine?: boolean; q?: string }) {
    const where: any = {
      qty: { gt: EPS }, status: { in: q.include_quarantine ? ['AVAILABLE', 'QUARANTINE'] : ['AVAILABLE'] },
      location: { warehouse: { warehouse_type: { in: ['RAW', 'CUSTOMER', 'FG'] } }, ...(q.warehouse_id ? { warehouse_id: q.warehouse_id } : {}) },
    };
    if (q.q) {
      const kw = { contains: q.q.trim(), mode: 'insensitive' as const };
      where.OR = [{ lot_no: kw }, { material: { code: kw } }, { material: { name: kw } }];
    }
    const rows = await tx.stock.findMany({ where, include: inc('Stock') });
    const cache = new Map<number, SuggestedLocation | null>();
    const items: any[] = [];
    for (const st of rows as any[]) {
      const r = await putawayReason(tx, st, cache);
      if (!r) continue;
      items.push({ ...ser('Stock', st), putaway_reason: r.reason, suggest_location_id: r.suggest?.id ?? null, suggest_location_code: r.suggest?.code ?? null });
    }
    items.sort((a, b) => String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')) || String(a.material_code).localeCompare(String(b.material_code)));
    return { items, total: items.length, page: 1, page_size: items.length };
  }

  /**
   * 扫码解析（条码作业通用）：依次匹配 库位编码 → 批号 → 原厂批号 → 序列号（取其批次）→ 物料编码 / GTIN。
   * 返回 kind 与该码对应的有库存行（含物料、库位信息）。
   */
  async scan(tx: Tx, raw: string, opts: { lot?: string | null; gtin?: string | null } = {}) {
    const code = String(raw ?? '').trim();
    if (!code) throw new BizError('条码为空');
    const ci = { equals: code, mode: 'insensitive' as const };
    const stockOf = async (where: any) => (await tx.stock.findMany({ where: { qty: { gt: EPS }, ...where }, include: inc('Stock'), orderBy: { id: 'asc' } })).map((s) => ser('Stock', s));
    const loc = await tx.location.findFirst({ where: { code: ci }, include: { warehouse: true } });
    if (loc) {
      return { kind: 'LOCATION', code: loc.code, location: { id: loc.id, code: loc.code, name: loc.name, location_type: loc.location_type, warehouse_id: loc.warehouse_id, warehouse_name: loc.warehouse?.name ?? null }, rows: await stockOf({ location_id: loc.id }) };
    }
    const lot = (opts.lot ?? '').trim() || code;
    let rows = await stockOf({ lot_no: lot });
    if (!rows.length) rows = await stockOf({ lot_no: { equals: lot, mode: 'insensitive' } });
    if (rows.length) return { kind: 'LOT', code: lot, rows };
    rows = await stockOf({ supplier_lot: { equals: lot, mode: 'insensitive' } });
    if (rows.length) return { kind: 'SUPPLIER_LOT', code: lot, rows };
    const sn = await tx.serialNumber.findUnique({ where: { sn: code }, include: { material: true, work_order: true } });
    if (sn) {
      return {
        kind: 'SN', code,
        sn: { sn: sn.sn, status: sn.status, lot_no: sn.lot_no, material_id: sn.material_id, material_code: sn.material.code, location_id: sn.location_id, wo_id: sn.wo_id, wo_no: sn.work_order?.no ?? null },
        rows: sn.lot_no ? await stockOf({ material_id: sn.material_id, lot_no: sn.lot_no }) : [],
      };
    }
    const m = await tx.material.findFirst({ where: { OR: [{ code: ci }, ...(opts.gtin || /^\d{14}$/.test(code) ? [{ gtin: opts.gtin || code }] : [])] } });
    if (m) return { kind: 'MATERIAL', code: m.code, material: { id: m.id, code: m.code, name: m.name, uom: m.uom }, rows: await stockOf({ material_id: m.id }) };
    return { kind: 'UNKNOWN', code, rows: [] as any[] };
  }

  /** 已下达、仍有未领物料且没有待过账领料单覆盖的工单（拣料列表为空时提示“从工单生成”） */
  async issueCandidates(tx: Tx) {
    const wos = await tx.workOrder.findMany({
      where: { status: { in: ['RELEASED', 'IN_PROGRESS'] } },
      include: { material: true, materials: { include: { material: true } } },
      orderBy: [{ planned_start: 'asc' }, { id: 'asc' }],
    });
    const pendingBy = new Map<string, number>();
    for (const w of wos) {
      const rows = await tx.materialIssueLine.groupBy({ by: ['material_id'], where: { issue: { status: 'DRAFT', issue_type: 'ISSUE', wo_id: w.id } }, _sum: { qty: true } });
      for (const r of rows) pendingBy.set(`${w.id}|${r.material_id}`, r._sum.qty ?? 0);
    }
    const out = [];
    for (const w of wos) {
      const short = w.materials
        .map((m) => ({ code: m.material.code, need: round(m.required_qty - (m.issued_qty || 0) - (pendingBy.get(`${w.id}|${m.material_id}`) ?? 0)) }))
        .filter((x) => x.need > EPS);
      const hasDraft = w.materials.some((m) => (pendingBy.get(`${w.id}|${m.material_id}`) ?? 0) > EPS);
      if (!short.length) continue;
      out.push({
        id: w.id, no: w.no, status: w.status, material_code: w.material.code, material_name: w.material.name, planned_qty: w.planned_qty,
        planned_start: w.planned_start, lines: short.length, materials: short.slice(0, 6).map((x) => x.code), has_draft: hasDraft,
      });
    }
    return out;
  }

  // ---------------- 拣料模式 ----------------

  private async draftIssue(tx: Tx, issueId: number) {
    await tx.$queryRaw`SELECT id FROM wms_issue WHERE id = ${issueId} FOR UPDATE`;
    const issue = await tx.materialIssue.findUnique({ where: { id: issueId }, include: { work_order: true, lines: { orderBy: { id: 'asc' } } } });
    if (!issue) throw new NotFound('领料单');
    if (issue.issue_type === 'RETURN') throw new BizError('退料单不需要拣料，清点后直接过账');
    if (issue.status !== 'DRAFT') throw new BizError(`领料单 ${issue.no} ${DOC_TEXT[issue.status] ?? issue.status}，不能再拣料`);
    return issue;
  }

  /** 从其他合格批次按 FEFO 补足（排除短缺的库存键，扣除所有待过账领料单已占用的数量） */
  private async replenish(tx: Tx, issue: MaterialIssue, wo: WorkOrder, materialId: number, need: number, exclude: Set<string>) {
    const m = await tx.material.findUnique({ where: { id: materialId } });
    const lots = m?.owner_customer_id ? await this.inv.availableLots(tx, materialId, m.owner_customer_id, false) : await this.inv.availableLots(tx, materialId, null, true);
    const drafts = await tx.materialIssueLine.findMany({ where: { material_id: materialId, issue: { status: 'DRAFT', issue_type: 'ISSUE' } } });
    const reserved = new Map<string, number>();
    for (const d of drafts) reserved.set(stockKey(d), round((reserved.get(stockKey(d)) ?? 0) + d.qty));
    const added: { lot_no: string; location_code: string; qty: number }[] = [];
    let remain = round(need);
    for (const s of lots) {
      if (remain <= EPS) break;
      const k = stockKey(s);
      if (exclude.has(k)) continue;
      if (s.owner_customer_id && s.owner_customer_id !== wo.customer_id) continue;
      const free = round(s.qty - (reserved.get(k) ?? 0));
      if (free <= EPS) continue;
      const take = round(Math.min(free, remain));
      await tx.materialIssueLine.create({
        data: { issue_id: issue.id, material_id: materialId, lot_no: s.lot_no, location_id: s.location_id, owner_customer_id: s.owner_customer_id, qty: take, expiry_date: s.expiry_date },
      });
      added.push({ lot_no: s.lot_no, location_code: s.location.code, qty: take });
      remain = round(remain - take);
    }
    return { added, short: Math.max(0, remain) };
  }

  private async issueOut(tx: Tx, id: number) {
    return ser('MaterialIssue', await tx.materialIssue.findUnique({ where: { id }, include: inc('MaterialIssue', ['lines']) }), ['lines']);
  }

  /**
   * 录入实拣数量：实拣 = 应拣 → 该行拣完；实拣 < 应拣（实物不足）→ 该行数量改为实拣数，差额自动从下一 FEFO 批次补足（新行待拣）；
   * 实拣 0 → 删除该行并整行补足。不能超过应拣数。
   */
  async pickLine(tx: Tx, user: CurrentUser, issueId: number, lineId: number, picked: number): Promise<PickResult> {
    const issue = await this.draftIssue(tx, issueId);
    const ln = issue.lines.find((l) => l.id === lineId);
    if (!ln) throw new BizError('该行不在本领料单中，请刷新');
    const p = round(Number(picked));
    if (!(p >= 0)) throw new BizError('实拣数量不能为负数');
    const mat = await tx.material.findUnique({ where: { id: ln.material_id } });
    if (p > ln.qty + EPS) throw new BizError(`${mat?.code} 实拣 ${g(p)} 超过应拣 ${g(ln.qty)}；多拣的请放回原库位`);
    const messages: string[] = [];
    if (p >= ln.qty - EPS) {
      await tx.materialIssueLine.update({ where: { id: ln.id }, data: { picked_qty: ln.qty } });
      messages.push(`${mat?.code} 批次 ${ln.lot_no || '-'} 已拣 ${g(ln.qty)}`);
    } else {
      const short = round(ln.qty - p);
      if (p <= EPS) await tx.materialIssueLine.delete({ where: { id: ln.id } });
      else await tx.materialIssueLine.update({ where: { id: ln.id }, data: { qty: p, picked_qty: p } });
      const loc = await tx.location.findUnique({ where: { id: ln.location_id } });
      const r = await this.replenish(tx, issue, issue.work_order, ln.material_id, short, new Set([stockKey(ln)]));
      messages.push(`${mat?.code} 批次 ${ln.lot_no || '-'}（${loc?.code}）实拣 ${g(p)}，少 ${g(short)}`);
      if (r.added.length) messages.push(`已自动从 ${r.added.map((a) => `批次 ${a.lot_no || '-'}（${a.location_code}）补 ${g(a.qty)}`).join('、')}，请继续拣`);
      if (r.short > EPS) messages.push(`仍缺 ${g(r.short)}：没有其他合格库存，过账后工单将显示缺料`);
      messages.push(`批次 ${ln.lot_no || '-'} 在 ${loc?.code} 实物少于账面，建议对该库位盘点`);
    }
    if (!(await tx.materialIssueLine.count({ where: { issue_id: issueId } }))) {
      throw new BizError('该领料单已没有可拣的行（全部缺料），请作废后重新生成');
    }
    return { issue: await this.issueOut(tx, issueId), messages };
  }

  /** 扫到拣料单以外的批次：确认后用该批次替换某行（同一物料；校验合格、货主、效期）；该批次可用数量不足时差额按 FEFO 补足 */
  async replaceLine(tx: Tx, user: CurrentUser, issueId: number, lineId: number, stockId: number): Promise<PickResult> {
    const issue = await this.draftIssue(tx, issueId);
    const ln = issue.lines.find((l) => l.id === lineId);
    if (!ln) throw new BizError('该行不在本领料单中，请刷新');
    const st = await tx.stock.findUnique({ where: { id: stockId }, include: { location: true, material: true } });
    if (!st) throw new BizError('该库存行已不存在，请重新扫码');
    if (st.material_id !== ln.material_id) throw new BizError(`扫到的是 ${st.material.code}，不是本行物料`);
    const wo = issue.work_order;
    if (st.status !== 'AVAILABLE') throw new BizError(`批次 ${st.lot_no} 质量状态为【${STATUS_TEXT[st.status] ?? st.status}】，不能领用`);
    if (st.location.location_type === 'REJECT') throw new BizError(`批次 ${st.lot_no} 在不合格品区 ${st.location.code}，不能领用`);
    if (st.owner_customer_id && st.owner_customer_id !== wo.customer_id) throw new BizError(`批次 ${st.lot_no} 为其他客户的客供料，不能用于本工单`);
    if (!st.owner_customer_id && st.material.owner_customer_id) throw new BizError(`批次 ${st.lot_no} 货主不符，不能用于本工单`);
    if (st.expiry_date && st.expiry_date.getTime() < today().getTime()) throw new BizError(`批次 ${st.lot_no} 已过期（${fmtDate(st.expiry_date)}），禁止使用`);
    if (stockKey(st) === stockKey(ln)) return { issue: await this.issueOut(tx, issueId), messages: ['就是本行批次，无需替换'] };
    const others = await tx.materialIssueLine.findMany({
      where: { material_id: st.material_id, lot_no: st.lot_no, location_id: st.location_id, owner_customer_id: st.owner_customer_id, issue: { status: 'DRAFT', issue_type: 'ISSUE' }, id: { not: ln.id } },
    });
    const free = round(st.qty - others.reduce((s, x) => s + x.qty, 0));
    if (free <= EPS) throw new BizError(`批次 ${st.lot_no}（${st.location.code}）的合格库存已全部被其他待过账领料单占用`);
    const take = round(Math.min(ln.qty, free));
    const rest = round(ln.qty - take);
    const messages = [`已用批次 ${st.lot_no}（${st.location.code}）替换 ${ln.lot_no || '-'}，数量 ${g(take)}`];
    if (ln.expiry_date && st.expiry_date && st.expiry_date.getTime() > ln.expiry_date.getTime()) {
      messages.push(`注意：替换批次有效期 ${fmtDate(st.expiry_date)} 晚于推荐批次 ${fmtDate(ln.expiry_date)}（先到期先出）`);
    }
    await tx.materialIssueLine.update({
      where: { id: ln.id },
      data: { lot_no: st.lot_no, location_id: st.location_id, owner_customer_id: st.owner_customer_id, expiry_date: st.expiry_date, qty: take, picked_qty: null },
    });
    if (rest > EPS) {
      const r = await this.replenish(tx, issue, wo, ln.material_id, rest, new Set([stockKey(st)]));
      if (r.added.length) messages.push(`差额 ${g(rest)} 已从 ${r.added.map((a) => `${a.lot_no || '-'}（${a.location_code}）`).join('、')} 补足`);
      if (r.short > EPS) messages.push(`仍缺 ${g(r.short)}`);
    }
    return { issue: await this.issueOut(tx, issueId), messages };
  }

  // ---------------- 冲销 ----------------

  private needReason(reason?: string | null) {
    const r = String(reason ?? '').trim();
    if (!r) throw new BizError('请填写冲销原因');
    return r;
  }

  /** 领料/退料单冲销：反向库存流水（ISSUE_REVERSE / RETURN_REVERSE）、回滚工单已领数量；工单已关闭或 DHR 已放行、批次已装配绑定、已有退料时拦截 */
  async reverseIssue(tx: Tx, user: CurrentUser, id: number, reasonIn: string, sig: SignatureDto | null | undefined) {
    await tx.$queryRaw`SELECT id FROM wms_issue WHERE id = ${id} FOR UPDATE`;
    const issue = await tx.materialIssue.findUnique({
      where: { id }, include: { lines: { orderBy: { id: 'asc' }, include: { material: true, location: true } }, work_order: { include: { materials: true } } },
    });
    if (!issue) throw new NotFound('领料单');
    const isReturn = issue.issue_type === 'RETURN';
    const name = isReturn ? '退料单' : '领料单';
    if (issue.status !== 'CONFIRMED') throw new BizError(`${name} ${issue.no} ${DOC_TEXT[issue.status] ?? issue.status}，只有已过账的单据才能冲销`);
    const reason = this.needReason(reasonIn);
    const wo = issue.work_order;
    if (wo.status === 'CLOSED' || wo.dhr_status === 'RELEASED') {
      throw new BizError(`工单 ${wo.no} 已${wo.status === 'CLOSED' ? '关闭' : '完成 DHR 放行'}，用料记录已归档，不能冲销${isReturn ? '' : '；多领的物料请走退料'}`);
    }
    if (!isReturn) {
      const ledger = await lotLedger(tx, wo.id);
      const want = new Map<string, number>();
      for (const ln of issue.lines) {
        const k = keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id);
        want.set(k, round((want.get(k) ?? 0) + ln.qty));
      }
      for (const ln of issue.lines) {
        const r = ledger.get(keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id));
        const can = r ? round(r.issued_qty - r.returned_qty - r.pending_qty) : 0;
        if ((want.get(keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id)) ?? 0) > can + EPS) {
          throw new BizError(`${ln.material.code} 批次 ${ln.lot_no || '-'} 已有退料（已退 ${g(r?.returned_qty ?? 0)}，待过账退料 ${g(r?.pending_qty ?? 0)}），不能整单冲销；请先冲销/作废相关退料单`);
        }
        if (ln.lot_no) {
          const bound = await tx.keyPartBinding.findFirst({ where: { material_id: ln.material_id, lot_no: ln.lot_no, serial: { wo_id: wo.id }, action: { in: ['BIND', 'INSTALL'] } }, include: { serial: true } });
          if (bound) throw new BizError(`${ln.material.code} 批次 ${ln.lot_no} 已装配到 SN ${bound.serial.sn}（关键件绑定），不能冲销；请走退料或返工流程`);
        }
      }
    }
    await this.esign.sign(tx, user, sig ? { ...sig, reason: sig.reason || reason } : sig, `${name}冲销`, 'wms_issue', issue.id, issue.no);
    const ref: Ref = { ref_type: 'ISSUE', ref_id: issue.id, ref_no: issue.no, username: user.username, remark: `冲销 ${issue.no}：${reason}`.slice(0, 250) };
    const woMats = new Map(wo.materials.map((m) => [m.material_id, m]));
    for (const ln of issue.lines) {
      const wm = woMats.get(ln.material_id);
      if (isReturn) {
        await this.inv.removeStock(tx, {
          material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty, owner_customer_id: ln.owner_customer_id, move_type: 'RETURN_REVERSE', ref,
        });
        if (wm) {
          wm.issued_qty = round((wm.issued_qty || 0) + ln.qty);
          await tx.workOrderMaterial.update({ where: { id: wm.id }, data: { issued_qty: wm.issued_qty } });
        }
      } else {
        const rl = await tx.receiptLine.findFirst({ where: { material_id: ln.material_id, lot_no: ln.lot_no }, orderBy: { id: 'asc' }, include: { receipt: true } });
        await this.inv.addStock(tx, {
          material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty, owner_customer_id: ln.owner_customer_id,
          move_type: 'ISSUE_REVERSE', ref, mfg_date: rl?.mfg_date ?? null, expiry_date: ln.expiry_date ?? rl?.expiry_date ?? null,
          supplier_id: rl?.receipt.supplier_id ?? null, supplier_lot: rl?.supplier_lot ?? null,
        });
        if (wm) {
          wm.issued_qty = Math.max(0, round((wm.issued_qty || 0) - ln.qty));
          await tx.workOrderMaterial.update({ where: { id: wm.id }, data: { issued_qty: wm.issued_qty } });
        }
      }
    }
    await tx.materialIssue.update({ where: { id }, data: { status: 'REVERSED', reversed_by: user.full_name, reversed_at: new Date(), reverse_reason: reason } });
    return this.issueOut(tx, id);
  }

  /** 发货单冲销：库存加回合格（SHIP_REVERSE）、序列号回到在库、扣回订单已发数量、生成红字应收；序列号已登记客户退货 / 订单已关闭时拦截 */
  async reverseShipment(tx: Tx, user: CurrentUser, id: number, reasonIn: string, sig: SignatureDto | null | undefined) {
    await tx.$queryRaw`SELECT id FROM wms_shipment WHERE id = ${id} FOR UPDATE`;
    const sh = await tx.shipment.findUnique({ where: { id }, include: { lines: { orderBy: { id: 'asc' }, include: { material: true } }, sales_order: true } });
    if (!sh) throw new NotFound('发货单');
    if (sh.status !== 'SHIPPED') throw new BizError(`发货单 ${sh.no} ${DOC_TEXT[sh.status] ?? sh.status}，只有已发货的单据才能冲销`);
    const reason = this.needReason(reasonIn);
    const so = sh.sales_order;
    if (so && ['CLOSED', 'CANCELLED'].includes(so.status)) throw new BizError(`销售订单 ${so.no} 已${so.status === 'CLOSED' ? '关闭' : '取消'}，不能冲销发货`);
    const lineSerials = sh.lines.map((ln) => (ln.serials ? (JSON.parse(ln.serials) as string[]) : []));
    for (const sns of lineSerials) {
      for (const s of sns) {
        const sn = await tx.serialNumber.findUnique({ where: { sn: s } });
        if (!sn || sn.status !== 'SHIPPED' || sn.shipment_id !== sh.id) {
          throw new BizError(`序列号 ${s} 当前状态为【${SN_TEXT[sn?.status ?? ''] ?? sn?.status ?? '不存在'}】（如已登记客户退货），不能冲销本发货单；请走客户退货流程`);
        }
      }
    }
    await this.esign.sign(tx, user, sig ? { ...sig, reason: sig.reason || reason } : sig, '发货单冲销', 'wms_shipment', sh.id, sh.no);
    const ref: Ref = { ref_type: 'SHIPMENT', ref_id: sh.id, ref_no: sh.no, username: user.username, remark: `冲销 ${sh.no}：${reason}`.slice(0, 250) };
    for (const [i, ln] of sh.lines.entries()) {
      const rl = await tx.receiptLine.findFirst({ where: { material_id: ln.material_id, lot_no: ln.lot_no }, orderBy: { id: 'asc' } });
      await this.inv.addStock(tx, {
        material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty, move_type: 'SHIP_REVERSE', ref,
        mfg_date: rl?.mfg_date ?? null, expiry_date: rl?.expiry_date ?? null,
      });
      for (const s of lineSerials[i]) {
        await tx.serialNumber.update({ where: { sn: s }, data: { status: 'IN_STOCK', location_id: ln.location_id, shipment_id: null, customer_id: null, shipped_at: null } });
      }
      if (ln.so_line_id) {
        const sol = await tx.salesOrderLine.findUnique({ where: { id: ln.so_line_id } });
        if (sol) await tx.salesOrderLine.update({ where: { id: sol.id }, data: { shipped_qty: Math.max(0, round((sol.shipped_qty || 0) - ln.qty)) } });
      }
    }
    if (so) {
      const soLines = await tx.salesOrderLine.findMany({ where: { order_id: so.id } });
      const all = soLines.every((l) => (l.shipped_qty || 0) + EPS >= l.qty);
      const any = soLines.some((l) => (l.shipped_qty || 0) > EPS);
      const status = all ? 'SHIPPED' : any ? 'PARTIAL_SHIPPED' : (await tx.workOrder.count({ where: { so_id: so.id, status: { not: 'CANCELLED' } } })) ? 'IN_PRODUCTION' : 'CONFIRMED';
      await tx.salesOrder.update({ where: { id: so.id }, data: { status } });
    }
    // 红字应收：与原应收对冲（原单据保留，余额合计为 0）
    const ars = await tx.financeDoc.findMany({ where: { doc_type: 'AR', ref_type: 'SHIPMENT', ref_no: sh.no } });
    for (const ar of ars) {
      if (num(ar.amount) <= 0) continue;
      await tx.financeDoc.create({
        data: {
          no: await this.numbering.nextNo(tx, 'AR'), doc_type: 'AR', customer_id: ar.customer_id, ref_type: 'SHIPMENT', ref_no: sh.no, doc_date: today(),
          currency: ar.currency, due_date: today(), amount: -num(ar.amount), exchange_rate: ar.exchange_rate,
          base_amount: ar.base_amount === null ? null : -num(ar.base_amount), status: 'OPEN',
          remark: `发货单 ${sh.no} 冲销，红字冲减应收 ${ar.no}：${reason}`, created_by: user.username,
        },
      });
    }
    await tx.shipment.update({ where: { id }, data: { status: 'REVERSED', reversed_by: user.full_name, reversed_at: new Date(), reverse_reason: reason } });
    return ser('Shipment', await tx.shipment.findUnique({ where: { id }, include: inc('Shipment', ['lines']) }), ['lines']);
  }

  /** 盘点冲销：按本单的盘点调整流水逐笔反向（ADJUST_REVERSE）；调整入库的库存已被用掉时会提示库存不足 */
  async reverseCount(tx: Tx, user: CurrentUser, id: number, reasonIn: string, sig: SignatureDto | null | undefined) {
    await tx.$queryRaw`SELECT id FROM wms_stock_count WHERE id = ${id} FOR UPDATE`;
    const sc = await tx.stockCount.findUnique({ where: { id } });
    if (!sc) throw new NotFound('盘点单');
    if (sc.status !== 'POSTED') throw new BizError(`盘点单 ${sc.no} ${DOC_TEXT[sc.status] ?? sc.status}，只有已过账的盘点单才能冲销`);
    const reason = this.needReason(reasonIn);
    await this.esign.sign(tx, user, sig ? { ...sig, reason: sig.reason || reason } : sig, '盘点单冲销', 'wms_stock_count', sc.id, sc.no);
    const moves = await tx.stockMove.findMany({ where: { ref_type: 'STOCK_COUNT', ref_id: sc.id, move_type: 'ADJUST' }, orderBy: { id: 'asc' } });
    const ref: Ref = { ref_type: 'STOCK_COUNT', ref_id: sc.id, ref_no: sc.no, username: user.username, remark: `冲销 ${sc.no}：${reason}`.slice(0, 250) };
    for (const mv of moves) {
      const k = { material_id: mv.material_id, lot_no: mv.lot_no, owner_customer_id: mv.owner_customer_id, qty: mv.qty, move_type: 'ADJUST_REVERSE', ref };
      if (mv.to_location_id) await this.inv.removeStock(tx, { ...k, location_id: mv.to_location_id, status: mv.to_status || 'AVAILABLE' });
      else if (mv.from_location_id) await this.inv.addStock(tx, { ...k, location_id: mv.from_location_id, status: mv.from_status || 'AVAILABLE' });
    }
    await tx.stockCount.update({ where: { id }, data: { status: 'REVERSED', reversed_by: user.full_name, reversed_at: new Date(), reverse_reason: reason } });
    return this.enrichCount(tx, id, true);
  }

  // ---------------- 盘点 ----------------

  /**
   * 盘点单详情：每行补充 current_qty（当前账面）、moved（快照后有流水）、diff_qty（实盘 − 当前账面；已过账为实际调整量）；
   * 盲盘且进行中时不返回账面/差异（review=true 复核时返回）。
   */
  async enrichCount(tx: Tx, id: number, review = false) {
    const sc = await tx.stockCount.findUnique({ where: { id }, include: inc('StockCount', ['lines']) });
    if (!sc) throw new NotFound('盘点单');
    const o: any = ser('StockCount', sc, ['lines']);
    const range = parseIds(sc.location_ids);
    o.range_codes = range.length ? (await tx.location.findMany({ where: { id: { in: range } }, orderBy: { code: 'asc' } })).map((l) => l.code) : [];
    const lines: any[] = o.lines;
    const hide = sc.blind && sc.status === 'OPEN' && !review;
    if (sc.status === 'OPEN') {
      const locIds = [...new Set(lines.map((l) => l.location_id))];
      const stocks = await tx.stock.findMany({ where: { location_id: { in: locIds } } });
      const cur = new Map(stocks.map((s) => [`${s.material_id}|${s.location_id}|${s.lot_no}|${s.status}|${s.owner_customer_id ?? ''}`, s.qty]));
      for (const l of lines) {
        l.current_qty = round(cur.get(`${l.material_id}|${l.location_id}|${l.lot_no}|${l.status}|${l.owner_customer_id ?? ''}`) ?? 0);
        const counted = l.counted_qty !== null && l.counted_qty !== undefined;
        // system_qty = 建单时账面，录入实盘时更新为录入时账面；与当前账面不同 = 期间有收发
        const changed = Math.abs(l.current_qty - (l.system_qty ?? 0)) > EPS;
        l.moved = changed; // 建单（或录入）后有收发
        l.recount = changed && counted; // 录入实盘后又有收发：实盘数已过时，须重新清点
        l.diff_qty = counted ? round(l.counted_qty - l.current_qty) : null;
      }
    } else {
      const adj = await tx.stockMove.findMany({ where: { ref_type: 'STOCK_COUNT', ref_id: sc.id, move_type: 'ADJUST' } });
      const byKey = new Map<string, number>();
      for (const mv of adj) {
        const loc = mv.to_location_id ?? mv.from_location_id;
        const k = `${mv.material_id}|${loc}|${mv.lot_no}|${mv.to_status ?? mv.from_status}|${mv.owner_customer_id ?? ''}`;
        byKey.set(k, round((byKey.get(k) ?? 0) + (mv.to_location_id ? mv.qty : -mv.qty)));
      }
      for (const l of lines) {
        l.diff_qty = sc.status === 'POSTED' || sc.status === 'REVERSED'
          ? round(byKey.get(`${l.material_id}|${l.location_id}|${l.lot_no}|${l.status}|${l.owner_customer_id ?? ''}`) ?? 0)
          : l.diff_qty;
      }
    }
    // 盲盘：不返回账面与差异，但保留“有收发 / 须重新清点”标记（不泄露数量）
    if (hide) for (const l of lines) { l.system_qty = null; l.current_qty = null; l.diff_qty = null; }
    o.book_hidden = hide;
    o.moved_count = lines.filter((l) => l.moved).length;
    o.recount_count = lines.filter((l) => l.recount).length;
    o.counted_count = lines.filter((l) => l.counted_qty !== null && l.counted_qty !== undefined).length;
    return o;
  }

  /** 录入实盘数：同时记下录入时的当前账面（system_qty），之后再有收发即标记“须重新清点” */
  async saveCountLines(tx: Tx, id: number, body: { id: number; counted_qty: number }[]) {
    const c = await tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
    if (!c) throw new NotFound('盘点单');
    if (c.status !== 'OPEN') throw new BizError(c.status === 'CANCELLED' ? '盘点单已作废，不能录入' : '盘点单已过账，不能再录入实盘');
    const byId = new Map(c.lines.map((l) => [l.id, l]));
    for (const ln of body) {
      const l = byId.get(ln.id);
      if (!l) continue;
      const book = await this.inv.lockedQty(tx, { material_id: l.material_id, location_id: l.location_id, lot_no: l.lot_no, status: l.status, owner_customer_id: l.owner_customer_id });
      await tx.stockCountLine.update({ where: { id: l.id }, data: { counted_qty: ln.counted_qty, system_qty: round(book) } });
    }
    return this.enrichCount(tx, id);
  }

  /** 盘点中新增行（盘盈 / 账上没有的批次）：库位须在盘点范围内，放置规则同收货；同一库存键不能重复 */
  async addCountLine(tx: Tx, user: CurrentUser, id: number, a: { material_id: number; location_id: number; lot_no?: string | null; status?: string | null; counted_qty: number }) {
    const sc = await tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
    if (!sc) throw new NotFound('盘点单');
    if (sc.status !== 'OPEN') throw new BizError('盘点单不是进行中，不能新增行');
    const m = await tx.material.findUnique({ where: { id: a.material_id } });
    if (!m) throw new NotFound('物料');
    const loc = await tx.location.findUnique({ where: { id: a.location_id } });
    if (!loc) throw new NotFound('库位');
    const range = parseIds(sc.location_ids);
    if (loc.warehouse_id !== sc.warehouse_id || (range.length && !range.includes(loc.id))) throw new BizError(`库位 ${loc.code} 不在本盘点单的范围内`);
    const qty = round(Number(a.counted_qty));
    if (!(qty >= 0)) throw new BizError('实盘数量不能为负数');
    const lot = String(a.lot_no ?? '').trim();
    if (m.lot_control && !lot) throw new BizError(`${m.code} 为批次管理物料，请扫描/填写批号`);
    const status = a.status || 'AVAILABLE';
    const owner = m.owner_customer_id ?? null;
    const dup = sc.lines.find((l) => l.material_id === m.id && l.location_id === loc.id && l.lot_no === lot && l.status === status && (l.owner_customer_id ?? null) === owner);
    if (dup) throw new BizError(`${m.code} 批次 ${lot || '-'} 在 ${loc.code} 已在盘点单中，请直接录入实盘数`);
    const place = await this.inv.checkPlacement(tx, { material_id: m.id, location_id: loc.id, owner_customer_id: owner });
    if (place.errors.length) throw new BizError(place.errors.join('；'));
    const book = await this.inv.lockedQty(tx, { material_id: m.id, location_id: loc.id, lot_no: lot, status, owner_customer_id: owner });
    await tx.stockCountLine.create({
      data: { count_id: sc.id, material_id: m.id, location_id: loc.id, lot_no: lot, status, owner_customer_id: owner, system_qty: book, counted_qty: qty },
    });
    return this.enrichCount(tx, id);
  }

  /** 作废盘点单（仅进行中；不影响库存） */
  async cancelCount(tx: Tx, user: CurrentUser, id: number, reason?: string | null) {
    await tx.$queryRaw`SELECT id FROM wms_stock_count WHERE id = ${id} FOR UPDATE`;
    const sc = await tx.stockCount.findUnique({ where: { id } });
    if (!sc) throw new NotFound('盘点单');
    if (sc.status !== 'OPEN') throw new BizError(`盘点单 ${sc.no} ${DOC_TEXT[sc.status] ?? sc.status}，只有进行中的盘点单可以作废`);
    const note = `作废（${user.full_name}）${reason ? `：${reason}` : ''}`;
    await tx.stockCount.update({ where: { id }, data: { status: 'CANCELLED', remark: [sc.remark, note].filter(Boolean).join('；') } });
    return this.enrichCount(tx, id);
  }

  // ---------------- 发货 / 退货扫码 ----------------

  /** 发货扫码校验：返回 ok 或具体拒绝原因（不是序列号 / 非本订单产品 / 未入库 / 未放行 / 已发货 / 已在其他待过账发货单…） */
  async serialCheck(tx: Tx, code: string, soId?: number | null) {
    const s = String(code ?? '').trim();
    const fail = (reason: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, reason, message, sn: s, ...extra });
    if (!s) return fail('EMPTY', '条码为空');
    const sn = await tx.serialNumber.findUnique({ where: { sn: s }, include: { material: true, release: true, shipment: { include: { customer: true } }, location: true } });
    if (!sn) {
      const lot = await tx.stock.findFirst({ where: { lot_no: s }, include: { material: true } });
      if (lot) return fail('LOT', `扫到的是物料批号 ${s}（${lot.material.code}），不是整机序列号。请扫机身或彩盒上的 SN 条码`);
      const m = await tx.material.findFirst({ where: { OR: [{ code: { equals: s, mode: 'insensitive' } }, { gtin: s }] } });
      if (m) return fail('MATERIAL', `扫到的是物料编码/GTIN ${s}（${m.code} ${m.name}），不是序列号。请扫 SN 条码`);
      const loc = await tx.location.findFirst({ where: { code: { equals: s, mode: 'insensitive' } } });
      if (loc) return fail('LOCATION', `扫到的是库位条码 ${loc.code}，请扫整机 SN`);
      return fail('NOT_FOUND', `序列号 ${s} 在系统中不存在，请核对标签是否为本厂产品`);
    }
    const base = { material_id: sn.material_id, material_code: sn.material.code, lot_no: sn.lot_no, status: sn.status };
    if (soId) {
      const sol = await tx.salesOrderLine.findFirst({ where: { order_id: soId, material_id: sn.material_id } });
      if (!sol) return fail('NOT_THIS_ORDER', `${s} 是 ${sn.material.code} ${sn.material.name}，本订单没有该产品，请放回`, base);
    }
    if (sn.status === 'SHIPPED') {
      return fail('SHIPPED', `${s} 已于 ${fmtDate(sn.shipped_at)} 随发货单 ${sn.shipment?.no ?? '-'} 发给 ${sn.shipment?.customer?.name ?? '客户'}，不能重复发货`, base);
    }
    if (sn.status === 'RETURNED') return fail('RETURNED', `${s} 是客户退回品（冻结，待 QA 处置），不能发货，请放回退货区`, base);
    if (sn.status === 'SCRAPPED') return fail('SCRAPPED', `${s} 已报废，不能发货，请隔离`, base);
    if (sn.status !== 'IN_STOCK') return fail('NOT_IN_STOCK', `${s} 当前为【${SN_TEXT[sn.status] ?? sn.status}】，尚未完工入库，不能发货`, base);
    if (!sn.release_id || !sn.release) return fail('NOT_RELEASED', `${s} 所在批次 ${sn.lot_no ?? ''} 尚未 DHR 放行，请联系 QA 放行后再发（先放回待放行区）`, base);
    if (sn.release.status !== 'RELEASED') return fail('RELEASE_REJECTED', `${s} 所在放行批 ${sn.release.no} 已被 QA 拒绝放行（冻结），禁止发货，请隔离`, base);
    const draft = await tx.shipmentLine.findFirst({ where: { serials: { contains: `"${s}"` }, shipment: { status: 'DRAFT' } }, include: { shipment: true } });
    if (draft) return fail('IN_DRAFT', `${s} 已在待过账发货单 ${draft.shipment.no} 中，请勿重复扫描`, base);
    return { ok: true, reason: 'OK', message: `${s} 可发货`, sn: s, ...base, location_code: sn.location?.code ?? null };
  }

  /** 客户退货扫码：解析序列号 → 产品、批号、客户、原订单、原发货单（不可退时给出原因） */
  async rmaScan(tx: Tx, code: string) {
    const s = String(code ?? '').trim();
    if (!s) throw new BizError('条码为空');
    const sn = await tx.serialNumber.findUnique({ where: { sn: s }, include: { material: true, customer: true, shipment: { include: { sales_order: true, customer: true } } } });
    if (!sn) {
      const lot = await tx.stock.findFirst({ where: { lot_no: s }, include: { material: true } });
      if (lot) throw new BizError(`扫到的是批号 ${s}（${lot.material.code}），序列号产品请扫机身 SN；非序列号物料请点“添加明细”`);
      throw new BizError(`序列号 ${s} 在系统中不存在，请核对标签`);
    }
    const out = {
      sn: sn.sn, status: sn.status, material_id: sn.material_id, material_code: sn.material.code, material_name: sn.material.name, lot_no: sn.lot_no,
      customer_id: sn.customer_id ?? sn.shipment?.customer_id ?? null, customer_name: sn.customer?.name ?? sn.shipment?.customer?.name ?? null,
      shipment_id: sn.shipment_id, shipment_no: sn.shipment?.no ?? null, ship_date: sn.shipment?.ship_date ?? sn.shipped_at ?? null,
      so_id: sn.shipment?.so_id ?? null, so_no: sn.shipment?.sales_order?.no ?? null, customer_po: sn.shipment?.sales_order?.customer_po ?? null,
    };
    if (sn.status !== 'SHIPPED') {
      throw new BizError(`序列号 ${s} 当前为【${SN_TEXT[sn.status] ?? sn.status}】，不是已发货产品，不能登记客户退货${sn.status === 'RETURNED' ? '（已登记过退货）' : ''}`);
    }
    return out;
  }

  /** 运单号 / 承运商补录（待过账或已发货均可） */
  async updateTracking(tx: Tx, user: CurrentUser, id: number, a: { carrier?: string | null; tracking_no?: string | null }) {
    const sh = await tx.shipment.findUnique({ where: { id } });
    if (!sh) throw new NotFound('发货单');
    if (!['DRAFT', 'SHIPPED'].includes(sh.status)) throw new BizError(`发货单 ${sh.no} ${DOC_TEXT[sh.status] ?? sh.status}，不能修改运单号`);
    const data: Record<string, string | null> = {};
    if (a.carrier !== undefined) data.carrier = a.carrier?.trim() || null;
    if (a.tracking_no !== undefined) data.tracking_no = a.tracking_no?.trim() || null;
    await tx.shipment.update({ where: { id }, data });
    return ser('Shipment', await tx.shipment.findUnique({ where: { id }, include: inc('Shipment', ['lines']) }), ['lines']);
  }

  // ---------------- 完工入库（逐台扫码） ----------------

  /** 完工入库（逐台扫码核对）：只入库扫到的序列号（须属本工单且“完工待入库”） */
  async fgReceiptSerials(tx: Tx, user: CurrentUser, woId: number, locationId: number, serials: string[]) {
    await tx.$queryRaw`SELECT id FROM mes_work_order WHERE id = ${woId} FOR NO KEY UPDATE`;
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { material: true } });
    if (!wo) throw new NotFound('工单');
    if (!['IN_PROGRESS', 'COMPLETED'].includes(wo.status)) throw new BizError('工单未开工或已关闭，不能完工入库');
    if (!wo.material.serial_control) throw new BizError('该产品不是序列号管理，请按数量完工入库');
    const list = [...new Set((serials ?? []).map((x) => String(x).trim()).filter(Boolean))];
    if (!list.length) throw new BizError('请扫描要入库的序列号');
    const loc = await tx.location.findUnique({ where: { id: locationId } });
    if (!loc || !loc.is_active) throw new BizError('入库库位不存在或已停用');
    const place = await this.inv.checkPlacement(tx, { material_id: wo.material_id, location_id: locationId, owner_customer_id: null });
    if (place.errors.length) throw new BizError(place.errors.join('；'));
    const sns = [];
    for (const s of list) {
      const sn = await tx.serialNumber.findUnique({ where: { sn: s } });
      if (!sn || sn.wo_id !== wo.id) throw new BizError(`序列号 ${s} 不属于工单 ${wo.no}`);
      if (sn.status !== 'COMPLETED') throw new BizError(`序列号 ${s} 当前为【${SN_TEXT[sn.status] ?? sn.status}】，${sn.status === 'IN_STOCK' ? '已入库' : '尚未完成全部工序'}，不能入库`);
      sns.push(sn);
    }
    const status = wo.dhr_status === 'RELEASED' ? 'AVAILABLE' : 'QUARANTINE';
    const t = today();
    const rc = await tx.receipt.create({
      data: { no: await this.numbering.nextNo(tx, 'RK'), receipt_type: 'PRODUCTION', wo_id: wo.id, receipt_date: t, status: 'CONFIRMED', created_by: user.username, remark: `逐台扫码入库 ${sns.length} 台` },
    });
    const ref: Ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: user.username, remark: `工单 ${wo.no} 完工入库（逐台扫码）` };
    const exp = wo.material.shelf_life_days ? addDays(t, wo.material.shelf_life_days) : null;
    for (const s of sns) await tx.serialNumber.update({ where: { id: s.id }, data: { status: 'IN_STOCK', location_id: locationId } });
    await tx.receiptLine.create({
      data: { receipt_id: rc.id, line_no: 1, material_id: wo.material_id, qty: sns.length, lot_no: wo.lot_no || '', location_id: locationId, status, mfg_date: t, expiry_date: exp },
    });
    await this.inv.addStock(tx, {
      material_id: wo.material_id, location_id: locationId, lot_no: wo.lot_no || '', status, qty: sns.length, move_type: 'FG_RECEIPT', ref, mfg_date: t, expiry_date: exp,
    });
    await tx.workOrder.update({ where: { id: wo.id }, data: { received_qty: round((wo.received_qty || 0) + sns.length, 4) } });
    return ser('Receipt', await tx.receipt.findUnique({ where: { id: rc.id }, include: inc('Receipt', ['lines']) }), ['lines']);
  }
}

