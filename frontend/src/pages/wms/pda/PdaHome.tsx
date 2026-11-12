/** PDA 仓库作业首页：大按钮九宫格（带待办数量），一手可点。 */
import { Badge, Card, Col, Row, Typography } from 'antd';
import {
  AuditOutlined, CarryOutOutlined, DatabaseOutlined, ExportOutlined, InboxOutlined, ProfileOutlined, RollbackOutlined, SendOutlined, SwapOutlined,
} from '@ant-design/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../../../api/http';
import { PdaPage } from './kit';

interface Tile { to: string; label: string; icon: ReactNode; count?: number; color: string }

export default function PdaHome() {
  const nav = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const n = async (url: string, params?: Record<string, unknown>) => (await get(url, { page_size: 1, ...params }, true).catch(() => ({ total: 0 }))).total ?? 0;
    Promise.all([
      n('/purchase-orders', { status: 'APPROVED,PARTIAL_RECEIVED' }),
      n('/wms/putaway'),
      n('/issues', { status: 'DRAFT', issue_type: 'ISSUE' }),
      n('/stock-counts', { status: 'OPEN' }),
    ]).then(([po, pa, iss, cnt]) => setCounts({ po, pa, iss, cnt }));
  }, []);
  const tiles: Tile[] = [
    { to: '/wms/pda/receive', label: '采购收货', icon: <InboxOutlined />, count: counts.po, color: '#1677ff' },
    { to: '/wms/pda/putaway', label: '上架/调拨', icon: <SwapOutlined />, count: counts.pa, color: '#13c2c2' },
    { to: '/wms/pda/pick', label: '拣料领料', icon: <ExportOutlined />, count: counts.iss, color: '#fa8c16' },
    { to: '/wms/pda/count', label: '盘点', icon: <AuditOutlined />, count: counts.cnt, color: '#722ed1' },
    { to: '/wms/pda/receive?mode=cs', label: '客供料收货', icon: <CarryOutOutlined />, color: '#9254de' },
    { to: '/wms/pda/fg', label: '完工入库', icon: <ProfileOutlined />, color: '#52c41a' },
    { to: '/wms/shipments?new=1', label: '发货', icon: <SendOutlined />, color: '#2f54eb' },
    { to: '/wms/customer-returns?new=1', label: '客户退货', icon: <RollbackOutlined />, color: '#eb2f96' },
    { to: '/wms/stock', label: '库存查询', icon: <DatabaseOutlined />, color: '#595959' },
  ];
  return (
    <PdaPage title="仓库作业" sub="扫码 = 键入 + 回车；每个作业页都可连续扫码" back={null}>
      <Row gutter={[10, 10]}>
        {tiles.map((t) => (
          <Col span={8} key={t.to}>
            <Card hoverable onClick={() => nav(t.to)} styles={{ body: { padding: '14px 4px', textAlign: 'center', position: 'relative' } }}>
              {!!t.count && <div style={{ position: 'absolute', top: 6, right: 8, lineHeight: 1 }}><Badge count={t.count} overflowCount={99} /></div>}
              <div style={{ fontSize: 30, color: t.color, lineHeight: 1 }}>{t.icon}</div>
              <div style={{ marginTop: 8, fontSize: 15, fontWeight: 600 }}>{t.label}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 13 }}>
        角标 = 待处理数量：待收货采购单、待上架批次、待拣领料单、进行中盘点单。
      </Typography.Paragraph>
    </PdaPage>
  );
}
