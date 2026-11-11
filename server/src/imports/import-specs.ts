/** 数据导入规格（金蝶 K/3 Cloud / 星空 常见导出列名兼容）：字段 → 可识别的表头别名（第一个别名即模板表头） */

export const YES = new Set(['是', 'Y', 'y', 'yes', 'true', '1', 'TRUE', '启用', '√']);

/** 物料类别（仅用于物料导入） */
export const CATEGORY: Record<string, string> = {
  原材料: 'RAW', 原料: 'RAW', 外购: 'RAW', 半成品: 'SEMI', 委外: 'SEMI', 成品: 'FINISHED',
  产成品: 'FINISHED', 自制: 'FINISHED', 包材: 'PACKAGING', 包装材料: 'PACKAGING', 辅料: 'CONSUMABLE',
  耗材: 'CONSUMABLE', RAW: 'RAW', SEMI: 'SEMI', FINISHED: 'FINISHED', PACKAGING: 'PACKAGING', CONSUMABLE: 'CONSUMABLE',
};

export const SUP_STATUS: Record<string, string> = {
  合格: 'QUALIFIED', 合格供方: 'QUALIFIED', 待评: 'PENDING', 暂停: 'SUSPENDED', 取消: 'DISQUALIFIED', QUALIFIED: 'QUALIFIED', PENDING: 'PENDING',
};

export interface ImportSpec {
  title: string;
  fields: Record<string, string[]>;
  example: (string | number)[];
}

export const SPECS: Record<string, ImportSpec> = {
  materials: {
    title: '物料',
    fields: {
      code: ['物料编码', '编码', '代码', 'FNumber'], name: ['物料名称', '名称', 'FName'],
      spec: ['规格型号', '规格'], category: ['物料类别', '物料属性', '类别'],
      uom: ['基本单位', '单位', '计量单位'], safety_stock: ['安全库存'],
      lead_time_days: ['采购提前期', '固定提前期', '提前期'], std_cost: ['标准成本', '参考成本', '单价'],
      shelf_life_days: ['保质期(天)', '保质期'], lot_control: ['启用批号管理', '批号管理'],
      serial_control: ['启用序列号管理', '序列号管理'], default_supplier: ['默认供应商'],
      iqc_required: ['来料检验', '需检验'], wavelength_nm: ['波长(nm)', '波长'], msl_level: ['湿敏等级', 'MSL'],
      remark: ['备注'],
    },
    example: ['LED-660-3030', '红光LED 660nm', '3030 0.5W 660±5nm', '原材料', 'PCS', 2000, 15, 0.35, 365, '是', '否', 'SUP001', '是', '660', '3', ''],
  },
  customers: {
    title: '客户',
    fields: {
      code: ['客户编码', '编码', 'FNumber'], name: ['客户名称', '名称', 'FName'], short_name: ['简称'],
      country: ['国家', '国家/地区'], contact: ['联系人'], phone: ['电话', '联系电话'],
      address: ['地址', '通讯地址'], tax_no: ['税号', '纳税登记号'], currency: ['币别', '结算币别'],
      mah_name: ['注册人', '注册人名称'], remark: ['备注'],
    },
    example: ['C100', '示例品牌医疗科技有限公司', '示例品牌', '中国', '张经理', '13800000000', '上海市', '91310000XXXX', 'CNY', '示例品牌医疗科技有限公司', ''],
  },
  suppliers: {
    title: '供应商',
    fields: {
      code: ['供应商编码', '编码', 'FNumber'], name: ['供应商名称', '名称', 'FName'], short_name: ['简称'],
      category: ['供应类别', '类别'], contact: ['联系人'], phone: ['电话', '联系电话'],
      address: ['地址', '通讯地址'], status: ['状态', '合格状态'], remark: ['备注'],
    },
    example: ['S100', '示例电子有限公司', '示例电子', 'LED芯片', '李工', '13900000000', '深圳市', '合格', ''],
  },
  boms: {
    title: 'BOM',
    fields: {
      parent: ['父项物料编码', '父项编码', '产品编码'], version: ['BOM版本', '版本'],
      component: ['子项物料编码', '子项编码', '组件编码'], qty: ['用量', '子项用量', '用量:分子', '分子'],
      denominator: ['用量:分母', '分母'], scrap_rate: ['损耗率', '损耗率(%)'], designator: ['位号'],
    },
    example: ['FG-RL300', 'A0', 'LED-660-3030', 60, 1, 1, 'D1-D60'],
  },
  stock: {
    title: '期初库存',
    fields: {
      material: ['物料编码', '编码'], location: ['库位编码', '仓位', '库位'], lot_no: ['批号'],
      qty: ['数量', '库存数量', '期初数量'], mfg_date: ['生产日期'], expiry_date: ['有效期至', '到期日'],
    },
    example: ['LED-660-3030', 'RAW-A01', 'L20260901', 5000, '2026-09-01', '2027-09-01'],
  },
};

export const getSpec = (entity: string): ImportSpec | undefined => (Object.hasOwn(SPECS, entity) ? SPECS[entity] : undefined);
