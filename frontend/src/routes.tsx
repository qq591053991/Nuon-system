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
export interface MenuDef { key: string; label: string; icon?: ReactNode; perm?: string[]; children?: MenuDef[] }

export const routes: RouteDef[] = [
  { path: '/', element: lazy(() => import('./pages/Dashboard')) },
  // ERP
  { path: '/sales/orders', element: lazy(() => import('./pages/erp/SalesOrders')) },
  { path: '/sales/orders/:id', element: lazy(() => import('./pages/erp/SalesOrderDetail')) },
  { path: '/purchase/orders', element: lazy(() => import('./pages/erp/PurchaseOrders')) },
  { path: '/purchase/orders/:id', element: lazy(() => import('./pages/erp/PurchaseOrderDetail')) },
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
  // WMS
  { path: '/wms/stock', element: lazy(() => import('./pages/wms/Stock')) },
  { path: '/wms/moves', element: lazy(() => import('./pages/wms/StockMoves')) },
  { path: '/wms/receipts', element: lazy(() => import('./pages/wms/Receipts')) },
  { path: '/wms/issues', element: lazy(() => import('./pages/wms/Issues')) },
  { path: '/wms/shipments', element: lazy(() => import('./pages/wms/Shipments')) },
  { path: '/wms/counts', element: lazy(() => import('./pages/wms/StockCounts')) },
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
  // 系统
  { path: '/system/users', element: lazy(() => import('./pages/system/Users')) },
  { path: '/system/audit', element: lazy(() => import('./pages/system/AuditLogs')) },
  { path: '/system/esign', element: lazy(() => import('./pages/system/ESignatures')) },
  { path: '/system/import', element: lazy(() => import('./pages/system/DataImport')) },
];

export const menu: MenuDef[] = [
  { key: '/', label: '工作台', icon: <DashboardOutlined /> },
  { key: '/mes/station', label: '工位终端', icon: <ScanOutlined /> },
  {
    key: 'sales', label: '销售与计划', icon: <ShoppingOutlined />, children: [
      { key: '/sales/orders', label: '销售订单' },
      { key: '/plan/mrp', label: 'MRP 物料需求' },
    ],
  },
  { key: 'purchase', label: '采购', icon: <ShoppingCartOutlined />, children: [{ key: '/purchase/orders', label: '采购订单' }] },
  {
    key: 'mes', label: '生产执行 MES', icon: <ToolOutlined />, children: [
      { key: '/mes/work-orders', label: '生产工单' },
    ],
  },
  {
    key: 'quality', label: '质量管理 QMS', icon: <ExperimentOutlined />, children: [
      { key: '/quality/inspections', label: '来料检验 IQC' },
      { key: '/quality/ncrs', label: '不合格品 NCR' },
      { key: '/quality/capas', label: '纠正预防 CAPA' },
      { key: '/quality/release', label: 'DHR 审核与放行' },
    ],
  },
  {
    key: 'wms', label: '仓储管理 WMS', icon: <DatabaseOutlined />, children: [
      { key: '/wms/stock', label: '库存查询' },
      { key: '/wms/receipts', label: '收货入库' },
      { key: '/wms/issues', label: '生产领料' },
      { key: '/wms/shipments', label: '发货出库' },
      { key: '/wms/counts', label: '库存盘点' },
      { key: '/wms/moves', label: '库存流水' },
    ],
  },
  { key: '/trace', label: '质量追溯', icon: <NodeIndexOutlined /> },
  { key: '/finance', label: '应收应付', icon: <AccountBookOutlined /> },
  {
    key: 'engineering', label: '工程数据', icon: <ApartmentOutlined />, children: [
      { key: '/engineering/boms', label: 'BOM 物料清单' },
      { key: '/engineering/routings', label: '工艺路线与测试规格' },
    ],
  },
  {
    key: 'master', label: '基础资料', icon: <AppstoreOutlined />, children: [
      { key: '/master/materials', label: '物料' },
      { key: '/master/customers', label: '客户' },
      { key: '/master/suppliers', label: '供应商' },
      { key: '/master/equipment', label: '设备与仪器' },
      { key: '/master/work-centers', label: '工作中心' },
      { key: '/master/warehouses', label: '仓库' },
      { key: '/master/locations', label: '库位' },
    ],
  },
  {
    key: 'system', label: '系统与合规', icon: <SettingOutlined />, children: [
      { key: '/system/users', label: '用户与角色', perm: ['admin'] },
      { key: '/system/audit', label: '审计追踪' },
      { key: '/system/esign', label: '电子签名记录' },
      { key: '/system/import', label: '数据导入（金蝶迁移）' },
    ],
  },
];

