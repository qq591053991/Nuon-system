import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import {
  AppstoreOutlined, DashboardOutlined, DatabaseOutlined, ExperimentOutlined,
  NodeIndexOutlined, SettingOutlined, ShoppingCartOutlined, ShoppingOutlined, ToolOutlined, AccountBookOutlined,
  ApartmentOutlined, ScanOutlined,
} from '@ant-design/icons';

type Page = LazyExoticComponent<ComponentType<any>>;
const named = (loader: () => Promise<any>, name: string): Page => lazy(() => loader().then((m) => ({ default: m[name] })));
const M = () => import('./pages/master/MasterPages');

export interface RouteDef { path: string; element: Page }

/**
 * 页面级读权限（与后端 READ_PERMS / 各 GET 接口的 @Perms 一致）：没有权限的人直接输入网址时显示“无权访问”，
 * 而不是打开页面后接口报 403。键为路径前缀，按最长前缀匹配；未列出的页面不限制（由接口自行控制）。
 */
export const ROUTE_PERMS: [string, string[], string][] = [
  ['/finance', ['finance'], '财务'],
  ['/system/audit', ['audit', 'admin'], '审计查阅'],
  ['/system/esign', ['audit', 'admin'], '审计查阅'],
  ['/system/users', ['admin'], '系统管理'],
  ['/sales/orders', ['sales', 'plan', 'wms', 'finance', 'qa'], '销售订单查阅'],
  ['/purchase/orders', ['purchase', 'plan', 'wms', 'qc', 'qa', 'finance'], '采购订单查阅'],
  ['/purchase/chase', ['purchase', 'plan', 'wms', 'qc', 'qa', 'finance'], '采购订单查阅'],
  ['/purchase/materials', ['purchase', 'master', 'plan'], '采购/主数据'],
];

/** 当前路径需要的权限（无限制时返回 null） */
export function routePerm(pathname: string): { perms: string[]; label: string } | null {
  const hit = ROUTE_PERMS.filter(([p]) => pathname === p || pathname.startsWith(p + '/')).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? { perms: hit[1], label: hit[2] } : null;
}
/**
 * 菜单（G1 负责结构与权限）：perm = 需要任一权限点才显示；分组上的 perm 作为子项默认值；子项全部隐藏时分组也隐藏。
 * 口径与后端读权限矩阵一致（见 backend/src/auth/roles.ts READ_PERMS）：财务只给 finance，审计只给 audit/admin，
 * 价格/金额类页面不给车间操作员；同时按岗位去掉与日常工作无关的入口（菜单 ⊆ 可读）。
 */
export interface MenuDef { key: string; label: string; icon?: ReactNode; perm?: string[]; children?: MenuDef[] }

export const routes: RouteDef[] = [
  { path: '/', element: lazy(() => import('./pages/Dashboard')) },
  // ERP
  { path: '/sales/orders', element: lazy(() => import('./pages/erp/SalesOrders')) },
  { path: '/sales/orders/:id', element: lazy(() => import('./pages/erp/SalesOrderDetail')) },
  { path: '/purchase/orders', element: lazy(() => import('./pages/erp/PurchaseOrders')) },
  { path: '/purchase/orders/:id', element: lazy(() => import('./pages/erp/PurchaseOrderDetail')) },
  { path: '/purchase/chase', element: lazy(() => import('./pages/erp/PurchaseChase')) },
  { path: '/purchase/materials', element: lazy(() => import('./pages/erp/PurchaseMaterials')) },
  { path: '/plan/mrp', element: lazy(() => import('./pages/erp/Mrp')) },
  { path: '/finance', element: lazy(() => import('./pages/erp/Finance')) },
  { path: '/engineering/boms', element: lazy(() => import('./pages/erp/Boms')) },
  { path: '/engineering/boms/:id', element: lazy(() => import('./pages/erp/BomDetail')) },
  { path: '/engineering/routings', element: lazy(() => import('./pages/erp/Routings')) },
  { path: '/engineering/routings/:id', element: lazy(() => import('./pages/erp/RoutingDetail')) },
  // MES
  { path: '/mes/work-orders', element: lazy(() => import('./pages/mes/WorkOrders')) },
  { path: '/mes/work-orders/:id', element: lazy(() => import('./pages/mes/WorkOrderDetail')) },
  { path: '/mes/station', element: lazy(() => import('./pages/mes/Station')) },
  // QMS
  { path: '/quality/inspections', element: lazy(() => import('./pages/quality/Inspections')) },
  { path: '/quality/inspections/:id', element: lazy(() => import('./pages/quality/InspectionDetail')) },
  { path: '/quality/ncrs', element: lazy(() => import('./pages/quality/Ncrs')) },
  { path: '/quality/capas', element: lazy(() => import('./pages/quality/Capas')) },
  { path: '/quality/release', element: lazy(() => import('./pages/quality/ReleaseCenter')) },
  { path: '/quality/dhr/:id', element: lazy(() => import('./pages/quality/DhrView')) },
  { path: '/quality/inspection-specs', element: lazy(() => import('./pages/quality/InspectionSpecs')) },
  { path: '/quality/complaints', element: lazy(() => import('./pages/quality/Complaints')) },
  { path: '/quality/supplier-returns', element: lazy(() => import('./pages/quality/SupplierReturns')) },
  { path: '/quality/qualifications', element: lazy(() => import('./pages/system/Qualifications')) },
  // WMS
  { path: '/wms/stock', element: lazy(() => import('./pages/wms/Stock')) },
  { path: '/wms/moves', element: lazy(() => import('./pages/wms/StockMoves')) },
  { path: '/wms/receipts', element: lazy(() => import('./pages/wms/Receipts')) },
  { path: '/wms/issues', element: lazy(() => import('./pages/wms/Issues')) },
  { path: '/wms/shipments', element: lazy(() => import('./pages/wms/Shipments')) },
  { path: '/wms/counts', element: lazy(() => import('./pages/wms/StockCounts')) },
  { path: '/wms/customer-returns', element: lazy(() => import('./pages/wms/CustomerReturns')) },
  // WMS · 待上架与 PDA 作业页（G7）
  { path: '/wms/putaway', element: lazy(() => import('./pages/wms/Putaway')) },
  { path: '/wms/pda', element: lazy(() => import('./pages/wms/pda/PdaHome')) },
  { path: '/wms/pda/receive', element: lazy(() => import('./pages/wms/pda/PdaReceive')) },
  { path: '/wms/pda/putaway', element: lazy(() => import('./pages/wms/pda/PdaPutaway')) },
  { path: '/wms/pda/count', element: named(() => import('./pages/wms/pda/PdaCount'), 'PdaCountList') },
  { path: '/wms/pda/count/:id', element: lazy(() => import('./pages/wms/pda/PdaCount')) },
  { path: '/wms/pda/pick', element: named(() => import('./pages/wms/pda/PdaPick'), 'PdaPickList') },
  { path: '/wms/pda/pick/:id', element: lazy(() => import('./pages/wms/pda/PdaPick')) },
  { path: '/wms/pda/fg', element: lazy(() => import('./pages/wms/pda/PdaFgReceipt')) },
  { path: '/wms/print/:kind', element: lazy(() => import('./pages/wms/PrintDoc')) },
  { path: '/wms/print/:kind/:id', element: lazy(() => import('./pages/wms/PrintDoc')) },
  // 追溯
  { path: '/trace', element: lazy(() => import('./pages/Trace')) },
  // 主数据
  { path: '/master/customers', element: named(M, 'Customers') },
  { path: '/master/suppliers', element: named(M, 'Suppliers') },
  { path: '/master/materials', element: named(M, 'Materials') },
  { path: '/master/work-centers', element: named(M, 'WorkCenters') },
  { path: '/master/equipment', element: named(M, 'EquipmentPage') },
  { path: '/master/warehouses', element: named(M, 'Warehouses') },
  { path: '/master/locations', element: named(M, 'Locations') },
  { path: '/master/exchange-rates', element: lazy(() => import('./pages/master/ExchangeRates')) },
  // 系统
  { path: '/system/users', element: lazy(() => import('./pages/system/Users')) },
  { path: '/system/audit', element: lazy(() => import('./pages/system/AuditLogs')) },
  { path: '/system/esign', element: lazy(() => import('./pages/system/ESignatures')) },
  { path: '/system/import', element: lazy(() => import('./pages/system/DataImport')) },
  { path: '/system/settings', element: lazy(() => import('./pages/system/Settings')) },
  { path: '/system/qualifications', element: lazy(() => import('./pages/system/Qualifications')) },
];

export const menu: MenuDef[] = [
  { key: '/', label: '工作台', icon: <DashboardOutlined /> },
  { key: '/mes/station', label: '工位终端', icon: <ScanOutlined />, perm: ['mes'] },
  {
    key: 'sales', label: '销售与计划', icon: <ShoppingOutlined />, children: [
      { key: '/sales/orders', label: '销售订单', perm: ['sales', 'plan', 'finance'] },
      { key: '/plan/mrp', label: 'MRP 物料需求', perm: ['plan', 'purchase'] },
    ],
  },
  { key: 'purchase', label: '采购', icon: <ShoppingCartOutlined />, perm: ['purchase', 'plan', 'finance'], children: [
      { key: '/purchase/orders', label: '采购订单' },
      { key: '/purchase/chase', label: '催货清单', perm: ['purchase', 'plan', 'wms'] },
      { key: '/purchase/materials', label: '物料采购属性', perm: ['purchase', 'master', 'plan'] },
    ] },
  {
    key: 'mes', label: '生产执行 MES', icon: <ToolOutlined />, perm: ['plan', 'mes', 'wms', 'qa', 'qc', 'engineering'], children: [
      { key: '/mes/work-orders', label: '生产工单' },
    ],
  },
  {
    key: 'quality', label: '质量管理 QMS', icon: <ExperimentOutlined />, children: [
      { key: '/quality/inspections', label: '来料检验 IQC', perm: ['qc', 'qa'] },
      { key: '/quality/ncrs', label: '不合格品 NCR', perm: ['qc', 'qa'] },
      { key: '/quality/capas', label: '纠正预防 CAPA', perm: ['qa'] },
      { key: '/quality/release', label: 'DHR 审核与放行', perm: ['qa'] },
      { key: '/quality/inspection-specs', label: '检验规范', perm: ['qa', 'qc'] },
      { key: '/quality/complaints', label: '客户投诉/不良事件', perm: ['qa', 'sales'] },
      { key: '/quality/supplier-returns', label: '退供应商', perm: ['qa', 'qc', 'wms', 'purchase'] },
      { key: '/quality/qualifications', label: '人员上岗资质', perm: ['qa', 'qc'] },
    ],
  },
  {
    key: 'wms', label: '仓储管理 WMS', icon: <DatabaseOutlined />, children: [
      { key: '/wms/pda', label: 'PDA 作业', perm: ['wms'] },
      { key: '/wms/stock', label: '库存查询', perm: ['wms', 'plan', 'purchase', 'sales', 'qa', 'qc'] },
      { key: '/wms/putaway', label: '待上架', perm: ['wms'] },
      { key: '/wms/receipts', label: '收货入库', perm: ['wms'] },
      { key: '/wms/issues', label: '生产领料', perm: ['wms', 'plan'] },
      { key: '/wms/shipments', label: '发货出库', perm: ['wms', 'sales'] },
      { key: '/wms/counts', label: '库存盘点', perm: ['wms'] },
      { key: '/wms/customer-returns', label: '客户退货', perm: ['wms', 'qa', 'sales'] },
      { key: '/wms/moves', label: '库存流水', perm: ['wms', 'finance'] },
    ],
  },
  { key: '/trace', label: '质量追溯', icon: <NodeIndexOutlined />, perm: ['qa', 'qc', 'wms', 'sales', 'plan', 'engineering'] },
  {
    key: 'finance', label: '应收应付', icon: <AccountBookOutlined />, perm: ['finance'], children: [
      { key: '/finance?tab=AR', label: '应收账款' },
      { key: '/finance?tab=AP', label: '应付账款' },
      { key: '/finance?tab=PAY', label: '收付款流水' },
      { key: '/finance?tab=AGING', label: '账龄分析' },
      { key: '/finance?tab=EXPORT', label: '月结导出（金蝶）' },
      { key: '/master/exchange-rates?view=finance', label: '汇率' },
    ],
  },
  {
    key: 'engineering', label: '工程数据', icon: <ApartmentOutlined />, children: [
      { key: '/engineering/boms', label: 'BOM 物料清单', perm: ['engineering', 'qa', 'plan'] },
      { key: '/engineering/routings', label: '工艺路线与测试规格', perm: ['engineering', 'qa'] },
      { key: '/quality/inspection-specs?from=engineering', label: '来料检验规范', perm: ['engineering'] },
    ],
  },
  {
    key: 'master', label: '基础资料', icon: <AppstoreOutlined />, children: [
      { key: '/master/materials', label: '物料', perm: ['master', 'engineering', 'plan', 'purchase', 'wms', 'qc', 'qa'] },
      { key: '/master/customers', label: '客户', perm: ['master', 'sales', 'finance'] },
      { key: '/master/suppliers', label: '供应商', perm: ['master', 'purchase', 'qa', 'finance'] },
      { key: '/master/equipment', label: '设备与仪器', perm: ['master', 'engineering', 'qa', 'qc'] },
      { key: '/master/work-centers', label: '工作中心', perm: ['master', 'engineering', 'plan'] },
      { key: '/master/warehouses', label: '仓库', perm: ['master', 'wms'] },
      { key: '/master/locations', label: '库位', perm: ['master', 'wms'] },
      { key: '/master/exchange-rates', label: '汇率', perm: ['master'] },
    ],
  },
  {
    key: 'system', label: '系统与合规', icon: <SettingOutlined />, children: [
      { key: '/system/users', label: '用户与角色', perm: ['admin'] },
      { key: '/system/settings', label: '系统设置（公司信息）', perm: ['admin'] },
      { key: '/system/audit', label: '审计追踪', perm: ['audit', 'admin'] },
      { key: '/system/esign', label: '电子签名记录', perm: ['audit', 'admin'] },
      { key: '/system/import', label: '数据导入（金蝶迁移）', perm: ['admin', 'master', 'engineering', 'wms'] },
    ],
  },
];

