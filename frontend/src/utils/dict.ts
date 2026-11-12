/** 所有业务枚举的中文名称与颜色（Tag color）。新增状态只需在这里登记。 */
type Entry = [label: string, color?: string];
export const DICT: Record<string, Record<string, Entry>> = {
  so_status: {
    DRAFT: ['草稿', 'default'], CONFIRMED: ['已确认', 'blue'], IN_PRODUCTION: ['生产中', 'processing'],
    PARTIAL_SHIPPED: ['部分发货', 'gold'], SHIPPED: ['已发货', 'green'], CLOSED: ['已关闭', 'default'], CANCELLED: ['已取消', 'red'],
  },
  po_status: {
    DRAFT: ['草稿', 'default'], APPROVED: ['已审批', 'blue'], PARTIAL_RECEIVED: ['部分到货', 'gold'],
    RECEIVED: ['已到货', 'green'], CLOSED: ['已关闭', 'default'], CANCELLED: ['已取消', 'red'],
  },
  wo_status: {
    PLANNED: ['计划', 'default'], RELEASED: ['已下达', 'blue'], IN_PROGRESS: ['生产中', 'processing'],
    COMPLETED: ['已完工', 'cyan'], CLOSED: ['已关闭', 'green'], CANCELLED: ['已取消', 'red'],
  },
  dhr_status: { OPEN: ['待放行', 'gold'], RELEASED: ['已放行', 'green'], REJECTED: ['拒绝放行', 'red'] },
  doc_status: { DRAFT: ['待过账', 'gold'], CONFIRMED: ['已过账', 'green'], CANCELLED: ['已作废', 'default'], SHIPPED: ['已发货', 'green'], OPEN: ['进行中', 'gold'], POSTED: ['已过账', 'green'], REVERSED: ['已冲销', 'volcano'] },
  stock_status: { QUARANTINE: ['待检/待放行', 'gold'], AVAILABLE: ['合格', 'green'], REJECTED: ['不合格', 'red'], HOLD: ['冻结', 'purple'] },
  sn_status: {
    CREATED: ['待生产', 'default'], IN_PROCESS: ['在制', 'processing'], NG: ['不良待处置', 'red'], COMPLETED: ['完工待入库', 'cyan'],
    IN_STOCK: ['在库', 'blue'], SHIPPED: ['已发货', 'green'], SCRAPPED: ['已报废', 'default'],
    RETURNED: ['客户退回', 'magenta'],
  },
  result: { PASS: ['合格', 'green'], FAIL: ['不合格', 'red'] },
  insp_status: { PENDING: ['待检验', 'gold'], PASSED: ['合格', 'green'], REJECTED: ['不合格', 'red'], CONCESSION: ['让步接收', 'orange'] },
  insp_type: { IQC: ['来料检验'], IPQC: ['过程检验'], FQC: ['成品检验'], OQC: ['出货检验'] },
  ncr_status: { OPEN: ['待处置', 'red'], DISPOSITIONED: ['已处置', 'blue'], CLOSED: ['已关闭', 'green'] },
  ncr_source: { IQC: ['来料', 'purple'], PROCESS: ['制程', 'volcano'], FQC: ['成品', 'orange'], CUSTOMER: ['客诉', 'magenta'], OTHER: ['其他'] },
  severity: { MINOR: ['轻微', 'default'], MAJOR: ['严重', 'orange'], CRITICAL: ['致命', 'red'] },
  disposition: { REWORK: ['返工/返修', 'blue'], SCRAP: ['报废', 'red'], USE_AS_IS: ['让步接收', 'orange'], RETURN: ['退货', 'purple'] },
  capa_status: { OPEN: ['新建', 'default'], IN_PROGRESS: ['进行中', 'processing'], VERIFYING: ['有效性验证', 'gold'], CLOSED: ['已关闭', 'green'] },
  capa_source: { NCR: ['不合格品'], COMPLAINT: ['客户投诉'], AUDIT: ['审核发现'], OTHER: ['其他'] },
  eng_status: { DRAFT: ['草稿', 'gold'], SUBMITTED: ['待批准', 'blue'], APPROVED: ['已批准待生效', 'cyan'], RELEASED: ['已发布', 'green'], OBSOLETE: ['已作废', 'default'] },
  material_category: { RAW: ['原材料', 'blue'], SEMI: ['半成品', 'cyan'], FINISHED: ['成品', 'green'], PACKAGING: ['包材', 'purple'], CONSUMABLE: ['辅料/耗材', 'default'] },
  supplier_status: { QUALIFIED: ['合格供方', 'green'], PENDING: ['待评审', 'gold'], SUSPENDED: ['暂停', 'orange'], DISQUALIFIED: ['取消资格', 'red'] },
  equipment_status: { NORMAL: ['正常', 'green'], MAINTENANCE: ['维修保养', 'gold'], DISABLED: ['停用', 'red'] },
  equipment_type: { PRODUCTION: ['生产设备'], TEST: ['检测仪器'], AGING: ['老化设备'] },
  warehouse_type: { RAW: ['原材料仓'], FG: ['成品仓'], CUSTOMER: ['客供料仓'], REJECT: ['不合格品仓'], WIP: ['线边仓'] },
  location_type: { STORAGE: ['存储'], DRY_CABINET: ['防潮柜'], REJECT: ['不合格品区'], STAGING: ['暂存/线边'] },
  op_type: {
    SMT: ['SMT贴片', 'geekblue'], ASSEMBLY: ['组装', 'blue'], TEST_OPTICAL: ['光学测试', 'magenta'], AGING: ['老化', 'orange'],
    TEST_SAFETY: ['安规测试', 'red'], INSPECTION: ['检验', 'cyan'], PACKING: ['包装', 'green'], OTHER: ['其他'],
  },
  receipt_type: { PURCHASE: ['采购入库', 'blue'], CUSTOMER_SUPPLIED: ['客供料入库', 'purple'], PRODUCTION: ['完工入库', 'green'], OPENING: ['期初', 'default'], OTHER: ['其他入库'] },
  move_type: {
    PO_RECEIPT: ['采购入库', 'blue'], CS_RECEIPT: ['客供入库', 'purple'], OTHER_RECEIPT: ['其他入库'], OPENING: ['期初'],
    IQC_RELEASE: ['检验合格', 'green'], IQC_REJECT: ['检验不合格', 'red'], WO_ISSUE: ['生产领料', 'orange'], WO_RETURN: ['生产退料'],
    FG_RECEIPT: ['完工入库', 'cyan'], FG_RELEASE: ['产品放行', 'green'], SHIPMENT: ['销售出库', 'geekblue'], TRANSFER: ['调拨'],
    ADJUST: ['盘点调整', 'gold'], SCRAP: ['报废', 'red'], RETURN_SUPPLIER: ['退供应商', 'volcano'], STATUS_CHANGE: ['状态变更', 'purple'],
    CUSTOMER_RETURN: ['客户退货', 'magenta'], RETURN_TO_CUSTOMER: ['返还客户', 'magenta'],
    REWORK_ISSUE: ['返工补料', 'orange'],
    ISSUE_REVERSE: ['领料冲销', 'volcano'], RETURN_REVERSE: ['退料冲销', 'volcano'], SHIP_REVERSE: ['发货冲销', 'volcano'], ADJUST_REVERSE: ['盘点冲销', 'volcano'],
  },
  mrp_action: { PURCHASE: ['采购', 'blue'], PRODUCE: ['生产', 'green'], CUSTOMER_SUPPLY: ['通知客户供料', 'purple'] },
  mrp_status: { OPEN: ['待处理', 'gold'], CONVERTED: ['已转单', 'green'], IGNORED: ['已忽略', 'default'] },
  fin_type: { AR: ['应收', 'blue'], AP: ['应付', 'orange'], PR: ['预收款', 'purple'], PP: ['预付款', 'magenta'] },
  fin_status: { OPEN: ['未结', 'gold'], PARTIAL: ['部分结算', 'blue'], PAID: ['已结清', 'green'], VOID: ['已作废', 'default'] },
  audit_action: { CREATE: ['新增', 'green'], UPDATE: ['修改', 'blue'], DELETE: ['删除', 'red'], LOGIN: ['登录', 'cyan'], LOGIN_FAILED: ['登录失败', 'volcano'] },
  device_class: { I: ['I类'], II: ['II类'], III: ['III类'] },
  // 质量/仓储逆向（代理 4）
  issue_type: { ISSUE: ['领料', 'blue'], RETURN: ['退料', 'orange'] },
  rma_status: { RECEIVED: ['待处置', 'gold'], CLOSED: ['已关闭', 'green'] },
  complaint_status: { OPEN: ['已登记', 'gold'], INVESTIGATING: ['调查中', 'processing'], CLOSED: ['已结案', 'green'] },
  // 质量（G6）：退供应商单、检验项目类型
  supplier_return_status: { PENDING: ['待出库', 'gold'], SHIPPED: ['已出库', 'green'], CANCELLED: ['已取消', 'default'] },
  insp_item_type: { QUAL: ['定性'], QUANT: ['定量', 'blue'] },
  // 生产（代理 3）：放行批、关键件/返工换件、上岗资质
  release_status: { RELEASED: ['已放行', 'green'], REJECTED: ['拒绝放行', 'red'] },
  key_part_action: { BIND: ['装配绑定', 'blue'], REMOVE: ['返工拆下', 'volcano'], INSTALL: ['返工装上', 'green'] },
  qual_level: { TRAINEE: ['培训中', 'gold'], QUALIFIED: ['合格上岗', 'green'], TRAINER: ['带教/培训师', 'purple'] },
};

export function dictLabel(dict: string, value?: string | null): string {
  if (value === null || value === undefined || value === '') return '-';
  return DICT[dict]?.[value]?.[0] ?? value;
}

export function dictOptions(dict: string) {
  return Object.entries(DICT[dict] || {}).map(([value, [label]]) => ({ value, label }));
}
