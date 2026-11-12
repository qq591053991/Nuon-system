/** 数据表 → 中文对象名（审计追踪、电子签名共用；后端也返回 entity_name，此表用于下拉与兜底） */
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
  md_exchange_rate: '汇率',
  eng_bom: 'BOM',
  eng_bom_line: 'BOM 明细',
  eng_routing: '工艺路线',
  eng_routing_op: '工艺工序',
  eng_routing_param: '工序参数（测试规格）',
  mes_work_order: '生产工单',
  mes_wo_material: '工单用料',
  mes_wo_operation: '工单工序',
  mes_serial: '序列号',
  mes_op_record: '过站记录',
  mes_test_value: '测试数据',
  mes_key_part: '关键件绑定',
  mes_product_release: '产品放行批',
  hr_qualification: '人员上岗资质',
  qms_inspection: '检验单',
  qms_inspection_item: '检验项目',
  qms_ncr: 'NCR 不合格品',
  qms_capa: 'CAPA',
  qms_complaint: '客户投诉',
  qms_material_inspection_item: '物料检验规范',
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
  wms_customer_return: '客户退货',
  wms_customer_return_line: '客户退货明细',
  wms_supplier_return: '退供应商单',
  sys_user: '用户',
  sys_login: '登录',
  sys_attachment: '附件',
  sys_setting: '系统设置',
};

export const entityName = (e?: string | null) => (e ? ENTITY_NAMES[e] || e : '-');

/** 下拉选项：只显示中文名（按中文名搜索），表名放在 title 里 */
export const ENTITY_OPTIONS = Object.entries(ENTITY_NAMES).map(([value, label]) => ({ value, label, title: value }));

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

/** 对象详情页链接（后端已返回 doc_url 时优先用后端的；这里是兜底） */
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
    case 'qms_ncr': return id ? `/quality/ncrs?id=${id}` : q ? `/quality/ncrs?q=${q}` : undefined;
    case 'qms_capa': return q ? `/quality/capas?q=${q}` : undefined;
    case 'qms_complaint': return q ? `/quality/complaints?q=${q}` : undefined;
    case 'wms_receipt': return q ? `/wms/receipts?q=${q}` : undefined;
    case 'wms_issue': return id ? `/wms/issues?id=${id}` : undefined;
    case 'wms_shipment': return q ? `/wms/shipments?q=${q}` : undefined;
    case 'wms_stock_count': return id ? `/wms/counts?id=${id}` : undefined;
    case 'wms_customer_return': return q ? `/wms/customer-returns?q=${q}` : undefined;
    case 'mes_serial': return q ? `/trace?sn=${q}` : undefined;
    default: return undefined;
  }
}

/** 审计/签名记录的跳转地址：优先后端计算的 doc_url */
export const rowUrl = (r: { entity?: string; entity_id?: number | null; doc_no?: string | null; doc_url?: string | null }) =>
  r.doc_url || entityUrl(r.entity, r.entity_id ?? null, r.doc_no ?? null);

/** “变更记录”入口：详情页可链接到审计追踪并带好筛选，如 changeLogUrl('eng_bom', bom.id) */
export const changeLogUrl = (entity: string, id?: number | null, doc?: string | null) => {
  const p = new URLSearchParams({ entity });
  if (id) p.set('entity_id', String(id));
  if (doc) p.set('doc', doc);
  return `/system/audit?${p.toString()}`;
};

/** 常见字段中文名（其余显示原字段名） */
export const FIELD_NAMES: Record<string, string> = {
  no: '单号', code: '编码', name: '名称', spec: '规格型号', status: '状态', qty: '数量', lot_no: '批号', remark: '备注',
  material_id: '物料', customer_id: '客户', supplier_id: '供应商', location_id: '库位', warehouse_id: '仓库', component_id: '子项物料',
  wo_id: '工单', so_id: '销售订单', po_id: '采购订单', order_id: '所属订单', bom_id: '所属 BOM', routing_id: '所属工艺路线', receipt_id: '所属入库单',
  issue_id: '所属领料单', shipment_id: '所属发货单', count_id: '所属盘点单', operation_id: '所属工序', user_id: '人员', equipment_id: '设备',
  work_center_id: '工作中心', key_part_material_id: '关键件物料', default_supplier_id: '默认供应商', default_location_id: '默认库位',
  from_location_id: '源库位', to_location_id: '目标库位', ncr_id: 'NCR', capa_id: 'CAPA', release_id: '放行批', sn_id: '序列号',
  unit_price: '单价', amount: '金额', total_amount: '总金额',
  shipped_qty: '已发数量', received_qty: '已收数量', completed_qty: '完工数量', scrap_qty: '报废数量', planned_qty: '计划数量',
  delivery_date: '交期', order_date: '订单日期', expected_date: '预计到货', promised_date: '供应商回复交期', due_date: '到期日', doc_date: '单据日期',
  expiry_date: '有效期至', mfg_date: '生产日期', supplier_lot: '原厂批号', counted_qty: '实盘数', system_qty: '账面数',
  dhr_status: 'DHR 状态', disposition: '处置', severity: '严重度', result: '结果', description: '描述', root_cause: '根本原因',
  is_active: '启用', roles: '角色', full_name: '姓名', department: '部门', email: '邮箱', safety_stock: '安全库存', std_cost: '标准成本',
  owner_customer_id: '货主客户', approved_by: '审批人', approved_at: '审批时间', released_by: '放行人', released_at: '放行时间',
  confirmed_by: '过账人', confirmed_at: '过账时间', posted_by: '过账人', posted_at: '过账时间', shipped_by: '发货人', ship_date: '发货日期',
  carrier: '承运商', tracking_no: '运单号', inspection_id: '检验单', version: '版本', created_by: '创建人', paid_amount: '已付金额',
  currency: '币别', serial_control: '序列号管理', lot_control: '批次管理', iqc_required: '来料检验', shelf_life_days: '保质期(天)',
  // BOM / 工艺
  line_no: '行号', qty_per: '用量', scrap_rate: '损耗率', designator: '位号', ecn_no: 'ECN 编号', effective_date: '生效日期', change_reason: '变更原因',
  submitted_by: '提交人', submitted_at: '提交时间', seq: '工序号', op_type: '工序类型', requires_equipment: '需设备', sop_no: '作业指导书',
  std_minutes: '标准工时(分)', unit: '单位', lower: '下限', upper: '上限', target: '目标值', decimals: '小数位', min_valid: '合理下限', max_valid: '合理上限',
  param_type: '测试项类型',
  // 用户与登录
  username: '账号', badge_no: '工牌号', pin: '工位 PIN', auth_source: '登录方式', must_change_password: '下次登录须改密', password_changed_at: '密码修改时间',
  failed_login_count: '连续失败次数', locked_until: '锁定至', last_login_at: '最近登录', reason: '原因', source: '登录方式', locked: '已锁定',
  import_migration_mode: '上线迁移模式', external_id: '金蝶用户ID',
};

/** 审计中的 ID 字段（后端在 refs 中给出“编码 名称”） */
export const isRefField = (f: string) => f.endsWith('_id');
