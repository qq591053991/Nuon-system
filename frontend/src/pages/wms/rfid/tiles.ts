/**
 * RFID 仓库作业九宫格定义（/wms/rfid 作业台与仓管工作台共用）。
 *   key       唯一键
 *   title     显示文字
 *   icon      图标组件（用法 <t.icon />）
 *   path      进入的页面（RFID 作业台各页面；“待上架”“生产退料”“库存查询”为电脑页面）
 *   badgeKey  角标数据键（与工作台待办 key 一致；rfid_gate = 库门待确认的标签数）
 *   perm      需要的权限点（任一）
 * 条码作业页（/wms/pda/*）保留为兜底，从 RFID 作业台“条码作业（兜底）”进入，不再出现在九宫格。
 */
import type { ComponentType, CSSProperties } from 'react';
import {
  AuditOutlined, DatabaseOutlined, ExportOutlined, InboxOutlined, LoginOutlined, ProfileOutlined, RollbackOutlined, SendOutlined, SwapOutlined, TagsOutlined, UndoOutlined,
} from '@ant-design/icons';

export interface RfidTile {
  key: string;
  title: string;
  icon: ComponentType<{ style?: CSSProperties }>;
  path: string;
  badgeKey?: string;
  perm?: string[];
  color: string;
}

export const RFID_TILES: RfidTile[] = [
  { key: 'receive', title: '收货台', icon: InboxOutlined, path: '/wms/rfid/receive', badgeKey: 'po_receive', perm: ['wms'], color: '#1677ff' },
  { key: 'gate', title: '库门待确认', icon: LoginOutlined, path: '/wms/rfid/gate', badgeKey: 'rfid_gate', perm: ['wms'], color: '#13c2c2' },
  { key: 'putaway', title: '待上架', icon: SwapOutlined, path: '/wms/putaway', badgeKey: 'putaway', perm: ['wms'], color: '#08979c' },
  { key: 'pick', title: '领料核对', icon: ExportOutlined, path: '/wms/rfid/issue', badgeKey: 'issue', perm: ['wms'], color: '#fa8c16' },
  { key: 'fg', title: '完工入库', icon: ProfileOutlined, path: '/wms/rfid/fg', badgeKey: 'fg', perm: ['wms'], color: '#52c41a' },
  { key: 'ship', title: '发货核对', icon: SendOutlined, path: '/wms/rfid/ship', badgeKey: 'ship', perm: ['wms'], color: '#2f54eb' },
  { key: 'count', title: '盘点对账', icon: AuditOutlined, path: '/wms/rfid/count', badgeKey: 'count_open', perm: ['wms'], color: '#722ed1' },
  { key: 'rma', title: '客户退货', icon: RollbackOutlined, path: '/wms/rfid/return', badgeKey: 'rma', perm: ['wms'], color: '#eb2f96' },
  { key: 'wo_return', title: '生产退料', icon: UndoOutlined, path: '/wms/issues?return=1', perm: ['wms'], color: '#d46b08' },
  { key: 'tags', title: '标签管理', icon: TagsOutlined, path: '/wms/rfid/tags', perm: ['wms'], color: '#9254de' },
  { key: 'stock', title: '库存查询', icon: DatabaseOutlined, path: '/wms/stock', color: '#595959' },
];
