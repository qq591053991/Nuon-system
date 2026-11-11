/** 数据表 → 中文对象名（审计追踪、电子签名共用） */
export const ENTITY_NAMES: Record<string, string> = {
  erp_sales_order: '销售订单',
  erp_sales_order_line: '销售订单行',
  erp_purchase_order: '采购订单',
  erp_purchase_order_line: '采购订单行',
  erp_mrp_run: 'MRP 运算',
  erp_mrp_suggestion: 'MRP 建议',
  fin_doc: '应收应付单',
  fin_payment: '收付款',
  md_customer: '客户',
  md_supplier: '供应商',
  md_material: '物料',
  md_work_center: '工作中心',
  md_equipment: '设备',
  md_calibration: '校准记录',
  md_warehouse: '仓库',
  md_location: '库位',
  eng_bom: 'BOM',
  eng_bom_line: 'BOM 明细',
  eng_routing: '工艺路线',
  eng_routing_op: '工艺工序',
  eng_routing_param: '工序参数',
  mes_work_order: '生产工单',
  mes_wo_material: '工单用料',
  mes_wo_operation: '工单工序',
  mes_serial: '序列号',
  mes_op_record: '过站记录',
  mes_test_value: '测试数据',
  mes_key_part: '关键件绑定',
  qms_inspection: '检验单',
  qms_inspection_item: '检验项目',
  qms_ncr: 'NCR 不合格品',
  qms_capa: 'CAPA',
  wms_stock: '库存',
  wms_stock_move: '库存流水',
  wms_receipt: '入库单',
  wms_receipt_line: '入库明细',
  wms_issue: '领料单',
  wms_issue_line: '领料明细',
  wms_shipment: '发货单',
  wms_shipment_line: '发货明细',
  wms_stock_count: '盘点单',
  wms_stock_count_line: '盘点明细',
  sys_user: '用户',
  sys_login: '登录',
};

export const entityName = (e?: string | null) => (e ? ENTITY_NAMES[e] || e : '-');

export const ENTITY_OPTIONS = Object.entries(ENTITY_NAMES).map(([value, label]) => ({ value, label: `${label}（${value}）` }));

/** 状态字段对应的字典（用于把审计记录中的状态码翻译成中文） */
export const STATUS_DICT: Record<string, string> = {
  erp_sales_order: 'so_status',
  erp_purchase_order: 'po_status',
  mes_work_order: 'wo_status',
  mes_serial: 'sn_status',
  qms_inspection: 'insp_status',
  qms_ncr: 'ncr_status',
  qms_capa: 'capa_status',
  wms_stock: 'stock_status',
  wms_receipt_line: 'stock_status',
  wms_stock_count_line: 'stock_status',
  eng_bom: 'eng_status',
  eng_routing: 'eng_status',
  md_supplier: 'supplier_status',
  md_equipment: 'equipment_status',
  erp_mrp_suggestion: 'mrp_status',
  fin_doc: 'fin_status',
  wms_receipt: 'doc_status',
  wms_issue: 'doc_status',
  wms_shipment: 'doc_status',
  wms_stock_count: 'doc_status',
};

/** 对象详情页链接（有详情页的才返回） */
export function entityUrl(entity?: string | null, id?: number | null, no?: string | null): string | undefined {
  if (!entity) return undefined;
  const q = no ? encodeURIComponent(no) : '';
  switch (entity) {
    case 'erp_sales_order': return id ? `/sales/orders/${id}` : undefined;
    case 'erp_purchase_order': return id ? `/purchase/orders/${id}` : undefined;
    case 'mes_work_order': return id ? `/mes/work-orders/${id}` : undefined;
    case 'qms_inspection': return id ? `/quality/inspections/${id}` : undefined;
    case 'eng_bom': return id ? `/engineering/boms/${id}` : undefined;
    case 'eng_routing': return id ? `/engineering/routings/${id}` : undefined;
    case 'qms_ncr': return q ? `/quality/ncrs?q=${q}` : undefined;
    case 'qms_capa': return q ? `/quality/capas?q=${q}` : undefined;
    case 'wms_receipt': return q ? `/wms/receipts?q=${q}` : undefined;
    case 'wms_issue': return q ? `/wms/issues?q=${q}` : undefined;
    case 'wms_shipment': return q ? `/wms/shipments?q=${q}` : undefined;
    case 'wms_stock_count': return id ? `/wms/counts?id=${id}` : undefined;
    case 'mes_serial': return q ? `/trace?sn=${q}` : undefined;
    default: return undefined;
  }
}

/** 常见字段中文名（其余显示原字段名） */
export const FIELD_NAMES: Record<string, string> = {
  no: '单号', code: '编码', name: '名称', spec: '规格型号', status: '状态', qty: '数量', lot_no: '批号', remark: '备注',
  material_id: '物料ID', customer_id: '客户ID', supplier_id: '供应商ID', location_id: '库位ID', warehouse_id: '仓库ID',
  wo_id: '工单ID', so_id: '销售订单ID', po_id: '采购订单ID', unit_price: '单价', amount: '金额', total_amount: '总金额',
  shipped_qty: '已发数量', received_qty: '已收数量', completed_qty: '完工数量', scrap_qty: '报废数量', planned_qty: '计划数量',
  delivery_date: '交期', order_date: '订单日期', expected_date: '预计到货', due_date: '到期日', doc_date: '单据日期',
  expiry_date: '有效期至', mfg_date: '生产日期', supplier_lot: '原厂批号', counted_qty: '实盘数', system_qty: '账面数',
  dhr_status: 'DHR 状态', disposition: '处置', severity: '严重度', result: '结果', description: '描述', root_cause: '根本原因',
  is_active: '启用', roles: '角色', full_name: '姓名', department: '部门', email: '邮箱', safety_stock: '安全库存', std_cost: '标准成本',
  owner_customer_id: '货主客户ID', approved_by: '审批人', approved_at: '审批时间', released_by: '放行人', released_at: '放行时间',
  confirmed_by: '过账人', confirmed_at: '过账时间', posted_by: '过账人', posted_at: '过账时间', shipped_by: '发货人', ship_date: '发货日期',
  carrier: '承运商', tracking_no: '运单号', inspection_id: '检验单ID', version: '版本', created_by: '创建人', paid_amount: '已付金额',
  currency: '币别', serial_control: '序列号管理', lot_control: '批次管理', iqc_required: '来料检验', shelf_life_days: '保质期(天)',
};
