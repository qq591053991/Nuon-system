/**
 * 全局搜索（G1）：一个框搜单号 / 序列号 / 批号 / 物料 / 库位，支持扫码枪。
 *  - 支持 UDI / GS1：人工可读 “(01)…(17)…(10)批号(21)序列号”，以及 DataMatrix 扫描头输出的原始串（]d2 前缀、GS 分隔、无括号），
 *    解析规则与前端 utils/scan.ts 相同：有序列号按序列号精确查，否则按批号。
 *  - 每条结果给出 type、单号/编码、中文状态、跳转 url；与输入完全相同的排在最前（exact=true），前端“唯一结果回车直接跳转”。
 *  - 按读权限裁剪：没有读权限的单据类型（如财务单据、销售/采购订单）不出现在结果里。
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { READ_PERMS, userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { like } from '../common/paginate';
import type { Tx } from '../common/prisma.service';

export interface ScanParts {
  raw: string;
  code: string;
  gtin?: string;
  lot?: string;
  sn?: string;
}

const FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 };

function parseGs1Raw(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const ai = s.slice(i, i + 2);
    if (!/^\d\d$/.test(ai)) return null;
    i += 2;
    if (FIXED[ai]) {
      out[ai] = s.slice(i, i + FIXED[ai]);
      i += FIXED[ai];
    } else if (ai === '10' || ai === '21') {
      const end = s.indexOf('\x1d', i);
      out[ai] = s.slice(i, end < 0 ? undefined : end);
      i = end < 0 ? s.length : end + 1;
    } else {
      return null;
    }
    if (s[i] === '\x1d') i += 1;
  }
  return out['01'] ? out : null;
}

/** 条码解析（与前端 utils/scan.ts 的 parseScan 同规则） */
export function parseScan(input: string): ScanParts {
  const raw = (input ?? '').replace(/[\r\n]+$/, '');
  let s = raw.trim();
  if (s.startsWith('(')) {
    const parts: Record<string, string> = {};
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) parts[m[1]] = m[2].trim();
    if (parts['01'] || parts['21'] || parts['10']) {
      return { raw, code: parts['21'] || parts['10'] || s, gtin: parts['01'], lot: parts['10'], sn: parts['21'] };
    }
  }
  s = s.replace(/^\][A-Za-z]\d/, '');
  if (/^01\d{14}/.test(s)) {
    const p = parseGs1Raw(s);
    if (p) return { raw, code: p['21'] || p['10'] || s, gtin: p['01'], lot: p['10'], sn: p['21'] };
  }
  return { raw, code: s };
}

/** 状态中文（与前端 utils/dict.ts 一致，只列搜索结果会用到的） */
const STATUS: Record<string, Record<string, string>> = {
  serial: { CREATED: '待生产', IN_PROCESS: '在制', NG: '不良待处置', COMPLETED: '完工待入库', IN_STOCK: '在库', SHIPPED: '已发货', SCRAPPED: '已报废', RETURNED: '客户退回' },
  sales_order: { DRAFT: '草稿', CONFIRMED: '已确认', IN_PRODUCTION: '生产中', PARTIAL_SHIPPED: '部分发货', SHIPPED: '已发货', CLOSED: '已关闭', CANCELLED: '已取消' },
  purchase_order: { DRAFT: '草稿', SUBMITTED: '待审批', APPROVED: '已审批', PARTIAL_RECEIVED: '部分到货', RECEIVED: '已到货', CLOSED: '已关闭', CANCELLED: '已取消' },
  work_order: { PLANNED: '计划', RELEASED: '已下达', IN_PROGRESS: '生产中', COMPLETED: '已完工', CLOSED: '已关闭', CANCELLED: '已取消' },
  inspection: { PENDING: '待检验', PASSED: '合格', REJECTED: '不合格', CONCESSION: '让步接收' },
  ncr: { OPEN: '待处置', DISPOSITIONED: '已处置', CLOSED: '已关闭' },
  doc: { DRAFT: '待过账', CONFIRMED: '已过账', CANCELLED: '已取消', SHIPPED: '已发货', OPEN: '进行中', POSTED: '已过账' },
  customer_return: { RECEIVED: '待处置', CLOSED: '已关闭' },
  supplier_return: { PENDING: '待出库', SHIPPED: '已出库', CANCELLED: '已取消' },
  complaint: { OPEN: '已登记', INVESTIGATING: '调查中', CLOSED: '已结案' },
  capa: { OPEN: '新建', IN_PROGRESS: '进行中', VERIFYING: '有效性验证', CLOSED: '已关闭' },
  stock: { QUARANTINE: '待检/待放行', AVAILABLE: '合格', REJECTED: '不合格', HOLD: '冻结' },
  finance: { OPEN: '未结', PARTIAL: '部分结算', PAID: '已结清' },
  equipment: { NORMAL: '正常', MAINTENANCE: '维修保养', DISABLED: '停用' },
};

export const statusLabel = (dict: string, v: string | null | undefined) => (v ? STATUS[dict]?.[v] ?? v : null);

export interface SearchHit {
  type: string;
  type_text: string;
  id: number | null;
  no?: string;
  code?: string;
  title: string;
  sub?: string | null;
  status?: string | null;
  status_label?: string | null;
  url: string;
  /** 次要入口（如批号的“追溯”、物料的“主数据”） */
  alt?: { label: string; url: string }[];
  /** 与输入完全相同（忽略大小写） */
  exact: boolean;
  /** 兼容旧前端 */
  material_code?: string;
}

const enc = encodeURIComponent;
const eq = (a: string | null | undefined, b: string) => !!a && a.trim().toUpperCase() === b.toUpperCase();

/** 各类型的展示顺序（完全匹配优先，其次按此顺序） */
const ORDER = [
  'serial', 'work_order', 'sales_order', 'purchase_order', 'shipment', 'issue', 'receipt', 'stock_count', 'customer_return',
  'supplier_return', 'inspection', 'ncr', 'complaint', 'capa', 'finance', 'lot', 'location', 'material', 'equipment', 'customer', 'supplier',
];

@Injectable()
export class SearchService {
  async search(tx: Tx, user: CurrentUser | undefined, qRaw: string | null | undefined, limit = 8): Promise<SearchHit[]> {
    const parsed = parseScan(qRaw || '');
    const q = parsed.code.trim();
    if (!q) return [];
    const perms = user ? userPermissions(user) : new Set<string>();
    const can = (list: readonly string[]) => list.some((p) => perms.has(p));
    const take = limit;
    const orderBy = { id: 'asc' as const };
    const lk = like(q);
    const out: SearchHit[] = [];
    const isUdi = !!(parsed.gtin || parsed.sn || (parsed.lot && parsed.code !== parsed.raw.trim()));
    // 物料/批号默认去库存查询（仓管、计划、采购、销售、质量、管理层）；只有工程权限的去物料主数据
    const toStock = ['wms', 'plan', 'purchase', 'sales', 'qa', 'qc', 'finance'].some((p) => perms.has(p));

    // —— 序列号（UDI 中的 (21)） ——
    const snWhere = isUdi ? (parsed.sn ? { sn: parsed.sn } : null) : { OR: [{ sn: lk }, { udi: parsed.raw.trim() }] };
    if (snWhere) {
      for (const s of await tx.serialNumber.findMany({ where: snWhere, take, orderBy, include: { material: true } })) {
        out.push({
          type: 'serial', type_text: '序列号', id: s.id, no: s.sn, title: s.sn, sub: `${s.material?.code ?? ''} ${s.material?.name ?? ''}`.trim(),
          status: s.status, status_label: statusLabel('serial', s.status), url: `/trace?sn=${enc(s.sn)}`, exact: eq(s.sn, parsed.sn || q),
        });
      }
    }

    // —— 批号（UDI 中的 (10)，或输入本身） ——
    const lotQ = isUdi ? parsed.lot : q;
    if (lotQ && !(isUdi && parsed.sn && out.length)) {
      const cond = isUdi ? Prisma.sql`s.lot_no = ${lotQ}` : Prisma.sql`s.lot_no ILIKE ${`%${lotQ}%`}`;
      const lots = await tx.$queryRaw<{ lot_no: string; material_id: number; code: string; name: string; qty: number; statuses: string }[]>`
        SELECT s.lot_no, m.id AS material_id, m.code, m.name, SUM(s.qty)::float8 AS qty, STRING_AGG(DISTINCT s.status, ',') AS statuses
        FROM wms_stock s JOIN md_material m ON m.id = s.material_id
        WHERE s.lot_no <> '' AND ${cond}
        GROUP BY s.lot_no, m.id, m.code, m.name ORDER BY (UPPER(s.lot_no) = UPPER(${lotQ})) DESC, s.lot_no, m.code LIMIT ${take}`;
      for (const r of lots) {
        const trace = `/trace?material_code=${enc(r.code)}&lot_no=${enc(r.lot_no)}`;
        const stock = `/wms/stock?q=${enc(r.lot_no)}&material_id=${r.material_id}&lot_no=${enc(r.lot_no)}`;
        const st = String(r.statuses || '').split(',').filter(Boolean);
        out.push({
          type: 'lot', type_text: '批次', id: r.material_id, no: r.lot_no, code: r.code, title: r.lot_no, sub: `${r.code} ${r.name} · 库存 ${Number(r.qty)}`,
          status: st.length === 1 ? st[0] : null, status_label: st.map((x) => statusLabel('stock', x)).join('、') || null,
          url: toStock ? stock : trace, alt: toStock ? [{ label: '追溯', url: trace }] : [{ label: '库存', url: stock }],
          exact: eq(r.lot_no, lotQ), material_code: r.code,
        });
      }
    }

    if (!isUdi) {
      // —— 生产工单（单号 / 批号） ——
      for (const w of await tx.workOrder.findMany({ where: { OR: [{ no: lk }, { lot_no: lk }] }, take, orderBy, include: { material: true } })) {
        out.push({
          type: 'work_order', type_text: '生产工单', id: w.id, no: w.no, title: w.no, sub: `${w.material?.name ?? ''} · 批号 ${w.lot_no || '-'}`,
          status: w.status, status_label: statusLabel('work_order', w.status), url: `/mes/work-orders/${w.id}`,
          // 按批号命中时，若库存中已有同号批次（成品批），以批次为准；否则工单批号也算完全匹配
          exact: eq(w.no, q) || (eq(w.lot_no, q) && !out.some((h) => h.type === 'lot' && h.exact)),
        });
      }
      if (can(READ_PERMS.salesOrder)) {
        for (const o of await tx.salesOrder.findMany({ where: { OR: [{ no: lk }, { customer_po: lk }] }, take, orderBy, include: { customer: true } })) {
          out.push({
            type: 'sales_order', type_text: '销售订单', id: o.id, no: o.no, title: o.no,
            sub: [o.customer?.name, o.customer_po ? `客户PO ${o.customer_po}` : null].filter(Boolean).join(' · '),
            status: o.status, status_label: statusLabel('sales_order', o.status), url: `/sales/orders/${o.id}`, exact: eq(o.no, q) || eq(o.customer_po, q),
          });
        }
      }
      if (can(READ_PERMS.purchaseOrder)) {
        for (const o of await tx.purchaseOrder.findMany({ where: { no: lk }, take, orderBy, include: { supplier: true } })) {
          out.push({
            type: 'purchase_order', type_text: '采购订单', id: o.id, no: o.no, title: o.no, sub: o.supplier?.name ?? null,
            status: o.status, status_label: statusLabel('purchase_order', o.status), url: `/purchase/orders/${o.id}`, exact: eq(o.no, q),
          });
        }
      }
      for (const sh of await tx.shipment.findMany({ where: { OR: [{ no: lk }, { tracking_no: lk }] }, take, orderBy, include: { customer: true } })) {
        out.push({
          type: 'shipment', type_text: '发货单', id: sh.id, no: sh.no, title: sh.no,
          sub: [sh.customer?.name, sh.tracking_no ? `运单 ${sh.tracking_no}` : null].filter(Boolean).join(' · '),
          status: sh.status, status_label: statusLabel('doc', sh.status), url: `/wms/shipments?q=${enc(sh.no)}&id=${sh.id}`, exact: eq(sh.no, q) || eq(sh.tracking_no, q),
        });
      }
      for (const i of await tx.materialIssue.findMany({ where: { no: lk }, take, orderBy, include: { work_order: true } })) {
        out.push({
          type: 'issue', type_text: i.issue_type === 'RETURN' ? '退料单' : '领料单', id: i.id, no: i.no, title: i.no, sub: `工单 ${i.work_order?.no ?? '-'}`,
          status: i.status, status_label: statusLabel('doc', i.status), url: `/wms/issues?q=${enc(i.no)}&id=${i.id}`, exact: eq(i.no, q),
        });
      }
      for (const r of await tx.receipt.findMany({ where: { OR: [{ no: lk }, { delivery_note: lk }] }, take, orderBy, include: { supplier: true, customer: true } })) {
        out.push({
          type: 'receipt', type_text: '入库单', id: r.id, no: r.no, title: r.no,
          sub: [r.supplier?.name ?? r.customer?.name, r.delivery_note ? `送货单 ${r.delivery_note}` : null].filter(Boolean).join(' · ') || null,
          status: r.status, status_label: statusLabel('doc', r.status), url: `/wms/receipts?q=${enc(r.no)}&id=${r.id}`, exact: eq(r.no, q) || eq(r.delivery_note, q),
        });
      }
      for (const c of await tx.stockCount.findMany({ where: { no: lk }, take, orderBy, include: { warehouse: true } })) {
        out.push({
          type: 'stock_count', type_text: '盘点单', id: c.id, no: c.no, title: c.no, sub: c.warehouse?.name ?? null,
          status: c.status, status_label: statusLabel('doc', c.status), url: `/wms/counts?id=${c.id}`, exact: eq(c.no, q),
        });
      }
      for (const r of await tx.customerReturn.findMany({ where: { no: lk }, take, orderBy })) {
        out.push({
          type: 'customer_return', type_text: '客户退货（RMA）', id: r.id, no: r.no, title: r.no, sub: (r.reason || '').slice(0, 30),
          status: r.status, status_label: statusLabel('customer_return', r.status), url: `/wms/customer-returns?q=${enc(r.no)}&id=${r.id}`, exact: eq(r.no, q),
        });
      }
      for (const r of await tx.supplierReturn.findMany({ where: { no: lk }, take, orderBy })) {
        out.push({
          type: 'supplier_return', type_text: '退供应商单', id: r.id, no: r.no, title: r.no, sub: r.lot_no ? `批号 ${r.lot_no}` : null,
          status: r.status, status_label: statusLabel('supplier_return', r.status), url: `/quality/supplier-returns?q=${enc(r.no)}&id=${r.id}`, exact: eq(r.no, q),
        });
      }
      for (const i of await tx.inspection.findMany({ where: { no: lk }, take, orderBy, include: { material: true } })) {
        out.push({
          type: 'inspection', type_text: '检验单', id: i.id, no: i.no, title: i.no, sub: `${i.material?.name ?? ''}${i.lot_no ? ` · 批号 ${i.lot_no}` : ''}`,
          status: i.status, status_label: statusLabel('inspection', i.status), url: `/quality/inspections/${i.id}`, exact: eq(i.no, q),
        });
      }
      for (const n of await tx.ncr.findMany({ where: { no: lk }, take, orderBy })) {
        out.push({
          type: 'ncr', type_text: '不合格品 NCR', id: n.id, no: n.no, title: n.no, sub: (n.description || '').slice(0, 40),
          status: n.status, status_label: statusLabel('ncr', n.status), url: `/quality/ncrs?q=${enc(n.no)}&id=${n.id}`, exact: eq(n.no, q),
        });
      }
      for (const c of await tx.complaint.findMany({ where: { OR: [{ no: lk }, { report_no: lk }] }, take, orderBy })) {
        out.push({
          type: 'complaint', type_text: '客户投诉', id: c.id, no: c.no, title: c.no, sub: (c.description || '').slice(0, 40),
          status: c.status, status_label: statusLabel('complaint', c.status), url: `/quality/complaints?q=${enc(c.no)}&id=${c.id}`, exact: eq(c.no, q),
        });
      }
      for (const c of await tx.capa.findMany({ where: { no: lk }, take, orderBy })) {
        out.push({
          type: 'capa', type_text: 'CAPA', id: c.id, no: c.no, title: c.no, sub: c.title,
          status: c.status, status_label: statusLabel('capa', c.status), url: `/quality/capas?id=${c.id}`, exact: eq(c.no, q),
        });
      }
      if (can(READ_PERMS.finance)) {
        for (const d of await tx.financeDoc.findMany({ where: { OR: [{ no: lk }, { ref_no: lk }] }, take, orderBy, include: { customer: true, supplier: true } })) {
          out.push({
            type: 'finance', type_text: d.doc_type === 'AR' ? '应收单' : '应付单', id: d.id, no: d.no, title: d.no,
            sub: [d.customer?.name ?? d.supplier?.name, d.ref_no ? `来源 ${d.ref_no}` : null].filter(Boolean).join(' · '),
            status: d.status, status_label: statusLabel('finance', d.status), url: `/finance?tab=${d.doc_type}&q=${enc(d.no)}`, exact: eq(d.no, q),
          });
        }
      }
      // —— 库位 ——
      for (const l of await tx.location.findMany({ where: { OR: [{ code: lk }, { name: lk }] }, take, orderBy, include: { warehouse: true } })) {
        out.push({
          type: 'location', type_text: '库位', id: l.id, code: l.code, title: l.code, sub: `${l.warehouse?.name ?? ''} ${l.name ?? ''}`.trim(),
          url: toStock ? `/wms/stock?location_id=${l.id}&location_code=${enc(l.code)}` : `/master/locations?q=${enc(l.code)}`,
          alt: [{ label: '库位资料', url: `/master/locations?q=${enc(l.code)}` }],
          exact: eq(l.code, q),
        });
      }
    }

    // —— 物料（编码 / 名称 / GTIN） ——
    const matWhere = isUdi ? (parsed.gtin ? { gtin: { in: [parsed.gtin, parsed.gtin.replace(/^0+/, '')] } } : null) : { OR: [{ code: lk }, { name: lk }, { gtin: q }] };
    if (matWhere && !(isUdi && out.length)) {
      for (const m of await tx.material.findMany({ where: matWhere, take, orderBy })) {
        const stock = `/wms/stock?q=${enc(m.code)}&material_id=${m.id}`;
        const master = `/master/materials?q=${enc(m.code)}`;
        out.push({
          type: 'material', type_text: '物料', id: m.id, code: m.code, title: `${m.code} ${m.name}`, sub: m.spec,
          url: toStock ? stock : master, alt: toStock ? [{ label: '物料资料', url: master }] : [{ label: '库存', url: stock }],
          exact: eq(m.code, q) || eq(m.gtin, q),
        });
      }
    }

    if (!isUdi) {
      for (const e of await tx.equipment.findMany({ where: { OR: [{ code: lk }, { name: lk }] }, take, orderBy })) {
        out.push({
          type: 'equipment', type_text: '设备仪器', id: e.id, code: e.code, title: `${e.code} ${e.name}`, sub: e.next_calibration_date ? `下次校准 ${e.next_calibration_date.toISOString().slice(0, 10)}` : null,
          status: e.status, status_label: statusLabel('equipment', e.status), url: `/master/equipment?q=${enc(e.code)}`, exact: eq(e.code, q),
        });
      }
      for (const c of await tx.customer.findMany({ where: { OR: [{ code: lk }, { name: lk }] }, take: 4, orderBy })) {
        out.push({ type: 'customer', type_text: '客户', id: c.id, code: c.code, title: `${c.code} ${c.name}`, url: `/master/customers?q=${enc(c.code)}`, exact: eq(c.code, q) || eq(c.name, q) });
      }
      for (const s of await tx.supplier.findMany({ where: { OR: [{ code: lk }, { name: lk }] }, take: 4, orderBy })) {
        out.push({ type: 'supplier', type_text: '供应商', id: s.id, code: s.code, title: `${s.code} ${s.name}`, url: `/master/suppliers?q=${enc(s.code)}`, exact: eq(s.code, q) || eq(s.name, q) });
      }
    }

    const rank = (h: SearchHit) => (h.exact ? 0 : 1000) + ORDER.indexOf(h.type);
    return out.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map(({ h }) => h);
  }
}
