/**
 * 输出视图：把 Prisma 记录转为接口 JSON。
 * 规则 = 所有标量字段（隐藏字段除外）+ 下方定义的计算字段（如 customer_name）+ 指定的子表（如 lines）。
 * 计算字段需要的关联在 include 中声明；查询时用 inc(model, children) 生成 Prisma include。
 */
import { Prisma } from '@prisma/client';
import { num, round } from './num';
import { itemDefects, ncrDueView, parseSamples } from '../qms/qms-rules';

type Props = Record<string, (o: any) => unknown>;
interface View { include?: Record<string, any>; props?: Props; order?: Record<string, any> }

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const HIDDEN = new Set(['password_hash', 'pin_hash', 'params_json', 'serials', 'key_hash']);

const nm = (o: any) => (o ? o.name ?? null : null);
const matInclude = { material: true };
const matProps: Props = {
  material_code: (o) => o.material?.code ?? null,
  material_name: (o) => o.material?.name ?? null,
  material_spec: (o) => o.material?.spec ?? null,
  uom: (o) => o.material?.uom ?? null,
};
const locInclude = { location: true };
const locProps: Props = { location_code: (o) => o.location?.code ?? null };
const parseJson = (s: string | null | undefined) => (s ? JSON.parse(s) : []);

export const VIEWS: Record<string, View> = {
  User: { props: { role_list: (o) => String(o.roles || '').split(',').filter(Boolean), has_pin: (o) => !!o.pin_hash } },
  Material: {
    include: { default_supplier: true, owner_customer: true, customer: true },
    props: {
      default_supplier_name: (o) => nm(o.default_supplier),
      owner_customer_name: (o) => nm(o.owner_customer),
      customer_name: (o) => nm(o.customer),
    },
  },
  Bom: {
    include: matInclude,
    props: { material_code: (o) => o.material?.code ?? null, material_name: (o) => o.material?.name ?? null },
    order: { lines: { line_no: 'asc' } },
  },
  BomLine: {
    include: { component: true },
    props: {
      component_code: (o) => o.component?.code ?? null,
      component_name: (o) => o.component?.name ?? null,
      component_spec: (o) => o.component?.spec ?? null,
      component_uom: (o) => o.component?.uom ?? null,
      customer_supplied: (o) => !!o.component?.owner_customer_id,
    },
  },
  Routing: {
    include: matInclude,
    props: { material_code: (o) => o.material?.code ?? null, material_name: (o) => o.material?.name ?? null },
    order: { operations: { seq: 'asc' } },
  },
  RoutingOperation: {
    include: { work_center: true, key_part_material: true },
    props: { work_center_name: (o) => nm(o.work_center), key_part_material_code: (o) => o.key_part_material?.code ?? null },
    order: { params: { id: 'asc' } },
  },
  Equipment: { include: { work_center: true }, props: { work_center_name: (o) => nm(o.work_center) } },
  Location: {
    include: { warehouse: true },
    props: { warehouse_name: (o) => nm(o.warehouse), warehouse_type: (o) => o.warehouse?.warehouse_type ?? null },
  },
  SalesOrder: { include: { customer: true }, props: { customer_name: (o) => nm(o.customer) }, order: { lines: { line_no: 'asc' } } },
  SalesOrderLine: { include: matInclude, props: { ...matProps, material_name_en: (o) => o.material?.name_en ?? null } },
  PurchaseOrder: { include: { supplier: true }, props: { supplier_name: (o) => nm(o.supplier) }, order: { lines: { line_no: 'asc' } } },
  PurchaseOrderLine: { include: matInclude, props: matProps },
  MrpRun: { order: { suggestions: [{ level: 'asc' }, { id: 'asc' }] } },
  MrpSuggestion: {
    include: { ...matInclude, supplier: true, customer: true },
    props: { ...matProps, supplier_name: (o) => nm(o.supplier), customer_name: (o) => nm(o.customer) },
  },
  FinanceDoc: {
    include: { customer: true, supplier: true },
    props: {
      partner_name: (o) => (o.customer ? o.customer.name : nm(o.supplier)),
      partner_code: (o) => (o.customer ? o.customer.code : (o.supplier?.code ?? null)),
      partner_id: (o) => o.customer_id ?? o.supplier_id ?? null,
      balance: (o) => round(num(o.amount) - num(o.paid_amount), 2),
    },
    order: { payments: { id: 'asc' } },
  },
  Stock: {
    include: { ...matInclude, location: { include: { warehouse: true } }, owner_customer: true, supplier: true },
    props: {
      ...matProps,
      ...locProps,
      warehouse_name: (o) => nm(o.location?.warehouse),
      owner_customer_name: (o) => nm(o.owner_customer),
      supplier_name: (o) => nm(o.supplier),
      unit_cost: (o) => num(o.material?.std_cost),
      amount: (o) => round((o.qty || 0) * num(o.material?.std_cost), 2),
    },
  },
  StockMove: {
    include: { ...matInclude, from_location: true, to_location: true },
    props: { ...matProps, from_location_code: (o) => o.from_location?.code ?? null, to_location_code: (o) => o.to_location?.code ?? null },
  },
  Receipt: {
    include: { supplier: true, customer: true, purchase_order: true, work_order: true },
    props: {
      partner_name: (o) => (o.supplier ? o.supplier.name : nm(o.customer)),
      po_no: (o) => o.purchase_order?.no ?? null,
      wo_no: (o) => o.work_order?.no ?? null,
    },
    order: { lines: { line_no: 'asc' } },
  },
  ReceiptLine: { include: { ...matInclude, ...locInclude }, props: { ...matProps, ...locProps } },
  MaterialIssue: { include: { work_order: true }, props: { wo_no: (o) => o.work_order?.no ?? null }, order: { lines: { id: 'asc' } } },
  MaterialIssueLine: { include: { ...matInclude, ...locInclude }, props: { ...matProps, ...locProps } },
  Shipment: {
    include: { customer: true, sales_order: true },
    props: { customer_name: (o) => nm(o.customer), so_no: (o) => o.sales_order?.no ?? null },
    order: { lines: { id: 'asc' } },
  },
  ShipmentLine: {
    include: { ...matInclude, ...locInclude },
    props: { ...matProps, ...locProps, serial_list: (o) => parseJson(o.serials) },
  },
  StockCount: { include: { warehouse: true }, props: { warehouse_name: (o) => nm(o.warehouse) }, order: { lines: { id: 'asc' } } },
  StockCountLine: {
    include: { ...matInclude, ...locInclude },
    props: {
      ...matProps,
      ...locProps,
      diff_qty: (o) => (o.counted_qty === null || o.counted_qty === undefined ? null : round(o.counted_qty - o.system_qty, 4)),
    },
  },
  WorkOrder: {
    include: { ...matInclude, customer: true, sales_order: true, bom: true, routing: true },
    props: {
      ...matProps,
      customer_name: (o) => nm(o.customer),
      so_no: (o) => o.sales_order?.no ?? null,
      bom_version: (o) => o.bom?.version ?? null,
      routing_version: (o) => o.routing?.version ?? null,
      serial_control: (o) => !!o.material?.serial_control,
      progress: (o) => (o.planned_qty ? round(Math.min(1, (o.completed_qty || 0) / o.planned_qty) * 100, 1) : 0),
    },
    order: { materials: { id: 'asc' }, operations: { seq: 'asc' } },
  },
  WorkOrderMaterial: { include: matInclude, props: { ...matProps, customer_supplied: (o) => !!o.material?.owner_customer_id } },
  WorkOrderOperation: {
    include: { work_center: true },
    props: { work_center_name: (o) => nm(o.work_center), params: (o) => parseJson(o.params_json) },
  },
  SerialNumber: { include: { ...matInclude, work_order: true }, props: { ...matProps, wo_no: (o) => o.work_order?.no ?? null } },
  OperationRecord: {
    include: { serial: true, equipment: true },
    props: { sn: (o) => o.serial?.sn ?? null, equipment_code: (o) => o.equipment?.code ?? null },
    order: { values: { id: 'asc' } },
  },
  KeyPartBinding: { include: matInclude, props: matProps },
  Inspection: {
    include: { ...matInclude, supplier: true },
    props: { ...matProps, supplier_name: (o) => nm(o.supplier) },
    order: { items: { id: 'asc' } },
  },
  // 质量（G6）：检验项目逐件值/不良数；NCR 有效处置期限与超期
  InspectionItem: {
    props: {
      samples: (o) => parseSamples(o).values,
      item_defects: (o) => itemDefects(o),
    },
  },
  Ncr: {
    include: { ...matInclude, work_order: true, supplier: true, customer: true },
    props: {
      ...matProps, wo_no: (o) => o.work_order?.no ?? null, supplier_name: (o) => nm(o.supplier), customer_name: (o) => nm(o.customer),
      due_on: (o) => ncrDueView(o).due_on,
      days_left: (o) => ncrDueView(o).days_left,
      overdue: (o) => ncrDueView(o).overdue,
    },
  },
  // 生产（代理 3）：放行批、人员上岗资质
  ProductRelease: {
    include: { work_order: { include: { material: true } } },
    props: {
      wo_no: (o) => o.work_order?.no ?? null,
      lot_no: (o) => o.work_order?.lot_no ?? null,
      material_code: (o) => o.work_order?.material?.code ?? null,
      material_name: (o) => o.work_order?.material?.name ?? null,
    },
  },
  Qualification: {
    include: { user: true },
    props: {
      username: (o) => o.user?.username ?? null,
      user_full_name: (o) => o.user?.full_name ?? null,
      department: (o) => o.user?.department ?? null,
      badge_no: (o) => o.user?.badge_no ?? null,
      // 纯日期输出 YYYY-MM-DD
      certified_at: (o) => (o.certified_at ? new Date(o.certified_at).toISOString().slice(0, 10) : null),
      expires_at: (o) => (o.expires_at ? new Date(o.expires_at).toISOString().slice(0, 10) : null),
    },
  },
  // 质量/仓储逆向（代理 4）：客户退货、客诉（客户/NCR 等名称由各自 service 补充）
  CustomerReturn: {
    props: { return_date: (o) => (o.return_date ? new Date(o.return_date).toISOString().slice(0, 10) : null) },
    order: { lines: { id: 'asc' } },
  },
  CustomerReturnLine: { include: matInclude, props: matProps },
  Complaint: {
    props: {
      received_date: (o) => (o.received_date ? new Date(o.received_date).toISOString().slice(0, 10) : null),
      event_date: (o) => (o.event_date ? new Date(o.event_date).toISOString().slice(0, 10) : null),
      report_deadline: (o) => (o.report_deadline ? new Date(o.report_deadline).toISOString().slice(0, 10) : null),
      reported_at: (o) => (o.reported_at ? new Date(o.reported_at).toISOString().slice(0, 10) : null),
      replied_at: (o) => (o.replied_at ? new Date(o.replied_at).toISOString().slice(0, 10) : null),
    },
  },
  // RFID（仓库）：读写器、标签、作业会话、原始读取
  RfidReader: {
    include: { warehouse: true, location: true, outside_location: true },
    props: {
      warehouse_name: (o) => nm(o.warehouse),
      location_code: (o) => o.location?.code ?? null,
      outside_location_code: (o) => o.outside_location?.code ?? null,
      has_key: (o) => !!o.key_hash,
    },
  },
  RfidTag: {
    include: { ...matInclude, location: true, serial: true, last_reader: true },
    props: {
      ...matProps,
      ...locProps,
      sn: (o) => o.serial?.sn ?? null,
      sn_status: (o) => o.serial?.status ?? null,
      last_reader_code: (o) => o.last_reader?.code ?? null,
      last_reader_name: (o) => nm(o.last_reader),
    },
  },
  RfidSession: {
    include: { reader: true, location: true },
    props: { reader_code: (o) => o.reader?.code ?? null, reader_name: (o) => nm(o.reader), ...locProps },
    order: { items: { id: 'asc' } },
  },
  RfidRead: { include: { reader: true }, props: { reader_code: (o) => o.reader?.code ?? null } },
};

interface Tree { [k: string]: Tree }
function tree(children: string[] = []): Tree {
  const t: Tree = {};
  for (const path of children) {
    let node = t;
    for (const part of path.split('.')) node = node[part] ??= {};
  }
  return t;
}

function relModel(model: string, rel: string): string {
  const f = MODELS.get(model)?.fields.find((x) => x.name === rel);
  if (!f || f.kind !== 'object') throw new Error(`${model}.${rel} 不是关联`);
  return f.type;
}

function incTree(model: string, t: Tree): Record<string, any> | undefined {
  const v = VIEWS[model] ?? {};
  const out: Record<string, any> = { ...(v.include ?? {}) };
  for (const [rel, sub] of Object.entries(t)) {
    const child = relModel(model, rel);
    const spec: Record<string, any> = {};
    const ci = incTree(child, sub);
    if (ci) spec.include = ci;
    if (v.order?.[rel]) spec.orderBy = v.order[rel];
    out[rel] = Object.keys(spec).length ? spec : true;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 生成 Prisma include：inc('SalesOrder', ['lines'])、inc('Routing', ['operations.params']) */
export function inc(model: string, children: string[] = []): Record<string, any> | undefined {
  return incTree(model, tree(children));
}

function serTree(model: string, obj: any, t: Tree): any {
  if (obj === null || obj === undefined) return null;
  const meta = MODELS.get(model);
  const out: Record<string, any> = {};
  for (const f of meta?.fields ?? []) if (f.kind === 'scalar' && !HIDDEN.has(f.name)) out[f.name] = obj[f.name] ?? null;
  for (const [k, fn] of Object.entries(VIEWS[model]?.props ?? {})) out[k] = fn(obj);
  for (const [rel, sub] of Object.entries(t)) {
    const child = relModel(model, rel);
    const val = obj[rel];
    out[rel] = Array.isArray(val) ? val.map((x) => serTree(child, x, sub)) : serTree(child, val, sub);
  }
  return out;
}

/** 序列化：ser('SalesOrder', so, ['lines']) */
export function ser(model: string, obj: any, children: string[] = []): any {
  return serTree(model, obj, tree(children));
}

export function serList(model: string, objs: any[], children: string[] = []): any[] {
  const t = tree(children);
  return objs.map((o) => serTree(model, o, t));
}
