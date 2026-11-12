/**
 * 数据导入规格（金蝶 K/3 Cloud / 星空 常见导出列名兼容）：
 *   fields：字段 → 可识别的表头别名（第一个别名即模板表头）
 *   meta：  字段 → 是否必填、填写说明、可选值（模板“填写说明”页与下拉、报错提示共用）
 *   perms： 可导入该数据的权限点（任一）；系统管理员在“上线迁移模式”下可导入全部业务数据
 */

export const YES = new Set(['是', 'Y', 'y', 'yes', 'true', '1', 'TRUE', '启用', '√']);
export const NO = new Set(['否', 'N', 'n', 'no', 'false', '0', 'FALSE', '停用', '×', '']);

/** 物料类别（仅用于物料导入） */
export const CATEGORY: Record<string, string> = {
  原材料: 'RAW', 原料: 'RAW', 外购: 'RAW', 半成品: 'SEMI', 委外: 'SEMI', 成品: 'FINISHED',
  产成品: 'FINISHED', 自制: 'FINISHED', 包材: 'PACKAGING', 包装材料: 'PACKAGING', 辅料: 'CONSUMABLE',
  耗材: 'CONSUMABLE', RAW: 'RAW', SEMI: 'SEMI', FINISHED: 'FINISHED', PACKAGING: 'PACKAGING', CONSUMABLE: 'CONSUMABLE',
};
/** 物料类别的标准写法（模板下拉、报错提示） */
export const CATEGORY_CHOICES = ['原材料', '半成品', '成品', '包材', '辅料'];

export const SUP_STATUS: Record<string, string> = {
  合格: 'QUALIFIED', 合格供方: 'QUALIFIED', 待评: 'PENDING', 待评审: 'PENDING', 暂停: 'SUSPENDED', 取消: 'DISQUALIFIED', 不合格: 'DISQUALIFIED',
  QUALIFIED: 'QUALIFIED', PENDING: 'PENDING', SUSPENDED: 'SUSPENDED', DISQUALIFIED: 'DISQUALIFIED',
};
export const SUP_STATUS_CHOICES = ['合格', '待评', '暂停', '取消'];
export const YES_NO = ['是', '否'];
export const CURRENCY_CHOICES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW', 'HKD', 'GBP'];
export const AUTH_SOURCE: Record<string, 'LOCAL' | 'KINGDEE'> = { 本系统: 'LOCAL', 本系统账号: 'LOCAL', LOCAL: 'LOCAL', 金蝶: 'KINGDEE', 金蝶云星空: 'KINGDEE', 金蝶账号: 'KINGDEE', KINGDEE: 'KINGDEE' };

/** 动态可选值（模板生成时从数据库读取）：库位编码、供应商编码、角色、部门 */
export type DynamicOptions = 'locations' | 'suppliers' | 'roles' | 'departments';

export interface FieldMeta {
  required?: boolean;
  note?: string;
  /** 可选值：固定列表或动态来源 */
  options?: string[] | DynamicOptions;
  /** 下拉是否只允许可选值（false = 仅提示，可填其他值，如多个角色用逗号分隔） */
  strict?: boolean;
  /** 单元格按文本格式（PIN、工牌号等以 0 开头的编码） */
  text?: boolean;
  example?: string | number;
}

export interface ImportSpec {
  title: string;
  /** 可导入的权限点（任一） */
  perms: string[];
  /** 页面与模板上的一句话说明 */
  desc: string;
  fields: Record<string, string[]>;
  meta: Record<string, FieldMeta>;
}

export const SPECS: Record<string, ImportSpec> = {
  suppliers: {
    title: '供应商',
    perms: ['master'],
    desc: '按“供应商编码”有则更新、无则新增，可重复导入。',
    fields: {
      code: ['供应商编码', '编码', 'FNumber'], name: ['供应商名称', '名称', 'FName'], short_name: ['简称'],
      category: ['供应类别', '类别'], contact: ['联系人'], phone: ['电话', '联系电话'],
      address: ['地址', '通讯地址'], status: ['状态', '合格状态'], remark: ['备注'],
    },
    meta: {
      code: { required: true, note: '唯一编码，已存在则更新该供应商', example: 'S100' },
      name: { required: true, example: '示例电子有限公司' },
      short_name: { example: '示例电子' },
      category: { note: '自由填写，如 LED芯片、PCB、包材', example: 'LED芯片' },
      contact: { example: '李工' }, phone: { text: true, example: '13900000000' }, address: { example: '深圳市' },
      status: { note: '合格供方才能下采购单；留空 = 待评', options: SUP_STATUS_CHOICES, strict: true, example: '合格' },
    },
  },
  customers: {
    title: '客户',
    perms: ['master'],
    desc: '按“客户编码”有则更新、无则新增，可重复导入。代工客户可填写注册人（医疗器械注册证持有人）。',
    fields: {
      code: ['客户编码', '编码', 'FNumber'], name: ['客户名称', '名称', 'FName'], short_name: ['简称'],
      country: ['国家', '国家/地区'], contact: ['联系人'], phone: ['电话', '联系电话'],
      address: ['地址', '通讯地址'], tax_no: ['税号', '纳税登记号'], currency: ['币别', '结算币别'],
      mah_name: ['注册人', '注册人名称'], remark: ['备注'],
    },
    meta: {
      code: { required: true, note: '唯一编码，已存在则更新该客户', example: 'C100' },
      name: { required: true, example: '示例品牌医疗科技有限公司' },
      short_name: { example: '示例品牌' }, country: { example: '中国' }, contact: { example: '张经理' },
      phone: { text: true, example: '13800000000' }, address: { example: '上海市' }, tax_no: { text: true, example: '91310000XXXX' },
      currency: { note: '结算币别代码，留空 = 人民币', options: CURRENCY_CHOICES, strict: false, example: 'CNY' },
      mah_name: { note: '医疗器械注册人/备案人（代工客户）', example: '示例品牌医疗科技有限公司' },
    },
  },
  materials: {
    title: '物料',
    perms: ['master'],
    desc: '按“物料编码”有则更新、无则新增，可重复导入。“默认供应商”需先导入供应商。',
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
    meta: {
      code: { required: true, note: '唯一编码，已存在则更新该物料', example: 'LED-630-2835' },
      name: { required: true, example: '红光LED 630nm' },
      spec: { example: '2835 0.2W 630±5nm' },
      category: { note: '金蝶“物料属性”：外购→原材料、委外→半成品、自制→成品 也可识别；留空 = 原材料', options: CATEGORY_CHOICES, strict: true, example: '原材料' },
      uom: { note: '如 PCS、台、米；留空 = PCS', example: 'PCS' },
      safety_stock: { note: '数字', example: 1000 }, lead_time_days: { note: '天数', example: 15 }, std_cost: { note: '元', example: 0.3 },
      shelf_life_days: { note: '天数；有保质期的物料入库时按生产日期自动算有效期', example: 365 },
      lot_control: { options: YES_NO, strict: true, example: '是' }, serial_control: { note: '只有成品/半成品可以启用', options: YES_NO, strict: true, example: '否' },
      default_supplier: { note: '填供应商编码或名称（须已存在）', options: 'suppliers', strict: false, example: 'S001' },
      iqc_required: { note: '来料是否需要 IQC 检验；留空 = 是', options: YES_NO, strict: true, example: '是' },
      wavelength_nm: { example: '630' }, msl_level: { note: '湿敏等级 1–6，MSL 物料须存放在防潮柜', example: '3' },
    },
  },
  boms: {
    title: 'BOM',
    perms: ['engineering'],
    desc: '每行一个子项，按“父项编码 + 版本”分组生成草稿 BOM（需工程提交、QA 批准后生效）；已存在的同版本 BOM 不覆盖。',
    fields: {
      parent: ['父项物料编码', '父项编码', '产品编码'], version: ['BOM版本', '版本'],
      component: ['子项物料编码', '子项编码', '组件编码'], qty: ['用量', '子项用量', '用量:分子', '分子'],
      denominator: ['用量:分母', '分母'], scrap_rate: ['损耗率', '损耗率(%)'], designator: ['位号'],
    },
    meta: {
      parent: { required: true, note: '须已在物料中存在', example: 'FG-RL300' },
      version: { note: '留空 = A0', example: 'A2' },
      component: { required: true, note: '须已在物料中存在', example: 'LED-660-3030' },
      qty: { required: true, note: '每个父项的用量（金蝶 分子/分母 写法也可）', example: 60 },
      denominator: { note: '留空 = 1', example: 1 },
      scrap_rate: { note: '填 2 或 2% 或 0.02 都表示 2%', example: 1 },
      designator: { example: 'D1-D60' },
    },
  },
  stock: {
    title: '期初库存',
    perms: ['wms'],
    desc: '系统上线时的现有库存，按批号记账，直接记为“合格”。同一物料 + 库位 + 批号已有库存时默认报错（防止重复导入翻倍），可选“覆盖为导入数”。',
    fields: {
      material: ['物料编码', '编码'], location: ['库位编码', '仓位', '库位'], lot_no: ['批号'],
      qty: ['数量', '库存数量', '期初数量'], mfg_date: ['生产日期'], expiry_date: ['有效期至', '到期日'],
    },
    meta: {
      material: { required: true, note: '须已在物料中存在；客供料按物料主数据的货主自动入账', example: 'LED-660-3030' },
      location: { required: true, note: '须已在“基础资料 → 库位”中建好', options: 'locations', strict: true, example: 'DRY-01' },
      lot_no: { note: '启用批号管理的物料留空时自动生成批号', text: true, example: 'L20260901' },
      qty: { required: true, note: '大于 0', example: 5000 },
      mfg_date: { note: '日期，如 2026-09-01', example: '2026-09-01' },
      expiry_date: { note: '留空时按生产日期 + 保质期自动计算', example: '2027-09-01' },
    },
  },
  users: {
    title: '用户账号',
    perms: ['admin'],
    desc: '批量开户：初始密码留空则自动生成，导入后下载“初始密码分发清单”，员工首次登录须修改密码。有工牌号未填 PIN 时自动生成 4 位 PIN。',
    fields: {
      username: ['登录账号', '账号', '用户名'], full_name: ['姓名'], roles: ['角色'], department: ['部门'],
      badge_no: ['工牌号'], pin: ['工位PIN', 'PIN', '工位 PIN'], email: ['邮箱'], password: ['初始密码'], auth_source: ['登录方式'],
    },
    meta: {
      username: { required: true, note: '字母、数字、下划线、点、横线或中文，不能与已有账号重复', example: 'zhangsan' },
      full_name: { required: true, note: '电子签名时显示的姓名', example: '张三' },
      roles: { required: true, note: '多个角色用逗号分隔，中文名或代码均可，如“仓管员,质检员”', options: 'roles', strict: false, example: '仓管员' },
      department: { options: 'departments', strict: false, example: '仓储部' },
      badge_no: { note: '工位刷工牌登录用（须有车间报工权限的角色）', text: true, example: 'E1003' },
      pin: { note: '4–8 位数字；有工牌号但留空时自动生成', text: true, example: '' },
      email: { example: '' },
      password: { note: `留空自动生成（推荐）；自填须符合密码策略。无论哪种，首次登录都须本人修改`, text: true, example: '' },
      auth_source: { note: '留空 = 本系统账号；金蝶账号用金蝶密码登录（须启用金蝶集成）', options: ['本系统', '金蝶'], strict: true, example: '本系统' },
    },
  },
};

/** 导入顺序（页面步骤） */
export const ENTITY_ORDER = ['suppliers', 'customers', 'materials', 'boms', 'stock', 'users'];

export const getSpec = (entity: string): ImportSpec | undefined => (Object.hasOwn(SPECS, entity) ? SPECS[entity] : undefined);
