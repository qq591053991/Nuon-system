/**
 * PDA 仓库作业九宫格定义（/wms/pda 与仓管工作台共用）。
 *   key       唯一键
 *   title     显示文字
 *   icon      图标组件（用法 <t.icon />）
 *   path      进入的页面（PDA 作业页；“客户退货”“生产退料”“发货”直达登记/新建）
 *   badgeKey  角标数据键（与工作台待办 key 一致；putaway = GET /api/wms/putaway 的 total）
 *   perm      需要的权限点（任一）
 */
import type { ComponentType, CSSProperties } from 'react';
import {
  AuditOutlined, CarryOutOutlined, DatabaseOutlined, ExportOutlined, InboxOutlined, ProfileOutlined, RollbackOutlined, SendOutlined, SwapOutlined, UndoOutlined,
} from '@ant-design/icons';

export interface PdaTile {
  key: string;
  title: string;
  icon: ComponentType<{ style?: CSSProperties }>;
  path: string;
  badgeKey?: string;
  perm?: string[];
  color: string;
}

export const PDA_TILES: PdaTile[] = [
  { key: 'receive', title: '采购收货', icon: InboxOutlined, path: '/wms/pda/receive', badgeKey: 'po_receive', perm: ['wms'], color: '#1677ff' },
  { key: 'putaway', title: '上架/调拨', icon: SwapOutlined, path: '/wms/pda/putaway', badgeKey: 'putaway', perm: ['wms'], color: '#13c2c2' },
  { key: 'pick', title: '拣料领料', icon: ExportOutlined, path: '/wms/pda/pick', badgeKey: 'issue', perm: ['wms'], color: '#fa8c16' },
  { key: 'count', title: '盘点', icon: AuditOutlined, path: '/wms/pda/count', badgeKey: 'count_open', perm: ['wms'], color: '#722ed1' },
  { key: 'ship', title: '发货', icon: SendOutlined, path: '/wms/shipments?new=1', badgeKey: 'ship', perm: ['wms'], color: '#2f54eb' },
  { key: 'fg', title: '完工入库', icon: ProfileOutlined, path: '/wms/pda/fg', badgeKey: 'fg', perm: ['wms'], color: '#52c41a' },
  { key: 'cs_receive', title: '客供料收货', icon: CarryOutOutlined, path: '/wms/pda/receive?mode=cs', perm: ['wms'], color: '#9254de' },
  { key: 'wo_return', title: '生产退料', icon: UndoOutlined, path: '/wms/issues?return=1', perm: ['wms'], color: '#d46b08' },
  { key: 'rma', title: '客户退货', icon: RollbackOutlined, path: '/wms/customer-returns?new=1', badgeKey: 'rma', perm: ['wms', 'qa'], color: '#eb2f96' },
  { key: 'stock', title: '库存查询', icon: DatabaseOutlined, path: '/wms/stock', color: '#595959' },
];
