/**
 * RFID 作业会话（仓库）：一次收货 / 过门 / 领料核对 / 完工入库 / 发货核对 / 盘点 / 客户退货的读取集合。
 * 所有库存变动都复用现有仓储服务（WmsService / WmsOpsService / CustomerReturnsService → InventoryService），本文件不另写库存逻辑。
 *
 *   create(tx, user, a)            开始作业（收货台选采购单、领料选领料单、完工入库选工单、发货选发货单、盘点选库位、退货）；
 *                                  库门会话由门式读写器读取时自动生成，不需要手工开始
 *   detail(db, id)                 会话 + 每个标签的核对结果（level/message）+ 汇总 check + 能否确认（blockers）——作业台轮询它
 *   manual(tx, user, id, code)     条码/手输兜底：EPC、序列号（含 UDI）、批号 → 标签（视同一次读取，source=MANUAL）
 *   ignore / restore               误读处理：标记为误读（不参与本次作业，原始读取保留）/ 恢复
 *   bind / unbind                  收货台：读到的新标签绑定到到货明细（发卡在确认时生成）
 *   confirm(tx, user, id, body)    按类型过账：收货 → 入库单 + 发卡；库门 → 调拨（仓管确认后才移库）；领料 → 拣料 + 领料过账；
 *                                  完工入库 → 完工入库单；发货 → 发货过账；盘点 → 盘点单录入实盘（可直接过账，按当前账面）；退货 → 客户退货单
 *   cancel(tx, user, id, reason)   取消（不影响库存；原始读取保留）
 *   simCandidates(db, a)           模拟读取的候选标签（仅演示/测试）
 */
import { Injectable } from '@nestjs/common';
import type { Location, RfidReader, RfidSession, RfidSessionTag, RfidTag, SerialNumber, Stock } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, fmtDate } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { inc, ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { InventoryService, STATUS_TEXT } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { CustomerReturnsService } from '../wms/customer-returns.service';
import { WmsOpsService } from '../wms/ops.service';
import { suggestLocation } from '../wms/placement';
import { WmsService } from '../wms/wms.service';
import { normEpc } from './epc';
import { RfidService, SESSION_TYPE } from './rfid.service';

const SN_TEXT: Record<string, string> = {
  CREATED: '待生产', IN_PROCESS: '在制', NG: '不良待处置', COMPLETED: '完工待入库', IN_STOCK: '在库', SHIPPED: '已发货', SCRAPPED: '已报废', RETURNED: '客户退回',
};
const STATUS_ZH: Record<string, string> = { OPEN: '进行中', CONFIRMED: '已确认', CANCELLED: '已取消' };

type Level = 'ok' | 'warn' | 'error' | 'info' | 'done' | 'ignored';
type TagFull = RfidTag & { material: any; location: (Location & { warehouse: any }) | null; serial: (SerialNumber & { release: any; material: any }) | null };

export interface CreateSessionArgs {
  session_type: string; reader_id: number; po_id?: number | null; issue_id?: number | null; wo_id?: number | null;
  shipment_id?: number | null; location_id?: number | null; remark?: string | null;
}

export interface BindArgs {
  epcs?: string[] | null; po_line_id: number; qty: number; lot_no?: string | null; supplier_lot?: string | null;
  mfg_date?: string | null; expiry_date?: string | null; location_id: number;
}

export interface ConfirmArgs {
  confirm_placement?: boolean; delivery_note?: string | null;
  items?: { epc: string; direction?: string | null; to_location_id?: number | null }[] | null;
  partial?: boolean; post?: boolean; uncounted_as_book?: boolean; reason?: string | null; location_id?: number | null;
}

/** 业务异常的中文提示（BizError / HttpException） */
const errMsg = (e: any): string => {
  const r = typeof e?.getResponse === 'function' ? e.getResponse() : null;
  return (r && typeof r === 'object' ? (r as any).detail : null) ?? e?.message ?? '操作失败';
};

const lotKey = (material_id: number | null | undefined, lot: string | null | undefined, owner?: number | null) => `${material_id}|${lot ?? ''}|${owner ?? ''}`;

@Injectable()
export class RfidSessionService {
  constructor(
    private readonly numbering: NumberingService,
    private readonly inv: InventoryService,
    private readonly rfid: RfidService,
    private readonly wms: WmsService,
    private readonly ops: WmsOpsService,
    private readonly rma: CustomerReturnsService,
  ) {}

  // ---------------- 开始 / 列表 ----------------

  async create(tx: Tx, user: CurrentUser, a: CreateSessionArgs) {
    const type = a.session_type;
    if (!SESSION_TYPE[type]) throw new BizError('作业类型不正确');
    if (type === 'GATE') throw new BizError('库门会话由门式读写器读到标签时自动生成，不需要手工开始');
    const r = await tx.rfidReader.findUnique({ where: { id: a.reader_id } });
    if (!r) throw new NotFound('读写器');
    if (!r.is_active) throw new BizError(`读写器 ${r.code} 已停用`);
    if (r.purpose === 'GATE') throw new BizError(`${r.name} 是库门读写器，只用于过门；请选择收货台、发货口或手持读写器`);
    await tx.$queryRaw`SELECT id FROM rfid_reader WHERE id = ${r.id} FOR UPDATE`; // 同一读写器同时只能有一个进行中的作业
    const busy = await tx.rfidSession.findFirst({ where: { reader_id: r.id, status: 'OPEN' } });
    if (busy) {
      throw new BizError(`读写器 ${r.name} 正在用于${SESSION_TYPE[busy.session_type]}作业 ${busy.no}（${busy.created_by ?? ''}），请先确认或取消该作业，或换一台读写器`);
    }
    const data: any = { session_type: type, reader_id: r.id, location_id: a.location_id ?? null, remark: a.remark ?? null };
    if (type === 'RECEIVE') {
      const po = a.po_id ? await tx.purchaseOrder.findUnique({ where: { id: a.po_id } }) : null;
      if (!po) throw new BizError('请选择采购订单（或扫送货单上的采购单号）');
      if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) throw new BizError(`采购订单 ${po.no} 不是待收货状态（已审批/部分到货），不能收货`);
      data.po_id = po.id;
      data.location_id ??= r.location_id;
    } else if (type === 'ISSUE') {
      const is = a.issue_id ? await tx.materialIssue.findUnique({ where: { id: a.issue_id } }) : null;
      if (!is) throw new BizError('请选择领料单');
      if (is.issue_type !== 'ISSUE' || is.status !== 'DRAFT') throw new BizError(`领料单 ${is.no} 不是待过账的领料单`);
      data.issue_id = is.id;
    } else if (type === 'FG_RECEIPT') {
      const wo = a.wo_id ? await tx.workOrder.findUnique({ where: { id: a.wo_id }, include: { material: true } }) : null;
      if (!wo) throw new BizError('请选择生产工单');
      if (!['IN_PROGRESS', 'COMPLETED'].includes(wo.status)) throw new BizError(`工单 ${wo.no} 未开工或已关闭，不能完工入库`);
      if (!wo.material.serial_control) throw new BizError(`${wo.material.code} 不是序列号产品，请在工单详情按数量完工入库`);
      data.wo_id = wo.id;
      data.location_id ??= (await suggestLocation(tx, wo.material))?.id ?? null;
      if (!data.location_id) throw new BizError('请选择入库库位');
    } else if (type === 'SHIP') {
      const sh = a.shipment_id ? await tx.shipment.findUnique({ where: { id: a.shipment_id } }) : null;
      if (!sh) throw new BizError('请选择发货单');
      if (sh.status !== 'DRAFT') throw new BizError(`发货单 ${sh.no} 不是待过账状态`);
      data.shipment_id = sh.id;
    } else if (type === 'COUNT') {
      const loc = a.location_id ? await tx.location.findUnique({ where: { id: a.location_id } }) : null;
      if (!loc) throw new BizError('请选择要盘点的库位（或扫库位标签）');
    } else if (type === 'RETURN') {
      data.location_id ??= (await tx.location.findFirst({ where: { is_active: true, location_type: 'REJECT' }, orderBy: { code: 'asc' } }))?.id ?? null;
    }
    const s = await tx.rfidSession.create({ data: { ...data, no: await this.numbering.nextNo(tx, 'RF'), status: 'OPEN', created_by: user.username } });
    return this.detail(tx, s.id);
  }

  sessionOut(s: any, extra: Record<string, unknown> = {}) {
    return { ...ser('RfidSession', s), type_text: SESSION_TYPE[s.session_type] ?? s.session_type, status_text: STATUS_ZH[s.status] ?? s.status, ...extra };
  }

  /** 列表：每个会话附上标签数、待处理数（库门待确认用）与关联单号 */
  async list(db: Tx, q: { status?: string; session_type?: string; reader_id?: number; page?: number; page_size?: number }) {
    const where: any = {};
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.session_type) where.session_type = { in: q.session_type.split(',') };
    if (q.reader_id) where.reader_id = q.reader_id;
    const page = Math.max(1, q.page || 1);
    const size = Math.min(200, Math.max(1, q.page_size || 50));
    const [total, rows] = await Promise.all([
      db.rfidSession.count({ where }),
      db.rfidSession.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size, include: inc('RfidSession') }),
    ]);
    const ids = rows.map((r) => r.id);
    const counts = ids.length ? await db.rfidSessionTag.groupBy({ by: ['session_id'], where: { session_id: { in: ids } }, _count: { _all: true } }) : [];
    const pend = ids.length ? await db.rfidSessionTag.groupBy({ by: ['session_id'], where: { session_id: { in: ids }, action: null }, _count: { _all: true } }) : [];
    const cn = new Map(counts.map((c) => [c.session_id, c._count._all]));
    const pn = new Map(pend.map((c) => [c.session_id, c._count._all]));
    const items = [];
    for (const r of rows) items.push(this.sessionOut(r, { tag_count: cn.get(r.id) ?? 0, pending_count: pn.get(r.id) ?? 0, context_no: await this.contextNo(db, r) }));
    return { items, total, page, page_size: size };
  }

  private async contextNo(db: Tx, s: RfidSession): Promise<string | null> {
    if (s.po_id) return (await db.purchaseOrder.findUnique({ where: { id: s.po_id } }))?.no ?? null;
    if (s.issue_id) return (await db.materialIssue.findUnique({ where: { id: s.issue_id } }))?.no ?? null;
    if (s.wo_id) return (await db.workOrder.findUnique({ where: { id: s.wo_id } }))?.no ?? null;
    if (s.shipment_id) return (await db.shipment.findUnique({ where: { id: s.shipment_id } }))?.no ?? null;
    if (s.session_type === 'COUNT' && s.location_id) return (await db.location.findUnique({ where: { id: s.location_id } }))?.code ?? null;
    return null;
  }

  private async mustOpen(tx: Tx, id: number, lock = false) {
    if (lock) await tx.$queryRaw`SELECT id FROM rfid_session WHERE id = ${id} FOR UPDATE`;
    const s = await tx.rfidSession.findUnique({ where: { id }, include: { reader: true } });
    if (!s) throw new NotFound('作业会话');
    if (s.status !== 'OPEN') throw new BizError(`作业 ${s.no} ${STATUS_ZH[s.status]}，不能再修改`);
    return s;
  }

  // ---------------- 详情（核对结果） ----------------

  private async loadTags(db: Tx, epcs: string[]): Promise<Map<string, TagFull>> {
    const list = epcs.filter((e) => !e.startsWith('SN:'));
    if (!list.length) return new Map();
    const rows = await db.rfidTag.findMany({
      where: { epc: { in: list } },
      include: { material: true, location: { include: { warehouse: true } }, serial: { include: { release: true, material: true } } },
    });
    return new Map(rows.map((t) => [t.epc, t as TagFull]));
  }

  /** 会话详情 + 核对：items[].level（ok/warn/error/info/done/ignored）与 message；check = 按类型汇总；blockers = 不能确认的原因 */
  async detail(db: Tx, id: number) {
    const s = (await db.rfidSession.findUnique({ where: { id }, include: { ...inc('RfidSession'), items: { orderBy: { id: 'asc' } } } })) as (RfidSession & { items: RfidSessionTag[]; reader: RfidReader | null }) | null;
    if (!s) throw new NotFound('作业会话');
    const tags = await this.loadTags(db, s.items.map((i) => i.epc));
    const eff = await this.effQty(db, [...tags.values()].filter((t) => t.status === 'ACTIVE'));
    // 兜底的无标签序列号
    const pseudoSns = s.items.filter((i) => i.epc.startsWith('SN:')).map((i) => i.epc.slice(3));
    const snRows = pseudoSns.length ? await db.serialNumber.findMany({ where: { sn: { in: pseudoSns } }, include: { release: true, material: true } }) : [];
    const snBy = new Map(snRows.map((x) => [x.sn, x]));
    const items: any[] = s.items.map((i) => {
      const t = tags.get(i.epc) ?? null;
      const serial = t?.serial ?? (i.epc.startsWith('SN:') ? snBy.get(i.epc.slice(3)) ?? null : null);
      return {
        id: i.id, epc: i.epc, source: i.source, read_count: i.read_count, max_rssi: i.max_rssi, antennas: i.antennas, direction: i.direction,
        first_seen: i.first_seen, last_seen: i.last_seen, action: i.action, action_note: i.action_note,
        po_line_id: i.po_line_id, bind_qty: i.qty, bind_lot_no: i.lot_no, bind_supplier_lot: i.supplier_lot, bind_location_id: i.location_id,
        bind_mfg_date: fmtDate(i.mfg_date), bind_expiry_date: fmtDate(i.expiry_date),
        known: !!t, tag_id: t?.id ?? null, tag_type: t?.tag_type ?? (serial ? 'UNIT' : null), tag_status: t?.status ?? null,
        material_id: t?.material_id ?? serial?.material_id ?? null, material_code: t?.material?.code ?? serial?.material?.code ?? null,
        material_name: t?.material?.name ?? serial?.material?.name ?? null, uom: t?.material?.uom ?? serial?.material?.uom ?? null,
        lot_no: t?.lot_no ?? serial?.lot_no ?? null, qty: t ? (eff.get(t.id) ?? t.qty) : serial ? 1 : null, tag_qty: t?.qty ?? null,
        qty_note: t && eff.has(t.id) && (t.qty ?? 0) - (eff.get(t.id) ?? 0) > EPS ? `标签发卡 ${g(t.qty)}，账面剩 ${g(eff.get(t.id))}` : null,
        owner_customer_id: t?.owner_customer_id ?? null,
        location_id: t?.location_id ?? null, location_code: t?.location?.code ?? null, warehouse_id: t?.location?.warehouse_id ?? null,
        sn: serial?.sn ?? null, sn_status: serial?.status ?? null, sn_status_text: serial ? SN_TEXT[serial.status] ?? serial.status : null,
        level: 'info' as Level, message: '',
        _tag: t, _serial: serial,
      };
    });
    const ctx: any = { s, items, blockers: [] as string[], check: {} as any };
    for (const it of items) {
      if (it.action === 'IGNORED') { it.level = 'ignored'; it.message = `已标记为误读${it.action_note ? `：${it.action_note}` : ''}`; }
      else if (it.action === 'DONE') { it.level = 'done'; it.message = it.action_note || '已处理'; }
      else if (it.tag_status === 'VOID') { it.level = 'warn'; it.message = '已作废的标签（换标后留下的旧标签），请撕掉或标记为误读'; }
      else if (!it.known && !it.sn) { it.level = 'warn'; it.message = '未登记的标签（系统中没有这个 EPC）'; }
    }
    const type = s.session_type;
    if (type === 'RECEIVE') await this.evalReceive(db, ctx);
    else if (type === 'GATE') await this.evalGate(db, ctx);
    else if (type === 'ISSUE') await this.evalIssue(db, ctx);
    else if (type === 'FG_RECEIPT') await this.evalFg(db, ctx);
    else if (type === 'SHIP') await this.evalShip(db, ctx);
    else if (type === 'COUNT') await this.evalCount(db, ctx);
    else if (type === 'RETURN') await this.evalReturn(db, ctx);
    const active = items.filter((i) => !i.action);
    if (s.status === 'OPEN') {
      const bad = active.filter((i) => i.level === 'error');
      if (bad.length && type !== 'GATE') ctx.blockers.unshift(`有 ${bad.length} 个标签不符合本次作业（红色行），请把实物拿开并“标记为误读”，或按提示处理`);
    }
    const out = items.map(({ _tag, _serial, ...rest }) => rest);
    const unknown = out.filter((i) => !i.known && !i.sn && !i.action).map((i) => i.epc);
    const reader = s.reader;
    return {
      session: this.sessionOut(s, { context_no: await this.contextNo(db, s) }),
      reader: reader ? this.rfid.readerOut({ ...reader, warehouse: null, location: null, outside_location: null }) : null,
      items: out,
      summary: {
        tags: items.length, pending: active.length, ignored: items.filter((i) => i.action === 'IGNORED').length,
        reads: items.reduce((n, i) => n + (i.read_count || 0), 0), unknown: unknown.length,
      },
      unknown,
      check: ctx.check,
      blockers: s.status === 'OPEN' ? ctx.blockers : [],
      can_confirm: s.status === 'OPEN' && !ctx.blockers.length,
    };
  }

  /**
   * 包装标签的“有效数量”：同一库位同一批次（物料+批号+货主）的账面数量，按发卡先后从新到旧分配给该库位的启用包装标签
   * （先到先用，旧包先用完）。不经 RFID 的领用（条码兜底、电脑页面）不会改标签数量，这里按账面纠正，避免盘点按发卡数量误判盘盈。
   */
  private async effQty(db: Tx, tags: Pick<RfidTag, 'id' | 'tag_type' | 'material_id' | 'lot_no' | 'owner_customer_id' | 'location_id' | 'qty'>[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const groups = new Map<string, typeof tags>();
    for (const t of tags) {
      if (t.tag_type !== 'PACKAGE' || !t.location_id || !t.material_id) continue;
      const k = `${lotKey(t.material_id, t.lot_no, t.owner_customer_id)}@${t.location_id}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    for (const ts of groups.values()) {
      const t0 = ts[0];
      const key = { material_id: t0.material_id!, lot_no: t0.lot_no ?? '', owner_customer_id: t0.owner_customer_id ?? null, location_id: t0.location_id! };
      const all = await db.rfidTag.findMany({ where: { status: 'ACTIVE', tag_type: 'PACKAGE', ...key, lot_no: t0.lot_no }, orderBy: { id: 'desc' } });
      let left = (await db.stock.aggregate({ where: key, _sum: { qty: true } }))._sum.qty ?? 0;
      for (const a of all) {
        const e = round(Math.max(0, Math.min(a.qty ?? 0, left)));
        left = round(left - e);
        out.set(a.id, e);
      }
    }
    return out;
  }

  // ----- 收货 -----
  private async evalReceive(db: Tx, ctx: any) {
    const s: RfidSession = ctx.s;
    const po = await db.purchaseOrder.findUnique({ where: { id: s.po_id! }, include: { supplier: true, lines: { orderBy: { line_no: 'asc' }, include: { material: true } } } });
    const sug = new Map<number, any>();
    if (s.status === 'OPEN' && po) {
      const rc = await this.ops.receiveContext(db, String(po.id)).catch(() => null);
      for (const l of rc?.lines ?? []) sug.set(l.po_line_id, l.suggest_location);
    }
    const locIds = [...new Set(ctx.items.map((i: any) => i.bind_location_id).filter(Boolean))] as number[];
    const locs = new Map((await db.location.findMany({ where: { id: { in: locIds } } })).map((l) => [l.id, l.code]));
    const lineBy = new Map((po?.lines ?? []).map((l) => [l.id, l]));
    for (const it of ctx.items) {
      it.bind_location_code = it.bind_location_id ? locs.get(it.bind_location_id) ?? null : null;
      if (it.action) continue;
      if (it.known || it.sn) {
        it.level = 'info';
        it.message = it.tag_status === 'VOID' ? '已作废的旧标签，不参与本次收货' : `已登记标签：${it.material_code ?? ''} 批次 ${it.lot_no || '-'}（旁边的货或已贴标的包装，不参与本次收货）`;
      } else if (it.po_line_id) {
        const l = lineBy.get(it.po_line_id);
        it.level = 'ok';
        it.message = `新标签 → 第 ${l?.line_no ?? '?'} 行 ${l?.material.code ?? ''}，${g(it.bind_qty)} ${l?.material.uom ?? ''}，批号 ${it.bind_lot_no || '（自动生成）'}，库位 ${it.bind_location_code ?? '-'}`;
        it.material_code = l?.material.code ?? null;
        it.material_name = l?.material.name ?? null;
      } else {
        it.level = 'warn';
        it.message = '新标签，待绑定到到货明细（选择订单行、填写每包数量后点“绑定”）';
      }
    }
    const fresh = ctx.items.filter((i: any) => !i.action && !i.known && !i.sn);
    const lines = (po?.lines ?? []).map((l) => {
      const bound = fresh.filter((i: any) => i.po_line_id === l.id);
      const remaining = Math.max(0, round(l.qty - (l.received_qty || 0)));
      const qty = round(bound.reduce((n: number, i: any) => n + (i.bind_qty || 0), 0));
      return {
        po_line_id: l.id, line_no: l.line_no, material_id: l.material_id, material_code: l.material.code, material_name: l.material.name, uom: l.material.uom,
        lot_control: l.material.lot_control, msl_level: l.material.msl_level, iqc_required: l.material.iqc_required, shelf_life_days: l.material.shelf_life_days,
        ordered: l.qty, received: l.received_qty || 0, remaining, max_qty: round(remaining * 1.05), bound_tags: bound.length, bound_qty: qty,
        over: qty > remaining * 1.05 + EPS, suggest_location: sug.get(l.id) ?? null,
      };
    });
    ctx.check = {
      po: po ? { id: po.id, no: po.no, status: po.status, supplier_name: po.supplier?.name ?? null } : null,
      lines, new_tags: fresh.length, unbound: fresh.filter((i: any) => !i.po_line_id).length, bound: fresh.filter((i: any) => i.po_line_id).length,
    };
    if (s.status !== 'OPEN') return;
    if (ctx.check.unbound) ctx.blockers.push(`还有 ${ctx.check.unbound} 张新标签没有绑定到到货明细（绑定或标记为误读）`);
    if (!ctx.check.bound) ctx.blockers.push('还没有绑定任何标签：把贴好空白标签的包装放上收货台读取，再绑定到订单行');
    for (const l of lines) if (l.over) ctx.blockers.push(`第 ${l.line_no} 行 ${l.material_code} 绑定数量 ${g(l.bound_qty)} 超过订单剩余 ${g(l.remaining)}（允许超收 5%）`);
  }

  // ----- 库门 -----
  /** 库门：按方向给出建议目标库位；进库 = 物料建议库位（须在本仓）否则读写器库内侧默认库位；出库 = 读写器外侧库位 */
  private async gatePlan(db: Tx, reader: RfidReader | null, it: any) {
    const t: TagFull | null = it._tag;
    const dir = it.direction;
    if (!reader || !t || t.status !== 'ACTIVE') return null;
    if (!dir) return { error: null, warn: '方向不明（只被一侧天线读到或进出折返，可能是门边静止货物），请选择方向或标记为误读', to: null };
    if (!t.location_id) return { error: '标签记录不在库（已领用完、已发货或未入库），不能移库', to: null };
    let to: Location | null = null;
    if (it.bind_location_id) to = await db.location.findUnique({ where: { id: it.bind_location_id } });
    else if (dir === 'IN') {
      if (reader.warehouse_id && t.location?.warehouse_id === reader.warehouse_id) return { info: `已在库内（${t.location?.code}），无需移库`, to: null };
      const sug = t.material ? await suggestLocation(db, t.material) : null;
      const sl = sug ? await db.location.findUnique({ where: { id: sug.id } }) : null;
      to = sl && (!reader.warehouse_id || sl.warehouse_id === reader.warehouse_id) ? sl : reader.location_id ? await db.location.findUnique({ where: { id: reader.location_id } }) : null;
      if (!to) return { error: '读写器没有设置库内侧默认库位，请选择目标库位', to: null };
    } else {
      if (!reader.outside_location_id) return { error: '读写器没有设置外侧库位，出库方向只记录不移库（请在读写器管理中设置）', to: null };
      to = await db.location.findUnique({ where: { id: reader.outside_location_id } });
    }
    if (!to) return { error: '目标库位不存在', to: null };
    if (to.id === t.location_id) return { info: `已在 ${to.code}，无需移库`, to: null };
    const stock = await this.stockFor(db, t, t.location_id);
    if (!stock) return { error: `账上 ${t.location?.code} 没有该批次库存（账实不符，请盘点该库位）`, to };
    return { to, stock };
  }

  /** 标签对应的库存行（物料+批次+货主+库位；优先合格，其次待检、冻结） */
  private async stockFor(db: Tx, t: Pick<RfidTag, 'material_id' | 'lot_no' | 'owner_customer_id'>, locationId: number): Promise<Stock | null> {
    const rows = await db.stock.findMany({ where: { material_id: t.material_id!, lot_no: t.lot_no ?? '', owner_customer_id: t.owner_customer_id ?? null, location_id: locationId, qty: { gt: EPS } } });
    const order = ['AVAILABLE', 'QUARANTINE', 'HOLD', 'REJECTED'];
    return rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0] ?? null;
  }

  private async evalGate(db: Tx, ctx: any) {
    const s = ctx.s;
    const reader: RfidReader | null = s.reader;
    let toMove = 0;
    for (const it of ctx.items) {
      it.direction_text = it.direction === 'IN' ? '进库' : it.direction === 'OUT' ? '出库' : '方向不明';
      if (it.action || !it.known || it.tag_status !== 'ACTIVE') continue;
      const p: any = await this.gatePlan(db, reader, it);
      if (!p) continue;
      it.from_location_code = it.location_code;
      it.to_location_id = p.to?.id ?? null;
      it.to_location_code = p.to?.code ?? null;
      if (p.error) { it.level = 'error'; it.message = p.error; }
      else if (p.warn) { it.level = 'warn'; it.message = p.warn; }
      else if (p.info) { it.level = 'info'; it.message = p.info; it.no_move = true; }
      else {
        const st: Stock = p.stock;
        const q = Math.min(it.qty ?? st.qty, st.qty);
        it.move_qty = round(q);
        it.level = 'ok';
        it.message = `${it.direction_text}：${it.location_code} → ${p.to.code}，${g(q)} ${it.uom ?? ''}${st.status !== 'AVAILABLE' ? `（${STATUS_TEXT[st.status] ?? st.status}）` : ''}${it.qty_note ? `（${it.qty_note}，按账面移）` : ''}，待确认`;
        toMove += 1;
      }
    }
    const pending = ctx.items.filter((i: any) => !i.action);
    ctx.check = {
      to_move: toMove, pending: pending.length,
      unclear: pending.filter((i: any) => i.known && !i.direction).length,
      in: pending.filter((i: any) => i.direction === 'IN').length, out: pending.filter((i: any) => i.direction === 'OUT').length,
    };
    if (s.status === 'OPEN' && !pending.length) ctx.blockers.push('没有待处理的标签');
  }

  // ----- 领料核对 -----
  private async evalIssue(db: Tx, ctx: any) {
    const s = ctx.s;
    const issue = await db.materialIssue.findUnique({
      where: { id: s.issue_id }, include: { work_order: true, lines: { orderBy: { id: 'asc' }, include: { material: true, location: true } } },
    });
    if (!issue) throw new NotFound('领料单');
    const mats = new Set(issue.lines.map((l) => l.material_id));
    const groups = new Map<string, { lines: typeof issue.lines; need: number; pkgs: any[] }>();
    for (const l of issue.lines) {
      const k = lotKey(l.material_id, l.lot_no, l.owner_customer_id);
      const gr = groups.get(k) ?? { lines: [], need: 0, pkgs: [] };
      gr.lines.push(l);
      gr.need = round(gr.need + l.qty);
      groups.set(k, gr);
    }
    for (const it of ctx.items) {
      if (it.action || !it.known || it.tag_status !== 'ACTIVE') continue;
      if (it.tag_type === 'UNIT') { it.level = 'error'; it.message = `成品单台标签（${it.sn ?? ''}），不是原材料包装，多读`; continue; }
      if (!mats.has(it.material_id)) { it.level = 'error'; it.message = `多读：${it.material_code} 不在本领料单上，请拿开`; continue; }
      const k = lotKey(it.material_id, it.lot_no, it.owner_customer_id);
      const gr = groups.get(k);
      if (!gr) {
        const want = [...new Set(issue.lines.filter((l) => l.material_id === it.material_id).map((l) => l.lot_no || '-'))].join('、');
        it.level = 'error';
        it.message = `读错批次：${it.material_code} 本单应领批次 ${want}，读到 ${it.lot_no || '-'}（如要改用此批次，请到条码拣料页替换批次）`;
        continue;
      }
      if (!it.location_id) { it.level = 'error'; it.message = '标签记录不在库（已领用完或未入库），请核对实物'; continue; }
      if (!((it.qty ?? 0) > EPS)) { it.level = 'error'; it.message = `本包账面已用完（${it.qty_note ?? '数量 0'}），请核对实物`; continue; }
      gr.pkgs.push(it);
    }
    const lines: any[] = [];
    for (const gr of groups.values()) {
      let covered = 0;
      for (const p of gr.pkgs) {
        if (covered + EPS >= gr.need) { p.level = 'error'; p.message = `多读：批次 ${p.lot_no || '-'} 已够数（应领 ${g(gr.need)}），这一包不需要，请拿开`; continue; }
        const use = round(Math.min(p.qty ?? 0, gr.need - covered));
        covered = round(covered + (p.qty ?? 0));
        p.use_qty = use;
        const locOk = gr.lines.some((l) => l.location_id === p.location_id);
        p.level = locOk ? 'ok' : 'warn';
        p.message = `本包 ${g(p.qty)}，本次领 ${g(use)}${(p.qty ?? 0) - use > EPS ? `，剩 ${g(round((p.qty ?? 0) - use))} 拆包后放回` : ''}${locOk ? '' : `（库位不符：单上为 ${[...new Set(gr.lines.map((l) => l.location?.code))].join('、')}，标签记录在 ${p.location_code}）`}`;
      }
      let left = covered;
      for (const l of gr.lines) {
        const got = round(Math.min(left, l.qty));
        left = round(left - got);
        const done = l.picked_qty !== null && l.picked_qty !== undefined;
        lines.push({
          line_id: l.id, material_id: l.material_id, material_code: l.material.code, material_name: l.material.name, uom: l.material.uom, lot_no: l.lot_no,
          location_code: l.location?.code ?? null, qty: l.qty, read_qty: got, short: round(l.qty - got), picked: done,
          status: got + EPS >= l.qty ? 'OK' : got > EPS ? 'PARTIAL' : 'MISSING',
          message: got + EPS >= l.qty ? '已读到，数量够' : `少读：应领 ${g(l.qty)}，读到 ${g(got)}，还差 ${g(round(l.qty - got))}`,
        });
      }
    }
    ctx.check = {
      issue: { id: issue.id, no: issue.no, wo_no: issue.work_order?.no ?? null, status: issue.status },
      lines, ok_lines: lines.filter((l) => l.status === 'OK').length, short_lines: lines.filter((l) => l.status !== 'OK').length,
    };
    if (s.status !== 'OPEN') return;
    if (issue.status !== 'DRAFT') ctx.blockers.push(`领料单 ${issue.no} 已不是待过账状态`);
    if (!ctx.check.ok_lines) ctx.blockers.push('还没有读到够数的行：把拣好的料盘/料箱放到读写器上');
    ctx.check.need_partial = ctx.check.short_lines > 0;
  }

  // ----- 完工入库 -----
  private async evalFg(db: Tx, ctx: any) {
    const s = ctx.s;
    const wo = await db.workOrder.findUnique({ where: { id: s.wo_id }, include: { material: true } });
    if (!wo) throw new NotFound('工单');
    const waiting = await db.serialNumber.findMany({ where: { wo_id: wo.id, status: 'COMPLETED' }, orderBy: { sn: 'asc' } });
    const untagged = await db.serialNumber.count({ where: { wo_id: wo.id, status: 'COMPLETED', rfid_tags: { none: { status: 'ACTIVE' } } } });
    const seen = new Set<string>();
    for (const it of ctx.items) {
      if (it.action || (!it.known && !it.sn) || it.tag_status === 'VOID') continue;
      if (it.tag_type !== 'UNIT' || !it.sn) { it.level = 'error'; it.message = `包装标签（${it.material_code ?? ''} 批次 ${it.lot_no || '-'}），不是成品单台标签`; continue; }
      const sn = it._serial as SerialNumber;
      if (sn.wo_id !== wo.id) { it.level = 'error'; it.message = `${sn.sn} 不属于工单 ${wo.no}`; continue; }
      if (sn.status !== 'COMPLETED') { it.level = 'error'; it.message = `${sn.sn} 当前【${SN_TEXT[sn.status] ?? sn.status}】，${sn.status === 'IN_STOCK' ? '已入库' : '尚未完成全部工序'}`; continue; }
      if (seen.has(sn.sn)) { it.level = 'warn'; it.message = '同一序列号重复（兜底输入与标签各一次）'; continue; }
      seen.add(sn.sn);
      it.level = 'ok';
      it.message = `${sn.sn} 完工待入库`;
    }
    const loc = s.location_id ? await db.location.findUnique({ where: { id: s.location_id } }) : null;
    ctx.check = {
      wo: { id: wo.id, no: wo.no, material_code: wo.material.code, material_name: wo.material.name, lot_no: wo.lot_no, dhr_status: wo.dhr_status },
      waiting: waiting.length, read_ok: seen.size, untagged, location_code: loc?.code ?? null,
      missing: waiting.filter((x) => !seen.has(x.sn)).map((x) => x.sn),
    };
    if (s.status === 'OPEN' && !seen.size) ctx.blockers.push('还没有读到本工单完工待入库的成品');
  }

  // ----- 发货核对 -----
  private async evalShip(db: Tx, ctx: any) {
    const s = ctx.s;
    const sh = await db.shipment.findUnique({ where: { id: s.shipment_id }, include: { customer: true, sales_order: true, lines: { orderBy: { id: 'asc' }, include: { material: true } } } });
    if (!sh) throw new NotFound('发货单');
    const expected = new Map<string, { line_id: number; material_code: string }>();
    const lotLines = new Map<string, { line: any; need: number; read: number }>();
    for (const l of sh.lines) {
      const sns: string[] = l.serials ? JSON.parse(l.serials) : [];
      for (const x of sns) expected.set(x, { line_id: l.id, material_code: l.material.code });
      if (!sns.length) {
        const k = lotKey(l.material_id, l.lot_no);
        const e = lotLines.get(k) ?? { line: l, need: 0, read: 0 };
        e.need = round(e.need + l.qty);
        lotLines.set(k, e);
      }
    }
    const readSn = new Set<string>();
    const rows: any = { extra: [] as string[], not_released: [] as string[], not_mine: [] as string[] };
    for (const it of ctx.items) {
      if (it.action || (!it.known && !it.sn) || it.tag_status === 'VOID') continue;
      if (it.tag_type === 'PACKAGE') {
        const e = lotLines.get(lotKey(it.material_id, it.lot_no));
        if (e) { e.read = round(e.read + (it.qty ?? 0)); it.level = 'ok'; it.message = `包装 ${g(it.qty)} ${it.uom ?? ''}（批次 ${it.lot_no || '-'}）`; }
        else { it.level = 'error'; it.message = `不属于本单：${it.material_code} 批次 ${it.lot_no || '-'} 的包装`; rows.not_mine.push(it.epc); }
        continue;
      }
      const sn = it._serial as (SerialNumber & { release: any; material: any }) | null;
      if (!sn) continue;
      if (readSn.has(sn.sn)) { it.level = 'warn'; it.message = '同一序列号重复'; continue; }
      readSn.add(sn.sn);
      const released = !!sn.release_id && sn.release?.status === 'RELEASED';
      if (expected.has(sn.sn)) {
        if (!released) { it.level = 'error'; it.message = `${sn.sn} 在本单上，但所在批次未放行（DHR 未放行或放行批被拒），禁止发货`; rows.not_released.push(sn.sn); }
        else if (sn.status !== 'IN_STOCK') { it.level = 'error'; it.message = `${sn.sn} 当前【${SN_TEXT[sn.status] ?? sn.status}】，不能发货`; rows.not_mine.push(sn.sn); }
        else { it.level = 'ok'; it.message = `${sn.sn} 应发，已读到`; }
      } else if (!released) {
        it.level = 'error'; it.message = `未放行：${sn.sn}（${sn.material?.code ?? ''}，批次 ${sn.lot_no ?? '-'}）不在本单上，且未放行，请拿开`; rows.not_released.push(sn.sn);
      } else if (sn.status === 'IN_STOCK' && sh.lines.some((l) => l.material_id === sn.material_id)) {
        it.level = 'error'; it.message = `多出：${sn.sn} 是同型号已放行在库品，但不在本发货单上（拿开，或改发货单）`; rows.extra.push(sn.sn);
      } else {
        it.level = 'error'; it.message = `不属于本单：${sn.sn}（${sn.material?.code ?? ''}，${SN_TEXT[sn.status] ?? sn.status}）`; rows.not_mine.push(sn.sn);
      }
    }
    const missing = [...expected.keys()].filter((x) => !readSn.has(x));
    const lotRows = [...lotLines.values()].map((e) => ({ material_code: e.line.material.code, lot_no: e.line.lot_no, need: e.need, read: e.read, ok: Math.abs(e.need - e.read) <= EPS }));
    ctx.check = {
      shipment: { id: sh.id, no: sh.no, customer_name: sh.customer?.name ?? null, so_no: sh.sales_order?.no ?? null, status: sh.status },
      expected: expected.size, read: [...readSn].filter((x) => expected.has(x)).length, missing, extra: rows.extra, not_released: rows.not_released, not_mine: rows.not_mine,
      lot_lines: lotRows, all_match: !missing.length && !rows.extra.length && !rows.not_released.length && !rows.not_mine.length && lotRows.every((x) => x.ok),
    };
    if (s.status !== 'OPEN') return;
    if (sh.status !== 'DRAFT') ctx.blockers.push(`发货单 ${sh.no} 已不是待过账状态`);
    if (missing.length) ctx.blockers.push(`缺少 ${missing.length} 台：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}（没读到，请找到实物或检查标签）`);
    for (const x of lotRows) if (!x.ok) ctx.blockers.push(`${x.material_code} 批次 ${x.lot_no || '-'} 应发 ${g(x.need)}，读到 ${g(x.read)}`);
  }

  // ----- 盘点对账 -----
  private async evalCount(db: Tx, ctx: any) {
    const s = ctx.s;
    const loc = await db.location.findUnique({ where: { id: s.location_id }, include: { warehouse: true } });
    if (!loc) throw new NotFound('库位');
    const book = await db.rfidTag.findMany({
      where: { status: 'ACTIVE', location_id: loc.id, OR: [{ tag_type: 'PACKAGE', qty: { gt: EPS } }, { tag_type: 'UNIT', serial: { status: 'IN_STOCK' } }] },
      include: { material: true, serial: true },
      orderBy: { id: 'asc' },
    });
    const bookEff = await this.effQty(db, book);
    // 账面已用完（有效数量 0）的包装标签不算在库
    const bookLive = book.filter((t) => t.tag_type === 'UNIT' || (bookEff.get(t.id) ?? t.qty ?? 0) > EPS);
    const readEpcs = new Set(ctx.items.filter((i: any) => !i.action || i.action === 'DONE').map((i: any) => i.epc));
    for (const it of ctx.items) {
      if (it.action || !it.known || it.tag_status !== 'ACTIVE') continue;
      if (it.location_id === loc.id) { it.level = 'ok'; it.message = '读到，账面在此库位'; }
      else { it.level = 'warn'; it.message = `读到但账面不在此库位（账面：${it.location_code ?? '不在库'}）；确认后按此处实物盘盈，原库位盘点时会盘亏`; }
    }
    const missing = bookLive.filter((t) => !readEpcs.has(t.epc)).map((t) => ({
      epc: t.epc, tag_type: t.tag_type, material_code: t.material?.code ?? null, material_name: t.material?.name ?? null, lot_no: t.lot_no, qty: bookEff.get(t.id) ?? t.qty, sn: t.serial?.sn ?? null,
    }));
    // 汇总：物料 + 批次 + 货主
    const stocks = await db.stock.findMany({ where: { location_id: loc.id, qty: { gt: EPS } }, include: { material: true } });
    const sum = new Map<string, any>();
    const row = (material: any, lot: string | null, owner: number | null) => {
      const k = lotKey(material.id, lot, owner);
      if (!sum.has(k)) sum.set(k, { key: k, material_id: material.id, material_code: material.code, material_name: material.name, uom: material.uom, lot_no: lot ?? '', owner_customer_id: owner, book_qty: 0, tag_qty: 0, read_qty: 0 });
      return sum.get(k);
    };
    for (const st of stocks) { const r = row(st.material, st.lot_no, st.owner_customer_id); r.book_qty = round(r.book_qty + st.qty); }
    for (const t of bookLive) { const r = row(t.material, t.lot_no, t.owner_customer_id); r.tag_qty = round(r.tag_qty + (bookEff.get(t.id) ?? t.qty ?? 0)); }
    for (const it of ctx.items) {
      if (it.action === 'IGNORED' || !it.known || it.tag_status !== 'ACTIVE' || !it.material_id) continue;
      const t: TagFull = it._tag;
      const r = row(t.material, t.lot_no, t.owner_customer_id);
      r.read_qty = round(r.read_qty + (it.qty ?? 0));
    }
    const lines = [...sum.values()].map((r) => ({
      ...r, untagged_qty: Math.max(0, round(r.book_qty - r.tag_qty)), diff: round(r.read_qty - r.book_qty),
      note: r.book_qty - r.tag_qty > EPS ? `账面 ${g(r.book_qty)} 中有 ${g(round(r.book_qty - r.tag_qty))} 没有标签，需人工清点` : '',
    })).sort((a, b) => a.material_code.localeCompare(b.material_code) || a.lot_no.localeCompare(b.lot_no));
    ctx.check = {
      location: { id: loc.id, code: loc.code, name: loc.name, warehouse_id: loc.warehouse_id, warehouse_name: loc.warehouse?.name ?? null },
      book_tags: bookLive.length, read_here: ctx.items.filter((i: any) => i.level === 'ok').length,
      read_elsewhere: ctx.items.filter((i: any) => !i.action && i.level === 'warn' && i.known).length, missing, lines,
      count_id: s.count_id, count_no: s.count_id ? (await db.stockCount.findUnique({ where: { id: s.count_id } }))?.no ?? null : null,
    };
    if (s.status === 'OPEN' && !ctx.items.filter((i: any) => !i.action).length) ctx.blockers.push('还没有读取：用手持读写器扫过整个库位后上传');
  }

  // ----- 客户退货 -----
  private async evalReturn(db: Tx, ctx: any) {
    const s = ctx.s;
    const customers = new Set<number>();
    const list: any[] = [];
    for (const it of ctx.items) {
      if (it.action || (!it.known && !it.sn) || it.tag_status === 'VOID') continue;
      if (!it.sn) { it.level = 'error'; it.message = '包装标签，客户退货请读成品单台标签'; continue; }
      try {
        const r = await this.ops.rmaScan(db, it.sn);
        it.level = 'ok';
        it.message = `${r.customer_name ?? '-'} · 发货单 ${r.shipment_no ?? '-'} · ${fmtDate(r.ship_date as any) ?? ''}`;
        if (r.customer_id) customers.add(r.customer_id);
        list.push(r);
      } catch (e: any) {
        it.level = 'error';
        it.message = errMsg(e);
      }
    }
    const loc = s.location_id ? await db.location.findUnique({ where: { id: s.location_id } }) : null;
    ctx.check = { serials: list, customers: customers.size, location_id: loc?.id ?? null, location_code: loc?.code ?? null };
    if (s.status !== 'OPEN') return;
    if (!list.length) ctx.blockers.push('还没有读到可退货的成品');
    if (customers.size > 1) ctx.blockers.push('读到的产品属于不同客户，请按客户分开登记');
  }

  // ---------------- 兜底 / 误读 / 绑定 ----------------

  /**
   * 条码/手输兜底：code 依次按 EPC（已登记）→ 序列号 → 批号（该批次只有一个启用的包装标签时）→ 新 EPC 识别；
   * 序列号没有标签时（标签损坏）以“SN:序列号”记入（完工入库/发货/退货可用）。视同一次读取（source=MANUAL）。
   */
  async manual(tx: Tx, user: CurrentUser, id: number, code: string) {
    const s = await this.mustOpen(tx, id);
    const c = String(code ?? '').trim();
    if (!c) throw new BizError('请输入 EPC、序列号或批号');
    if (!s.reader) throw new BizError('本作业没有读写器');
    let epc: string | null = null;
    const asEpc = normEpc(c);
    if (asEpc && (await tx.rfidTag.findUnique({ where: { epc: asEpc } }))) epc = asEpc;
    if (!epc) {
      const sn = await tx.serialNumber.findUnique({ where: { sn: c } });
      if (sn) {
        const t = await tx.rfidTag.findFirst({ where: { serial_id: sn.id, status: 'ACTIVE' } });
        if (t) epc = t.epc;
        else if (['FG_RECEIPT', 'SHIP', 'RETURN'].includes(s.session_type)) epc = `SN:${sn.sn}`;
        else throw new BizError(`序列号 ${sn.sn} 没有启用的单台标签；请到“标签管理”发卡或换标`);
      }
    }
    if (!epc) {
      const tags = await tx.rfidTag.findMany({ where: { lot_no: c, status: 'ACTIVE', tag_type: 'PACKAGE', ...(s.session_type === 'COUNT' && s.location_id ? { location_id: s.location_id } : { location_id: { not: null } }) } });
      if (tags.length === 1) epc = tags[0].epc;
      else if (tags.length > 1) throw new BizError(`批号 ${c} 有 ${tags.length} 个包装标签，请输入标签上印的 EPC（区分是哪一包）`);
    }
    if (!epc && asEpc) epc = asEpc; // 新标签（收货台）或未登记标签
    if (!epc) throw new BizError(`“${c}”不是已登记的 EPC、序列号或带标签的批号；请核对后重输，或到“标签管理”换标`);
    const r = await this.rfid.ingest(tx, s.reader, [{ epc, antenna: null, rssi: null }], { source: 'MANUAL', username: user.username, session_id: s.id });
    return { epc, ingest: r };
  }

  /** 标记为误读（不参与本次作业；原始读取仍保留）。all_errors = 把所有红色行一次标记 */
  async ignore(tx: Tx, user: CurrentUser, id: number, a: { epcs?: string[] | null; all_errors?: boolean; note?: string | null }) {
    const s = await this.mustOpen(tx, id, true);
    let epcs = (a.epcs ?? []).map((e) => String(e));
    if (a.all_errors) {
      const d = await this.detail(tx, s.id);
      // 收货台的未登记标签就是要发卡的新标签，不算异常
      epcs = d.items.filter((i: any) => !i.action && (i.level === 'error' || (s.session_type !== 'RECEIVE' && !i.known && !i.sn))).map((i: any) => i.epc);
    }
    if (!epcs.length) throw new BizError('没有要标记的标签');
    const note = (a.note || `${user.full_name} 标记为误读`).slice(0, 256);
    const rows = await tx.rfidSessionTag.findMany({ where: { session_id: s.id, epc: { in: epcs }, action: null } });
    for (const r of rows) await tx.rfidSessionTag.update({ where: { id: r.id }, data: { action: 'IGNORED', action_note: note } });
    // 库门：全部处理完（移库或误读）即结束这次过门
    if (s.session_type === 'GATE' && !(await tx.rfidSessionTag.count({ where: { session_id: s.id, action: null } }))) {
      const done = await tx.rfidSessionTag.count({ where: { session_id: s.id, action: 'DONE' } });
      if (done) await this.finish(tx, user, s, { ref_type: 'TRANSFER', ref_no: s.ref_no });
      else await tx.rfidSession.update({ where: { id: s.id }, data: { status: 'CANCELLED', cancel_reason: '全部为误读', confirmed_by: user.full_name, confirmed_at: new Date() } });
    }
    return this.detail(tx, s.id);
  }

  async restore(tx: Tx, id: number, epcs: string[]) {
    const s = await this.mustOpen(tx, id, true);
    const rows = await tx.rfidSessionTag.findMany({ where: { session_id: s.id, epc: { in: epcs }, action: 'IGNORED' } });
    for (const r of rows) await tx.rfidSessionTag.update({ where: { id: r.id }, data: { action: null, action_note: null } });
    return this.detail(tx, s.id);
  }

  /** 收货台：把读到的新标签绑定到订单行（每张标签 = 一包，数量 qty）；放置规则错误立即提示，湿敏警告在确认时确认 */
  async bind(tx: Tx, user: CurrentUser, id: number, a: BindArgs) {
    const s = await this.mustOpen(tx, id, true);
    if (s.session_type !== 'RECEIVE') throw new BizError('只有收货作业需要绑定');
    const pl = await tx.purchaseOrderLine.findUnique({ where: { id: a.po_line_id }, include: { material: true } });
    if (!pl || pl.order_id !== s.po_id) throw new BizError('订单行不属于本采购单');
    const qty = round(Number(a.qty));
    if (!(qty > 0)) throw new BizError('每包数量必须大于 0');
    const loc = await tx.location.findUnique({ where: { id: a.location_id } });
    if (!loc || !loc.is_active) throw new BizError('请选择有效的收货库位');
    const place = await this.inv.checkPlacement(tx, { material_id: pl.material_id, location_id: loc.id, owner_customer_id: pl.material.owner_customer_id });
    if (place.errors.length) throw new BizError(place.errors.join('；'));
    const mfg = dateOnly(a.mfg_date ?? null);
    const exp = dateOnly(a.expiry_date ?? null);
    const all = await tx.rfidSessionTag.findMany({ where: { session_id: s.id, action: null } });
    const known = new Set((await tx.rfidTag.findMany({ where: { epc: { in: all.map((x) => x.epc) } }, select: { epc: true } })).map((x) => x.epc));
    const want = a.epcs?.length ? new Set(a.epcs.map((e) => normEpc(e) ?? e)) : null;
    const targets = all.filter((x) => !known.has(x.epc) && !x.epc.startsWith('SN:') && (want ? want.has(x.epc) : !x.po_line_id));
    if (!targets.length) throw new BizError(want ? '所选标签不是本次读到的新标签' : '没有未绑定的新标签：把贴好空白标签的包装放上收货台');
    for (const x of targets) {
      await tx.rfidSessionTag.update({
        where: { id: x.id },
        data: {
          po_line_id: pl.id, material_id: pl.material_id, qty, lot_no: String(a.lot_no ?? '').trim() || null, supplier_lot: String(a.supplier_lot ?? '').trim() || null,
          location_id: loc.id, mfg_date: mfg, expiry_date: exp,
        },
      });
    }
    return { ...(await this.detail(tx, s.id)), warnings: place.warnings, bound: targets.length };
  }

  async unbind(tx: Tx, id: number, epcs: string[]) {
    const s = await this.mustOpen(tx, id, true);
    const rows = await tx.rfidSessionTag.findMany({ where: { session_id: s.id, epc: { in: epcs }, action: null } });
    for (const r of rows) {
      await tx.rfidSessionTag.update({ where: { id: r.id }, data: { po_line_id: null, material_id: null, qty: null, lot_no: null, supplier_lot: null, location_id: null, mfg_date: null, expiry_date: null } });
    }
    return this.detail(tx, s.id);
  }

  // ---------------- 确认 / 取消 ----------------

  async cancel(tx: Tx, user: CurrentUser, id: number, reason?: string | null) {
    const s = await this.mustOpen(tx, id, true);
    await tx.rfidSession.update({ where: { id: s.id }, data: { status: 'CANCELLED', cancel_reason: (reason || `${user.full_name} 取消`).slice(0, 256), confirmed_by: user.full_name, confirmed_at: new Date() } });
    return this.detail(tx, s.id);
  }

  private async finish(tx: Tx, user: CurrentUser, s: RfidSession, ref: { ref_type: string; ref_id?: number | null; ref_no: string | null }) {
    await tx.rfidSession.update({
      where: { id: s.id },
      data: { status: 'CONFIRMED', confirmed_by: user.full_name, confirmed_at: new Date(), ref_type: ref.ref_type, ref_id: ref.ref_id ?? null, ref_no: ref.ref_no?.slice(0, 256) ?? null },
    });
  }

  private async markDone(tx: Tx, sessionId: number, epcs: string[], note: string) {
    if (!epcs.length) return;
    const rows = await tx.rfidSessionTag.findMany({ where: { session_id: sessionId, epc: { in: epcs }, action: null } });
    for (const r of rows) await tx.rfidSessionTag.update({ where: { id: r.id }, data: { action: 'DONE', action_note: note.slice(0, 256) } });
  }

  async confirm(tx: Tx, user: CurrentUser, id: number, body: ConfirmArgs) {
    const s = await this.mustOpen(tx, id, true);
    const d = await this.detail(tx, s.id);
    if (s.session_type !== 'ISSUE' && s.session_type !== 'GATE' && d.blockers.length) throw new BizError(`还不能确认：${d.blockers.join('；')}`);
    switch (s.session_type) {
      case 'RECEIVE': return this.confirmReceive(tx, user, s, d, body);
      case 'GATE': return this.confirmGate(tx, user, s, body);
      case 'ISSUE': return this.confirmIssue(tx, user, s, d, body);
      case 'FG_RECEIPT': return this.confirmFg(tx, user, s, d);
      case 'SHIP': return this.confirmShip(tx, user, s, d);
      case 'COUNT': return this.confirmCount(tx, user, s, d, body);
      case 'RETURN': return this.confirmReturn(tx, user, s, d, body);
      default: throw new BizError('未知的作业类型');
    }
  }

  /** 收货：按（订单行、批号、原厂批号、库位、日期）合并为入库单行 → WmsService.receive（IQC、应付、放置规则）→ 给每张新标签发卡 */
  private async confirmReceive(tx: Tx, user: CurrentUser, s: RfidSession, d: any, body: ConfirmArgs) {
    const items = await tx.rfidSessionTag.findMany({ where: { session_id: s.id, action: null, po_line_id: { not: null } }, orderBy: { id: 'asc' } });
    const known = new Set((await tx.rfidTag.findMany({ where: { epc: { in: items.map((x) => x.epc) } }, select: { epc: true } })).map((x) => x.epc));
    const fresh = items.filter((x) => !known.has(x.epc));
    const groups = new Map<string, { key: any; qty: number; items: typeof fresh }>();
    for (const x of fresh) {
      const k = JSON.stringify([x.po_line_id, x.lot_no ?? '', x.supplier_lot ?? '', x.location_id, fmtDate(x.mfg_date), fmtDate(x.expiry_date)]);
      const gr = groups.get(k) ?? { key: x, qty: 0, items: [] };
      gr.qty = round(gr.qty + (x.qty ?? 0));
      gr.items.push(x);
      groups.set(k, gr);
    }
    const po = await tx.purchaseOrder.findUnique({ where: { id: s.po_id! }, include: { lines: { orderBy: { line_no: 'asc' } } } });
    if (!po) throw new NotFound('采购订单');
    if (!['APPROVED', 'PARTIAL_RECEIVED'].includes(po.status)) throw new BizError('采购订单未审批或已完结，不能收货');
    const gl = [...groups.values()];
    const rc = await this.wms.receive(tx, user, {
      receipt_type: 'PURCHASE', po, supplier_id: po.supplier_id, delivery_note: body.delivery_note ?? null, remark: `RFID 收货台 ${s.no}`,
      confirm_placement: !!body.confirm_placement,
      lines: gl.map((gr) => ({
        po_line_id: gr.key.po_line_id, material_id: gr.key.material_id, qty: gr.qty, location_id: gr.key.location_id, lot_no: gr.key.lot_no,
        supplier_lot: gr.key.supplier_lot, mfg_date: gr.key.mfg_date, expiry_date: gr.key.expiry_date,
      })),
    });
    const owner = new Map((await tx.material.findMany({ where: { id: { in: gl.map((x) => x.key.material_id) } } })).map((m) => [m.id, m.owner_customer_id]));
    for (const [i, gr] of gl.entries()) {
      const rl = rc.lines.find((l) => l.line_no === i + 1)!;
      for (const x of gr.items) {
        await tx.rfidTag.create({
          data: {
            epc: x.epc, tag_type: 'PACKAGE', material_id: rl.material_id, lot_no: rl.lot_no, qty: x.qty, owner_customer_id: owner.get(rl.material_id) ?? null,
            location_id: rl.location_id, receipt_id: rc.id, created_by: user.username, remark: `RFID 收货 ${s.no}`,
          },
        });
        await tx.rfidSessionTag.update({ where: { id: x.id }, data: { action: 'DONE', action_note: `已发卡：入库单 ${rc.no} 第 ${rl.line_no} 行，批号 ${rl.lot_no || '-'}` } });
      }
    }
    await this.finish(tx, user, s, { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no });
    return { ...(await this.detail(tx, s.id)), result: { receipt_id: rc.id, receipt_no: rc.no, tags: fresh.length, lines: rc.lines.length } };
  }

  /**
   * 库门确认：只处理勾选的标签（仓管核对后一键确认），逐个按 WmsService.transfer 调拨（放置规则、湿敏确认照常）；
   * 未勾选的保持待处理；全部处理完会话即为已确认。误读一律不自动过账。
   */
  private async confirmGate(tx: Tx, user: CurrentUser, s: RfidSession, body: ConfirmArgs) {
    const picks = body.items ?? [];
    if (!picks.length) throw new BizError('请勾选要确认移库的标签');
    const reader = await tx.rfidReader.findUnique({ where: { id: s.reader_id! } });
    const moved: string[] = [];
    const nos: string[] = [];
    for (const p of picks) {
      const epc = normEpc(p.epc) ?? p.epc;
      const row = await tx.rfidSessionTag.findUnique({ where: { session_id_epc: { session_id: s.id, epc } } });
      if (!row || row.action) continue;
      if (p.direction && ['IN', 'OUT'].includes(p.direction)) await tx.rfidSessionTag.update({ where: { id: row.id }, data: { direction: p.direction } });
      if (p.to_location_id) await tx.rfidSessionTag.update({ where: { id: row.id }, data: { location_id: p.to_location_id } });
      const t = await tx.rfidTag.findUnique({ where: { epc }, include: { material: true, location: { include: { warehouse: true } }, serial: { include: { release: true, material: true } } } });
      if (!t || t.status !== 'ACTIVE') throw new BizError(`${epc} 不是启用的标签，不能移库（请标记为误读）`);
      const it: any = { _tag: t, direction: p.direction || row.direction, bind_location_id: p.to_location_id ?? row.location_id, qty: t.qty };
      const plan: any = await this.gatePlan(tx, reader, it);
      if (!plan || plan.error || plan.warn) throw new BizError(`${t.material?.code ?? ''} ${t.lot_no ?? ''}（${epc}）：${plan?.error ?? plan?.warn ?? '不能移库'}`);
      if (plan.info) {
        await this.markDone(tx, s.id, [epc], plan.info);
        continue;
      }
      const st: Stock = plan.stock;
      const q = round(Math.min(t.qty ?? st.qty, st.qty));
      const dirText = it.direction === 'IN' ? '进库' : '出库';
      try {
        await this.wms.transfer(tx, user, st.id, q, plan.to.id, `RFID ${reader?.name ?? ''}${dirText}（${s.no}，标签 ${epc}）`, !!body.confirm_placement);
      } catch (e: any) {
        const msg = errMsg(e);
        if (msg.includes('请确认后再提交')) throw new BizError(`【需确认】${t.material?.code}：${msg}`);
        throw e;
      }
      const mv = await tx.stockMove.findFirst({ where: { ref_type: 'TRANSFER', material_id: st.material_id, lot_no: st.lot_no }, orderBy: { id: 'desc' } });
      await tx.rfidTag.update({ where: { id: t.id }, data: { location_id: plan.to.id, ...(t.tag_type === 'PACKAGE' ? { qty: q } : {}) } });
      if (t.serial_id && t.serial?.status === 'IN_STOCK') await tx.serialNumber.update({ where: { id: t.serial_id }, data: { location_id: plan.to.id } });
      await this.markDone(tx, s.id, [epc], `已${dirText}：${t.location?.code} → ${plan.to.code}，${g(q)}${mv?.ref_no ? `（调拨 ${mv.ref_no}）` : ''}`);
      moved.push(epc);
      if (mv?.ref_no) nos.push(mv.ref_no);
    }
    const left = await tx.rfidSessionTag.count({ where: { session_id: s.id, action: null } });
    if (!left) await this.finish(tx, user, s, { ref_type: 'TRANSFER', ref_no: nos.join(',') || null });
    else if (nos.length) await tx.rfidSession.update({ where: { id: s.id }, data: { ref_type: 'TRANSFER', ref_no: [s.ref_no, ...nos].filter(Boolean).join(',').slice(0, 256) } });
    return { ...(await this.detail(tx, s.id)), result: { moved: moved.length, transfer_nos: nos } };
  }

  /** 领料核对确认：读到够数的行按应拣数拣料（ops.pickLine），再领料过账（WmsService.confirmIssue；有少读行时须 partial，未拣行转新领料单） */
  private async confirmIssue(tx: Tx, user: CurrentUser, s: RfidSession, d: any, body: ConfirmArgs) {
    const errs = d.items.filter((i: any) => !i.action && i.level === 'error');
    if (errs.length) throw new BizError(`还不能确认：有 ${errs.length} 个标签不符合本领料单（多读/读错批次），请拿开并标记为误读`);
    const lines: any[] = d.check.lines ?? [];
    const ok = lines.filter((l) => l.status === 'OK');
    const short = lines.filter((l) => l.status !== 'OK');
    if (!ok.length) throw new BizError('还没有读到够数的行，不能过账');
    if (short.length && !body.partial) {
      throw new BizError(`还有 ${short.length} 行少读（${short.slice(0, 3).map((l) => `${l.material_code} 批次 ${l.lot_no || '-'} 还差 ${g(l.short)}`).join('；')}）。请继续读取，或选择“部分过账”（少读的行转入新领料单）`);
    }
    for (const l of ok) if (!l.picked) await this.ops.pickLine(tx, user, s.issue_id!, l.line_id, l.qty);
    const issue = await this.wms.confirmIssue(tx, user, s.issue_id!, { partial: short.length > 0 });
    // 标签数量随领用扣减（用完 = 不在库）
    const used = d.items.filter((i: any) => !i.action && i.level !== 'error' && i.use_qty > 0);
    for (const it of used) {
      const t = await tx.rfidTag.findUnique({ where: { epc: it.epc } });
      if (!t) continue;
      const left = round((it.qty ?? t.qty ?? 0) - it.use_qty); // 按有效数量（账面）扣减
      await tx.rfidTag.update({ where: { id: t.id }, data: left > EPS ? { qty: left } : { qty: 0, location_id: null } });
    }
    await this.markDone(tx, s.id, used.map((i: any) => i.epc), `已领用：领料单 ${issue.no}`);
    await this.finish(tx, user, s, { ref_type: 'ISSUE', ref_id: issue.id, ref_no: issue.no });
    return { ...(await this.detail(tx, s.id)), result: { issue_no: issue.no, partial: short.length > 0 } };
  }

  private async confirmFg(tx: Tx, user: CurrentUser, s: RfidSession, d: any) {
    const ok = d.items.filter((i: any) => !i.action && i.level === 'ok' && i.sn);
    const sns: string[] = [...new Set<string>(ok.map((i: any) => i.sn as string))];
    const rc = await this.ops.fgReceiptSerials(tx, user, s.wo_id!, s.location_id!, sns);
    const tags = await tx.rfidTag.findMany({ where: { status: 'ACTIVE', serial: { sn: { in: sns } } } });
    for (const t of tags) await tx.rfidTag.update({ where: { id: t.id }, data: { location_id: s.location_id } });
    await this.markDone(tx, s.id, ok.map((i: any) => i.epc), `已入库：${rc.no}`);
    await this.finish(tx, user, s, { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no });
    return { ...(await this.detail(tx, s.id)), result: { receipt_no: rc.no, qty: sns.length } };
  }

  private async confirmShip(tx: Tx, user: CurrentUser, s: RfidSession, d: any) {
    if (!d.check.all_match) throw new BizError('读取结果与发货单不一致，不能发货');
    const sh = await this.wms.confirmShipment(tx, user, s.shipment_id!);
    const sns = sh.lines.flatMap((l) => (l.serials ? (JSON.parse(l.serials) as string[]) : []));
    const tags = await tx.rfidTag.findMany({ where: { status: 'ACTIVE', OR: [{ serial: { sn: { in: sns } } }, { epc: { in: d.items.filter((i: any) => !i.action && i.tag_type === 'PACKAGE').map((i: any) => i.epc) } }] } });
    for (const t of tags) await tx.rfidTag.update({ where: { id: t.id }, data: t.tag_type === 'UNIT' ? { location_id: null } : { location_id: null, qty: 0 } });
    await this.markDone(tx, s.id, d.items.filter((i: any) => !i.action && i.level === 'ok').map((i: any) => i.epc), `已发货：${sh.no}`);
    await this.finish(tx, user, s, { ref_type: 'SHIPMENT', ref_id: sh.id, ref_no: sh.no });
    return { ...(await this.detail(tx, s.id)), result: { shipment_no: sh.no } };
  }

  /**
   * 盘点确认：写入盘点单（沿用现有盘点单：本库位已有进行中的单库位盘点单则用它，否则新建单库位盘点单）。
   *   有标签的批次：实盘 = 读到的标签数量合计（多个质量状态按账面顺序分摊）；读到但账面不在此库位 → 新增盘盈行；
   *   没有标签的账面库存不填实盘（需人工清点；过账时可选“未盘行按账面”）。
   * post=true 时随即过账（WmsService.postCount：调整量 = 实盘 − 过账时当前账面）。
   */
  private async confirmCount(tx: Tx, user: CurrentUser, s: RfidSession, d: any, body: ConfirmArgs) {
    const loc = await tx.location.findUnique({ where: { id: s.location_id! } });
    if (!loc) throw new NotFound('库位');
    let sc = s.count_id ? await tx.stockCount.findUnique({ where: { id: s.count_id } }) : null;
    if (!sc) sc = await tx.stockCount.findFirst({ where: { warehouse_id: loc.warehouse_id, status: 'OPEN', location_ids: String(loc.id) } });
    if (!sc) sc = await this.wms.createCount(tx, user, loc.warehouse_id, `RFID 盘点 ${s.no}（库位 ${loc.code}）`, { location_ids: [loc.id] });
    const lines = await tx.stockCountLine.findMany({ where: { count_id: sc.id, location_id: loc.id }, orderBy: { id: 'asc' } });
    const readBy = new Map<string, { qty: number; it: any }>();
    for (const it of d.items) {
      if (it.action || !it.known || it.tag_status !== 'ACTIVE' || !it.material_id) continue;
      const k = lotKey(it.material_id, it.lot_no, it.owner_customer_id);
      const e = readBy.get(k) ?? { qty: 0, it };
      e.qty = round(e.qty + (it.qty ?? 0));
      readBy.set(k, e);
    }
    const tagged = new Set((d.check.lines as any[]).filter((l) => l.tag_qty > EPS).map((l) => l.key));
    const save: { id: number; counted_qty: number }[] = [];
    const used = new Set<string>();
    const order = ['AVAILABLE', 'QUARANTINE', 'HOLD', 'REJECTED'];
    const byKey = new Map<string, typeof lines>();
    for (const l of lines) {
      const k = lotKey(l.material_id, l.lot_no, l.owner_customer_id);
      byKey.set(k, [...(byKey.get(k) ?? []), l]);
    }
    for (const [k, ls] of byKey) {
      const read = readBy.get(k);
      if (!read && !tagged.has(k)) continue; // 没有标签的库存：人工清点
      let left = read?.qty ?? 0;
      const sorted = [...ls].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
      for (const [i, l] of sorted.entries()) {
        const book = await this.inv.lockedQty(tx, { material_id: l.material_id, location_id: l.location_id, lot_no: l.lot_no, status: l.status, owner_customer_id: l.owner_customer_id });
        const q = i === sorted.length - 1 ? left : Math.min(left, book);
        save.push({ id: l.id, counted_qty: round(Math.max(0, q)) });
        left = round(left - q);
      }
      used.add(k);
    }
    if (save.length) await this.ops.saveCountLines(tx, sc.id, save);
    for (const [k, e] of readBy) {
      if (used.has(k)) continue;
      const t = await tx.rfidTag.findUnique({ where: { epc: e.it.epc } });
      const st = t?.location_id ? await this.stockFor(tx, t, t.location_id) : null;
      await this.ops.addCountLine(tx, user, sc.id, { material_id: e.it.material_id, location_id: loc.id, lot_no: e.it.lot_no ?? '', status: st?.status ?? 'AVAILABLE', counted_qty: e.qty });
    }
    // 标签“当前已知库位”= 实物所在：读到的标签更新到本库位
    const readTags = d.items.filter((i: any) => !i.action && i.known && i.tag_status === 'ACTIVE');
    for (const it of readTags) {
      const sync = it.tag_type === 'PACKAGE' && it.qty !== it.tag_qty ? { qty: it.qty } : {};
      if (it.location_id !== loc.id || Object.keys(sync).length) await tx.rfidTag.update({ where: { epc: it.epc }, data: { location_id: loc.id, ...sync } });
    }
    await this.markDone(tx, s.id, readTags.map((i: any) => i.epc), `已计入盘点单 ${sc.no}`);
    await tx.rfidSession.update({ where: { id: s.id }, data: { count_id: sc.id } });
    if (body.post) {
      await this.wms.postCount(tx, user, sc.id, { uncounted_as_book: !!body.uncounted_as_book });
      // 已按盘亏过账：账面有但没读到的标签视为不在此库位（实物找到后再读，会按“读到但账面不在此库位”盘盈回来）
      const gone = (d.check.missing as any[]).map((m) => m.epc);
      if (gone.length) {
        const rows = await tx.rfidTag.findMany({ where: { epc: { in: gone }, location_id: loc.id } });
        for (const t of rows) await tx.rfidTag.update({ where: { id: t.id }, data: { location_id: null, remark: [t.remark, `盘点 ${sc.no} 未读到，按盘亏处理`].filter(Boolean).join('；').slice(0, 2000) } });
      }
    }
    await this.finish(tx, user, s, { ref_type: 'STOCK_COUNT', ref_id: sc.id, ref_no: sc.no });
    const after = await tx.stockCount.findUnique({ where: { id: sc.id } });
    return { ...(await this.detail(tx, s.id)), result: { count_id: sc.id, count_no: sc.no, count_status: after?.status, lines: save.length } };
  }

  private async confirmReturn(tx: Tx, user: CurrentUser, s: RfidSession, d: any, body: ConfirmArgs) {
    const list: any[] = d.check.serials;
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BizError('请填写退货原因');
    const locId = body.location_id ?? s.location_id;
    if (!locId) throw new BizError('请选择退货入库库位（建议不合格品区）');
    const customer_id = list[0]?.customer_id;
    if (!customer_id) throw new BizError('无法确定客户');
    const shipments = [...new Set(list.map((x) => x.shipment_id))];
    const sos = [...new Set(list.map((x) => x.so_id))];
    const r = await this.rma.create(tx, user, {
      customer_id, shipment_id: shipments.length === 1 ? shipments[0] : null, so_id: sos.length === 1 ? sos[0] : null, reason, remark: `RFID 识别 ${s.no}`,
      lines: list.map((x) => ({ material_id: x.material_id, sn: x.sn, lot_no: x.lot_no, qty: 1, location_id: locId })),
    });
    const tags = await tx.rfidTag.findMany({ where: { status: 'ACTIVE', serial: { sn: { in: list.map((x) => x.sn) } } } });
    for (const t of tags) await tx.rfidTag.update({ where: { id: t.id }, data: { location_id: locId } });
    await this.markDone(tx, s.id, d.items.filter((i: any) => !i.action && i.level === 'ok').map((i: any) => i.epc), `已登记客户退货 ${r.no}`);
    await this.finish(tx, user, s, { ref_type: 'CUSTOMER_RETURN', ref_id: r.id, ref_no: r.no });
    return { ...(await this.detail(tx, s.id)), result: { return_no: r.no, return_id: r.id } };
  }

  // ---------------- 模拟读取候选（仅演示/测试） ----------------

  async simCandidates(db: Tx, a: { reader_id?: number; session_id?: number }) {
    const s = a.session_id ? await db.rfidSession.findUnique({ where: { id: a.session_id } }) : null;
    const reader = await db.rfidReader.findUnique({ where: { id: a.reader_id ?? s?.reader_id ?? 0 } });
    if (!reader) throw new NotFound('读写器');
    const pick = (t: any, kind: 'expected' | 'other', note?: string) => ({
      epc: t.epc, kind, tag_type: t.tag_type, material_code: t.material?.code ?? null, lot_no: t.lot_no, qty: t.qty, sn: t.serial?.sn ?? null,
      location_code: t.location?.code ?? null, note: note ?? null,
    });
    const incl = { material: true, location: true, serial: { include: { release: true } } } as const;
    const out: any[] = [];
    const type = s?.session_type ?? (reader.purpose === 'GATE' ? 'GATE' : null);
    if (type === 'RECEIVE' || !type) return { blank: true, items: out };
    if (type === 'GATE') {
      const inside = reader.warehouse_id ? await db.rfidTag.findMany({ where: { status: 'ACTIVE', location: { warehouse_id: reader.warehouse_id } }, include: incl, take: 12, orderBy: { id: 'asc' } }) : [];
      const outside = reader.outside_location_id ? await db.rfidTag.findMany({ where: { status: 'ACTIVE', location_id: reader.outside_location_id }, include: incl, take: 8 }) : [];
      out.push(...inside.map((t) => pick(t, 'expected', '库内（出库方向）')), ...outside.map((t) => pick(t, 'other', '外侧（进库方向）')));
    } else if (type === 'ISSUE') {
      const lines = await db.materialIssueLine.findMany({ where: { issue_id: s!.issue_id! } });
      const exp = await db.rfidTag.findMany({ where: { status: 'ACTIVE', OR: lines.map((l) => ({ material_id: l.material_id, lot_no: l.lot_no })) }, include: incl, take: 20 });
      const other = await db.rfidTag.findMany({ where: { status: 'ACTIVE', tag_type: 'PACKAGE', location_id: { not: null }, id: { notIn: exp.map((t) => t.id) } }, include: incl, take: 6, orderBy: { id: 'desc' } });
      out.push(...exp.map((t) => pick(t, 'expected')), ...other.map((t) => pick(t, 'other')));
    } else if (type === 'FG_RECEIPT') {
      const exp = await db.rfidTag.findMany({ where: { status: 'ACTIVE', serial: { wo_id: s!.wo_id!, status: 'COMPLETED' } }, include: incl, take: 30 });
      const other = await db.rfidTag.findMany({ where: { status: 'ACTIVE', tag_type: 'UNIT', id: { notIn: exp.map((t) => t.id) } }, include: incl, take: 5 });
      out.push(...exp.map((t) => pick(t, 'expected')), ...other.map((t) => pick(t, 'other')));
    } else if (type === 'SHIP') {
      const sh = await db.shipment.findUnique({ where: { id: s!.shipment_id! }, include: { lines: true } });
      const sns = (sh?.lines ?? []).flatMap((l) => (l.serials ? (JSON.parse(l.serials) as string[]) : []));
      const exp = await db.rfidTag.findMany({ where: { status: 'ACTIVE', serial: { sn: { in: sns } } }, include: incl });
      const other = await db.rfidTag.findMany({ where: { status: 'ACTIVE', tag_type: 'UNIT', serial: { status: 'IN_STOCK' }, id: { notIn: exp.map((t) => t.id) } }, include: incl, take: 6 });
      out.push(...exp.map((t) => pick(t, 'expected')), ...other.map((t) => pick(t, 'other', t.serial?.release?.status === 'RELEASED' ? '已放行，不在本单' : '未放行')));
    } else if (type === 'COUNT') {
      const exp = await db.rfidTag.findMany({ where: { status: 'ACTIVE', location_id: s!.location_id! }, include: incl, take: 40 });
      const other = await db.rfidTag.findMany({ where: { status: 'ACTIVE', location_id: { not: s!.location_id! }, NOT: { location_id: null } }, include: incl, take: 4 });
      out.push(...exp.map((t) => pick(t, 'expected')), ...other.map((t) => pick(t, 'other', '账面在其他库位')));
    } else if (type === 'RETURN') {
      const exp = await db.rfidTag.findMany({ where: { status: 'ACTIVE', serial: { status: 'SHIPPED' } }, include: incl, take: 10 });
      const other = await db.rfidTag.findMany({ where: { status: 'ACTIVE', tag_type: 'UNIT', serial: { status: 'IN_STOCK' } }, include: incl, take: 3 });
      out.push(...exp.map((t) => pick(t, 'expected', '已发货')), ...other.map((t) => pick(t, 'other', '在库（不能退货）')));
    }
    return { blank: false, items: out, gate: reader.purpose === 'GATE' ? { inner_antenna: reader.inner_antenna, outer_antenna: reader.outer_antenna, mode: reader.direction_mode } : null };
  }
}
