/**
 * 审计追踪 / 电子签名台账的“可读化”（评审 E-08、E-26、D#22）：
 *  - entity_name：数据表 → 中文对象名；doc_no / doc_url：记录的单号（或编码、序列号、BOM“产品 版本”），可点击跳到详情；
 *    子表记录（BOM 明细、订单行、检验项目…）显示所属单据的单号。
 *  - refs：变更内容里的 ID 字段（物料ID、库位ID…）→ “编码 名称”。
 *  - line_changes：主表审计中的嵌套子表写入（如 BOM 保存时“删除全部明细 + 重建”）按行比对出差异：
 *    “第70行 SCREW-M3X8：用量 12→14”。修改前的明细取自同一记录更早的审计（新建/上一次保存），按审计顺序重放。
 *  - 按单号/编码查：docTargets() 把输入的单号、物料编码等解析为 (对象, 记录ID) 集合（含子表、该物料的 BOM/工艺）。
 * 只读：不修改任何审计记录。
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';

type Rec = Record<string, any>;

const MODELS = Prisma.dmmf.datamodel.models;
const BY_TABLE = new Map(MODELS.map((m) => [m.dbName ?? m.name, m]));
const BY_NAME = new Map(MODELS.map((m) => [m.name, m]));
export const tableOf = (model: string) => BY_NAME.get(model)?.dbName ?? model;
const delegateOf = (db: any, model: string) => db[model.charAt(0).toLowerCase() + model.slice(1)];

/** 数据表 → 中文对象名 */
export const ENTITY_NAMES: Record<string, string> = {
  erp_sales_order: '销售订单', erp_sales_order_line: '销售订单行', erp_purchase_order: '采购订单', erp_purchase_order_line: '采购订单行',
  erp_mrp_run: 'MRP 运算', erp_mrp_suggestion: 'MRP 建议', fin_doc: '应收应付单', fin_payment: '收付款',
  md_customer: '客户', md_supplier: '供应商', md_material: '物料', md_work_center: '工作中心', md_equipment: '设备',
  md_calibration: '校准记录', md_warehouse: '仓库', md_location: '库位', md_exchange_rate: '汇率',
  eng_bom: 'BOM', eng_bom_line: 'BOM 明细', eng_routing: '工艺路线', eng_routing_op: '工艺工序', eng_routing_param: '工序参数（测试规格）',
  mes_work_order: '生产工单', mes_wo_material: '工单用料', mes_wo_operation: '工单工序', mes_serial: '序列号', mes_op_record: '过站记录',
  mes_test_value: '测试数据', mes_key_part: '关键件绑定', mes_product_release: '产品放行批', hr_qualification: '人员上岗资质',
  qms_inspection: '检验单', qms_inspection_item: '检验项目', qms_ncr: 'NCR 不合格品', qms_capa: 'CAPA', qms_complaint: '客户投诉',
  qms_material_inspection_item: '物料检验规范',
  wms_stock: '库存', wms_stock_move: '库存流水', wms_receipt: '入库单', wms_receipt_line: '入库明细', wms_issue: '领料单',
  wms_issue_line: '领料明细', wms_shipment: '发货单', wms_shipment_line: '发货明细', wms_stock_count: '盘点单', wms_stock_count_line: '盘点明细',
  wms_customer_return: '客户退货', wms_customer_return_line: '客户退货明细', wms_supplier_return: '退供应商单',
  sys_user: '用户', sys_login: '登录', sys_attachment: '附件', sys_setting: '系统设置', sys_audit_verify: '审计完整性校验',
};
export const entityName = (e: string | null | undefined) => (e ? ENTITY_NAMES[e] ?? e : '-');

/** 子表 → 所属单据的外键（显示/搜索时归到父单据） */
const PARENT: Record<string, string> = {
  SalesOrderLine: 'order_id', PurchaseOrderLine: 'order_id', MrpSuggestion: 'run_id', Payment: 'doc_id', BomLine: 'bom_id',
  RoutingOperation: 'routing_id', RoutingParam: 'operation_id', ReceiptLine: 'receipt_id', MaterialIssueLine: 'issue_id',
  ShipmentLine: 'shipment_id', StockCountLine: 'count_id', WorkOrderMaterial: 'wo_id', WorkOrderOperation: 'wo_id',
  OperationRecord: 'sn_id', TestValue: 'record_id', KeyPartBinding: 'sn_id', InspectionItem: 'inspection_id',
  CustomerReturnLine: 'return_id', Qualification: 'user_id', CalibrationRecord: 'equipment_id', MaterialInspectionItem: 'material_id',
};

/** 未在 Prisma 中声明关系的常见外键字段 */
const FK_FALLBACK: Record<string, string> = {
  material_id: 'Material', component_id: 'Material', key_part_material_id: 'Material', supplier_id: 'Supplier', customer_id: 'Customer',
  owner_customer_id: 'Customer', location_id: 'Location', default_location_id: 'Location', from_location_id: 'Location',
  to_location_id: 'Location', warehouse_id: 'Warehouse', work_center_id: 'WorkCenter', equipment_id: 'Equipment', ncr_id: 'Ncr',
  wo_id: 'WorkOrder', so_id: 'SalesOrder', po_id: 'PurchaseOrder', user_id: 'User', bom_id: 'Bom', routing_id: 'Routing',
  inspection_id: 'Inspection', receipt_id: 'Receipt', capa_id: 'Capa', release_id: 'ProductRelease', shipment_id: 'Shipment',
  default_supplier_id: 'Supplier', sn_id: 'SerialNumber', doc_id: 'FinanceDoc',
};

/** 模型的外键字段 → 目标模型 */
function fkMap(model: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = BY_NAME.get(model);
  for (const f of m?.fields ?? []) {
    if (f.kind === 'object' && f.relationFromFields?.length === 1) out[f.relationFromFields[0]] = f.type;
  }
  for (const f of m?.fields ?? []) if (f.kind === 'scalar' && !out[f.name] && FK_FALLBACK[f.name]) out[f.name] = FK_FALLBACK[f.name];
  return out;
}
const FK_CACHE = new Map<string, Record<string, string>>();
const fks = (model: string) => {
  let v = FK_CACHE.get(model);
  if (!v) FK_CACHE.set(model, (v = fkMap(model)));
  return v;
};

/** 关系名 → 子模型（如 Bom.lines → BomLine） */
const relModel = (model: string, rel: string) => BY_NAME.get(model)?.fields.find((f) => f.name === rel && f.kind === 'object')?.type;

const INCLUDE: Record<string, any> = { Bom: { material: true }, Routing: { material: true }, Stock: { material: true, location: true }, Qualification: { user: true }, CalibrationRecord: { equipment: true }, ProductRelease: { work_order: true } };

/** 记录的显示标签（单号 / 编码 名称 / 序列号 / 姓名（账号）…） */
function labelOf(model: string, r: Rec | null | undefined): string | null {
  if (!r) return null;
  switch (model) {
    case 'Bom':
    case 'Routing':
      return `${r.material?.code ?? `物料#${r.material_id}`} ${r.version ?? ''}`.trim();
    case 'User':
      return r.full_name ? `${r.full_name}（${r.username}）` : r.username;
    case 'Stock':
      return `${r.material?.code ?? ''} 批号${r.lot_no || '-'} ${r.location?.code ?? ''}`.trim();
    case 'ExchangeRate':
      return `${r.currency} ${r.effective_date instanceof Date ? r.effective_date.toISOString().slice(0, 10) : r.effective_date ?? ''}`;
    case 'Qualification':
      return `${r.user?.full_name ?? `用户#${r.user_id}`} ${r.op_code ?? ''}`;
    case 'CalibrationRecord':
      return `${r.equipment?.code ?? ''} 校准`;
    default:
      if (r.no) return String(r.no);
      if (r.code) return r.name ? `${r.code} ${r.name}` : String(r.code);
      if (r.sn) return String(r.sn);
      if (r.username) return String(r.username);
      if (r.name) return String(r.name);
      return null;
  }
}

/** 记录的详情页地址（前端路由） */
function urlOf(model: string, r: Rec | null | undefined): string | null {
  if (!r) return null;
  const q = (v: unknown) => encodeURIComponent(String(v ?? ''));
  switch (model) {
    case 'SalesOrder': return `/sales/orders/${r.id}`;
    case 'PurchaseOrder': return `/purchase/orders/${r.id}`;
    case 'WorkOrder': return `/mes/work-orders/${r.id}`;
    case 'Inspection': return `/quality/inspections/${r.id}`;
    case 'Bom': return `/engineering/boms/${r.id}`;
    case 'Routing': return `/engineering/routings/${r.id}`;
    case 'Ncr': return `/quality/ncrs?id=${r.id}`;
    case 'Capa': return `/quality/capas?q=${q(r.no)}`;
    case 'Complaint': return `/quality/complaints?q=${q(r.no)}`;
    case 'SupplierReturn': return `/quality/supplier-returns?q=${q(r.no)}`;
    case 'ProductRelease': return r.wo_id ? `/quality/dhr/${r.wo_id}` : null;
    case 'Receipt': return `/wms/receipts?q=${q(r.no)}`;
    case 'MaterialIssue': return `/wms/issues?id=${r.id}`;
    case 'Shipment': return `/wms/shipments?q=${q(r.no)}`;
    case 'StockCount': return `/wms/counts?id=${r.id}`;
    case 'CustomerReturn': return `/wms/customer-returns?q=${q(r.no)}`;
    case 'SerialNumber': return `/trace?sn=${q(r.sn)}`;
    case 'Stock': return `/wms/stock?material_id=${r.material_id}&lot_no=${q(r.lot_no)}`;
    case 'Material': return `/master/materials?q=${q(r.code)}`;
    case 'Customer': return `/master/customers?q=${q(r.code)}`;
    case 'Supplier': return `/master/suppliers?q=${q(r.code)}`;
    case 'Equipment': return `/master/equipment?q=${q(r.code)}`;
    case 'Location': return `/master/locations?q=${q(r.code)}`;
    case 'Warehouse': return `/master/warehouses?q=${q(r.code)}`;
    case 'FinanceDoc': return `/finance?q=${q(r.no)}`;
    case 'MrpRun': return '/plan/mrp';
    case 'User': return `/system/users?q=${q(r.username)}`;
    case 'Qualification': return '/system/qualifications';
    default: return null;
  }
}

/** 批量取记录：model → id → row（含标签所需的关联） */
async function fetchRows(db: PrismaService, wanted: Map<string, Set<number>>): Promise<Map<string, Map<number, Rec>>> {
  const out = new Map<string, Map<number, Rec>>();
  await Promise.all(
    [...wanted.entries()].map(async ([model, ids]) => {
      const d = delegateOf(db.base, model);
      const list = [...ids].filter((x) => Number.isInteger(x) && x > 0);
      if (!d || !list.length) return;
      const rows: Rec[] = await d.findMany({ where: { id: { in: list } }, ...(INCLUDE[model] ? { include: INCLUDE[model] } : {}) });
      out.set(model, new Map(rows.map((r) => [r.id, r])));
    }),
  );
  return out;
}

const parse = (s: string | null | undefined): Rec | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

// ---------------- 子表差异 ----------------

export interface FieldChange { field: string; old: unknown; new: unknown }
export interface LineItemChange {
  key: string;
  op: 'ADD' | 'DEL' | 'MOD';
  /** 行的显示：物料编码 名称 / 工序号 名称 / 参数编码 名称 */
  title: string | null;
  /** MOD：变化的字段；ADD/DEL：该行的主要字段 */
  fields: FieldChange[];
  /** 嵌套的下一级（如工序下的测试参数） */
  children?: { rel: string; rel_name: string; items: LineItemChange[] }[];
}
export interface LineChanges {
  rel: string;
  rel_name: string;
  /** 修改前的明细是否可知（有更早的审计记录） */
  before_known: boolean;
  items: LineItemChange[];
  unchanged: number;
}

const REL_NAMES: Record<string, string> = { lines: '明细', operations: '工序', params: '测试参数', items: '检验项目', materials: '用料' };
const NOISE = new Set(['id', 'created_at', 'updated_at', 'created_by']);

const listOf = (v: any): Rec[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);

/** 嵌套写入 → 写入后的子表快照；不支持的写法（update/delete 单行）返回 null */
function applyNested(prev: Rec[] | null, op: any): { after: Rec[]; replaced: boolean } | null {
  if (!op || typeof op !== 'object') return null;
  const creates = listOf(op.create);
  if (op.deleteMany !== undefined || op.set !== undefined) return { after: creates, replaced: true };
  if (op.create !== undefined && op.update === undefined && op.delete === undefined && op.upsert === undefined) {
    return { after: [...(prev ?? []), ...creates], replaced: false };
  }
  return null;
}

function itemKey(it: Rec, idx: number): string {
  if (it.line_no !== undefined && it.line_no !== null) return `第${it.line_no}行`;
  if (it.seq !== undefined && it.seq !== null) return `工序${it.seq}`;
  if (it.code) return String(it.code);
  if (it.name) return String(it.name);
  return `#${idx + 1}`;
}

const isNestedOp = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && ('create' in (v as Rec) || 'deleteMany' in (v as Rec));
const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function diffLists(model: string, before: Rec[], after: Rec[], collect: (model: string, field: string, v: unknown) => void, titleOf: (model: string, it: Rec) => string | null): { items: LineItemChange[]; unchanged: number } {
  const b = new Map(before.map((x, i) => [itemKey(x, i), x]));
  const a = new Map(after.map((x, i) => [itemKey(x, i), x]));
  const items: LineItemChange[] = [];
  let unchanged = 0;
  const fkFields = fks(model);
  const scalarKeys = (o: Rec) => Object.keys(o).filter((k) => !NOISE.has(k) && !isNestedOp(o[k]));
  const visit = (o: Rec) => Object.entries(o).forEach(([k, v]) => fkFields[k] && collect(fkFields[k], k, v));
  const mainFields = (o: Rec) => scalarKeys(o).filter((k) => o[k] !== null && o[k] !== undefined && o[k] !== '').map((k) => ({ field: k, old: null, new: o[k] }));
  for (const [k, x] of a) {
    visit(x);
    const y = b.get(k);
    if (!y) {
      items.push({ key: k, op: 'ADD', title: titleOf(model, x), fields: mainFields(x) });
      continue;
    }
    visit(y);
    const fields: FieldChange[] = [];
    for (const f of new Set([...scalarKeys(x), ...scalarKeys(y)])) if (!eq(y[f], x[f])) fields.push({ field: f, old: norm(y[f]), new: norm(x[f]) });
    const children: LineItemChange['children'] = [];
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!isNestedOp(x[f]) && !isNestedOp(y[f])) continue;
      const cm = relModel(model, f);
      if (!cm) continue;
      const d = diffLists(cm, listOf(y[f]?.create), listOf(x[f]?.create), collect, titleOf);
      if (d.items.length) children.push({ rel: f, rel_name: REL_NAMES[f] ?? f, items: d.items });
    }
    if (fields.length || children.length) items.push({ key: k, op: 'MOD', title: titleOf(model, x), fields, ...(children.length ? { children } : {}) });
    else unchanged++;
  }
  for (const [k, y] of b) {
    if (a.has(k)) continue;
    visit(y);
    items.push({ key: k, op: 'DEL', title: titleOf(model, y), fields: mainFields(y).map((f) => ({ field: f.field, old: f.new, new: null })) });
  }
  return { items, unchanged };
}

// ---------------- 主函数 ----------------

/** 给审计记录（或电子签名记录）补充可读信息；rows 为 ser 后的 JSON（含 entity / entity_id / changes） */
export async function enrichAudit(db: PrismaService, rows: Rec[], opts: { lineDiff?: boolean } = {}): Promise<Rec[]> {
  const wanted = new Map<string, Set<number>>();
  const want = (model: string | undefined, id: unknown) => {
    const n = Number(id);
    if (!model || !Number.isInteger(n) || n <= 0) return;
    if (!wanted.has(model)) wanted.set(model, new Set());
    wanted.get(model)!.add(n);
  };
  const modelOfRow = (r: Rec) => BY_TABLE.get(r.entity)?.name;

  // 1) 子表差异：按 (对象, 记录) 重放更早的嵌套写入
  const lineInfo = new Map<number, Rec[]>(); // audit id → LineChanges[]（含原始快照，稍后补标题）
  const nestedRows = opts.lineDiff === false ? [] : rows.filter((r) => r.changes && String(r.changes).includes('"_nested"'));
  const pending: { row: Rec; model: string; rel: string; before: Rec[] | null; after: Rec[] }[] = [];
  if (nestedRows.length) {
    const keys = new Map<string, { entity: string; entity_id: number; maxId: number }>();
    for (const r of nestedRows) {
      const k = `${r.entity}:${r.entity_id}`;
      const cur = keys.get(k);
      if (!cur || cur.maxId < r.id) keys.set(k, { entity: r.entity, entity_id: r.entity_id, maxId: r.id });
    }
    const history = await db.base.auditLog.findMany({
      where: { OR: [...keys.values()].map((k) => ({ entity: k.entity, entity_id: k.entity_id, id: { lte: k.maxId } })), changes: { contains: '"_nested"' } },
      orderBy: { id: 'asc' },
      select: { id: true, entity: true, entity_id: true, action: true, changes: true },
    });
    const pageIds = new Set(nestedRows.map((r) => r.id));
    const byId = new Map(nestedRows.map((r) => [r.id, r]));
    const snaps = new Map<string, Map<string, Rec[] | null>>(); // 记录 → 关系 → 快照
    for (const h of history) {
      const model = BY_TABLE.get(h.entity)?.name;
      const nested = parse(h.changes)?._nested;
      if (!model || !nested || typeof nested !== 'object') continue;
      const k = `${h.entity}:${h.entity_id}`;
      if (!snaps.has(k)) snaps.set(k, new Map());
      const relSnaps = snaps.get(k)!;
      for (const [rel, op] of Object.entries(nested)) {
        const prev = h.action === 'CREATE' ? [] : relSnaps.has(rel) ? relSnaps.get(rel)! : null;
        const res = applyNested(prev, op);
        if (pageIds.has(h.id) && res) pending.push({ row: byId.get(h.id)!, model, rel, before: prev, after: res.after });
        relSnaps.set(rel, res ? res.after : null);
      }
    }
  }

  // 2) 收集需要查名称的记录：本记录、父单据、变更中的外键
  const refsWanted = new Map<Rec, { model: string; field: string; id: unknown }[]>();
  const pushRef = (m: Map<Rec, { model: string; field: string; id: unknown }[]>, row: Rec, x: { model: string; field: string; id: unknown }) => {
    const l = m.get(row);
    if (l) l.push(x);
    else m.set(row, [x]);
  };
  for (const r of rows) {
    const model = modelOfRow(r);
    if (r.entity === 'sys_login') want('User', r.entity_id);
    if (!model) continue;
    want(model, r.entity_id);
    const ch = parse(r.changes);
    if (!ch) continue;
    const fk = fks(model);
    for (const [f, v] of Object.entries(ch)) {
      if (!fk[f]) continue;
      for (const id of Array.isArray(v) ? v : [v]) {
        want(fk[f], id);
        pushRef(refsWanted, r, { model: fk[f], field: f, id });
      }
    }
  }
  const lineCollect = new Map<Rec, { model: string; field: string; id: unknown }[]>();
  for (const p of pending) {
    const childModel = relModel(p.model, p.rel);
    if (!childModel) continue;
    const collect = (m: string, field: string, v: unknown) => {
      want(m, v);
      pushRef(lineCollect, p.row, { model: m, field, id: v });
    };
    for (const it of [...(p.before ?? []), ...p.after]) {
      const fk = fks(childModel);
      for (const [f, v] of Object.entries(it)) if (fk[f]) collect(fk[f], f, v);
    }
  }
  const fetched = await fetchRows(db, wanted);

  // 父单据（子表记录归到父单据；记录已删除时用变更内容中的外键）
  const parentWanted = new Map<string, Set<number>>();
  const parentOf = (model: string, r: Rec): [string, number] | null => {
    const pf = PARENT[model];
    if (!pf) return null;
    const self = fetched.get(model)?.get(r.entity_id);
    const ch = parse(r.changes) ?? {};
    const raw = self?.[pf] ?? (Array.isArray(ch[pf]) ? ch[pf][1] ?? ch[pf][0] : ch[pf]);
    const pm = fks(model)[pf];
    return pm && raw ? [pm, Number(raw)] : null;
  };
  for (const r of rows) {
    const model = modelOfRow(r);
    const p = model ? parentOf(model, r) : null;
    if (p) {
      if (!parentWanted.has(p[0])) parentWanted.set(p[0], new Set());
      parentWanted.get(p[0])!.add(p[1]);
    }
  }
  if (parentWanted.size) {
    const more = await fetchRows(db, parentWanted);
    // 工序参数的父是工序，再上一级是工艺路线
    const ops = more.get('RoutingOperation');
    if (ops?.size) {
      const rt = await fetchRows(db, new Map([['Routing', new Set([...ops.values()].map((o) => o.routing_id))]]));
      more.set('Routing', new Map([...(more.get('Routing') ?? new Map()), ...(rt.get('Routing') ?? new Map())]));
    }
    for (const [m, map] of more) fetched.set(m, new Map([...(fetched.get(m) ?? new Map()), ...map]));
  }
  const get = (model: string, id: unknown) => fetched.get(model)?.get(Number(id));
  const refLabel = (model: string, id: unknown) => labelOf(model, get(model, id)) ?? (id === null || id === undefined ? null : `#${id}`);

  const titleOf = (model: string, it: Rec): string | null => {
    if (model === 'BomLine' || model === 'SalesOrderLine' || model === 'PurchaseOrderLine' || model === 'WorkOrderMaterial') {
      const mid = it.component_id ?? it.material_id;
      return mid ? refLabel('Material', mid) : null;
    }
    if (model === 'RoutingOperation') return [it.code, it.name].filter(Boolean).join(' ') || null;
    // 工序参数的行键已是编码（如 HIPOT），标题只显示名称，避免“HIPOTHIPOT”
    if (model === 'RoutingParam') return it.name ?? null;
    return it.name ?? null;
  };
  for (const p of pending) {
    const childModel = relModel(p.model, p.rel);
    if (!childModel) continue;
    const d = diffLists(childModel, p.before ?? [], p.after, () => undefined, titleOf);
    const list = lineInfo.get(p.row.id) ?? [];
    if (p.before === null) {
      // 修改前的明细无记录：只列出保存后的内容
      list.push({ rel: p.rel, rel_name: REL_NAMES[p.rel] ?? p.rel, before_known: false, items: d.items, unchanged: 0 });
    } else {
      list.push({ rel: p.rel, rel_name: REL_NAMES[p.rel] ?? p.rel, before_known: true, items: d.items, unchanged: d.unchanged });
    }
    lineInfo.set(p.row.id, list);
  }

  return rows.map((r) => {
    const model = modelOfRow(r);
    let doc_no: string | null = null;
    let doc_url: string | null = null;
    let parent_name: string | null = null;
    if (r.entity === 'sys_login') {
      const u = get('User', r.entity_id);
      doc_no = u ? labelOf('User', u) : r.username;
      doc_url = u ? urlOf('User', u) : null;
    } else if (r.entity === 'sys_setting') {
      doc_no = String(r.changes || '').includes('"company.') ? '公司信息' : '上线迁移模式';
    } else if (r.entity === 'sys_audit_verify') {
      doc_no = '完整性校验';
    } else if (model) {
      const p = parentOf(model, r);
      if (p) {
        let [pm, pid] = p;
        let prow = get(pm, pid);
        if (pm === 'RoutingOperation' && prow) {
          pm = 'Routing';
          prow = get('Routing', prow.routing_id);
        }
        doc_no = labelOf(pm, prow);
        doc_url = urlOf(pm, prow);
        parent_name = entityName(tableOf(pm));
      } else {
        const self = get(model, r.entity_id);
        const ch = parse(r.changes) ?? {};
        doc_no = labelOf(model, self) ?? r.doc_no ?? (typeof ch.no === 'string' ? ch.no : typeof ch.code === 'string' ? ch.code : null);
        doc_url = urlOf(model, self);
      }
    }
    if (!doc_no && r.doc_no) doc_no = r.doc_no;
    const refs: Record<string, Record<string, string>> = {};
    const add = (field: string, model2: string, id: unknown) => {
      if (id === null || id === undefined) return;
      const label = refLabel(model2, id);
      if (!label) return;
      (refs[field] ??= {})[String(id)] = label;
    };
    for (const x of refsWanted.get(r) ?? []) add(x.field, x.model, x.id);
    for (const x of lineCollect.get(r) ?? []) add(x.field, x.model, x.id);
    return {
      ...r,
      entity_name: entityName(r.entity),
      doc_no,
      doc_url,
      ...(parent_name ? { parent_name } : {}),
      refs,
      ...(lineInfo.has(r.id) ? { line_changes: lineInfo.get(r.id) } : {}),
    };
  });
}

/**
 * 按单号 / 编码 / 序列号查找审计对象：返回 (表, 记录ID) 条件列表（含其子表记录；物料还包含其 BOM 与工艺路线）。
 * 输入不区分大小写、支持部分匹配（每类最多 50 条）。
 */
export async function docTargets(db: PrismaService, text: string): Promise<{ entity: string; entity_id: { in: number[] } }[]> {
  const q = text.trim();
  if (!q) return [];
  const c: any = db.base;
  const like = { contains: q, mode: 'insensitive' as const };
  const take = 50;
  const ids = async (model: string, where: Rec) => ((await delegateOf(c, model).findMany({ where, select: { id: true }, take })) as { id: number }[]).map((x) => x.id);
  const out = new Map<string, Set<number>>();
  const put = (model: string, list: number[]) => {
    if (!list.length) return;
    const t = tableOf(model);
    if (!out.has(t)) out.set(t, new Set());
    list.forEach((x) => out.get(t)!.add(x));
  };
  // “编码 版本”（列表上显示的 BOM/工艺单号，如“FG-RL300 A2”）：按产品编码 + 版本精确找 BOM 与工艺路线
  const ver = q.match(/^(\S+)\s+(\S+)$/);
  if (ver) {
    const mats = await ids('Material', { code: { equals: ver[1], mode: 'insensitive' } });
    if (mats.length) {
      const v = { equals: ver[2], mode: 'insensitive' as const };
      put('Bom', await ids('Bom', { material_id: { in: mats }, version: v }));
      put('Routing', await ids('Routing', { material_id: { in: mats }, version: v }));
    }
  }
  const byNo = ['SalesOrder', 'PurchaseOrder', 'WorkOrder', 'Inspection', 'Ncr', 'Capa', 'Receipt', 'MaterialIssue', 'Shipment', 'StockCount', 'FinanceDoc', 'MrpRun', 'ProductRelease', 'CustomerReturn', 'Complaint', 'SupplierReturn'];
  await Promise.all(byNo.map(async (m) => put(m, await ids(m, { no: like }))));
  const byCode = ['Material', 'Customer', 'Supplier', 'Equipment', 'Location', 'Warehouse', 'WorkCenter'];
  await Promise.all(byCode.map(async (m) => put(m, await ids(m, { OR: [{ code: like }, { name: like }] }))));
  put('SerialNumber', await ids('SerialNumber', { sn: like }));
  put('User', await ids('User', { OR: [{ username: like }, { full_name: like }] }));
  // 物料的 BOM、工艺路线（输入产品编码即可查到其 BOM 变更）
  const mats = [...(out.get(tableOf('Material')) ?? [])];
  if (mats.length) {
    put('Bom', await ids('Bom', { material_id: { in: mats } }));
    put('Routing', await ids('Routing', { material_id: { in: mats } }));
  }
  // 子表：当前仍存在的明细行
  const children: [string, string, string][] = [
    ['SalesOrderLine', 'order_id', 'SalesOrder'], ['PurchaseOrderLine', 'order_id', 'PurchaseOrder'], ['BomLine', 'bom_id', 'Bom'],
    ['RoutingOperation', 'routing_id', 'Routing'], ['ReceiptLine', 'receipt_id', 'Receipt'], ['MaterialIssueLine', 'issue_id', 'MaterialIssue'],
    ['ShipmentLine', 'shipment_id', 'Shipment'], ['StockCountLine', 'count_id', 'StockCount'], ['WorkOrderMaterial', 'wo_id', 'WorkOrder'],
    ['WorkOrderOperation', 'wo_id', 'WorkOrder'], ['InspectionItem', 'inspection_id', 'Inspection'], ['CustomerReturnLine', 'return_id', 'CustomerReturn'],
  ];
  await Promise.all(
    children.map(async ([child, fk, parent]) => {
      const pids = [...(out.get(tableOf(parent)) ?? [])];
      if (pids.length) put(child, ((await delegateOf(c, child).findMany({ where: { [fk]: { in: pids } }, select: { id: true }, take: 500 })) as { id: number }[]).map((x) => x.id));
    }),
  );
  // 工序参数（测试规格）挂在工序下：再取一层
  const opIds = [...(out.get(tableOf('RoutingOperation')) ?? [])];
  if (opIds.length) put('RoutingParam', ((await delegateOf(c, 'RoutingParam').findMany({ where: { operation_id: { in: opIds } }, select: { id: true }, take: 2000 })) as { id: number }[]).map((x) => x.id));
  const users = [...(out.get('sys_user') ?? [])];
  const res = [...out.entries()].map(([entity, s]) => ({ entity, entity_id: { in: [...s] } }));
  if (users.length) res.push({ entity: 'sys_login', entity_id: { in: users } });
  return res;
}
