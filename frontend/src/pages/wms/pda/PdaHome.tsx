/** PDA 仓库作业首页：大按钮九宫格（带待办数量），一手可点。九宫格定义见 tiles.ts（工作台复用）。 */
import { Badge, Card, Col, Row, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../../../api/http';
import { useAuth } from '../../../auth';
import { PdaPage } from './kit';
import { PDA_TILES } from './tiles';

export default function PdaHome() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const n = async (url: string, params?: Record<string, unknown>) => (await get(url, { page_size: 1, ...params }, true).catch(() => ({ total: 0 }))).total ?? 0;
    Promise.all([
      n('/purchase-orders', { status: 'APPROVED,PARTIAL_RECEIVED' }),
      n('/wms/putaway'),
      n('/issues', { status: 'DRAFT', issue_type: 'ISSUE' }),
      n('/stock-counts', { status: 'OPEN' }),
      n('/shipments', { status: 'DRAFT' }),
      n('/customer-returns', { status: 'RECEIVED' }),
    ]).then(([po_receive, putaway, issue, count_open, ship, rma]) => setCounts({ po_receive, putaway, issue, count_open, ship, rma }));
  }, []);
  const tiles = PDA_TILES.filter((t) => !t.perm || can(...t.perm));
  return (
    <PdaPage title="仓库作业" sub="扫码 = 键入 + 回车；每个作业页都可连续扫码" back={null}>
      <Row gutter={[10, 10]}>
        {tiles.map((t) => {
          const count = t.badgeKey ? counts[t.badgeKey] : 0;
          return (
            <Col span={8} key={t.key}>
              <Card hoverable onClick={() => nav(t.path)} styles={{ body: { padding: '14px 4px', textAlign: 'center', position: 'relative' } }}>
                {!!count && <div style={{ position: 'absolute', top: 6, right: 8, lineHeight: 1 }}><Badge count={count} overflowCount={99} /></div>}
                <div style={{ fontSize: 30, color: t.color, lineHeight: 1 }}><t.icon /></div>
                <div style={{ marginTop: 8, fontSize: 15, fontWeight: 600 }}>{t.title}</div>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 13 }}>
        角标 = 待处理数量：待收货采购单、待上架批次、待拣领料单、进行中盘点单、待过账发货单、待处置退货。
      </Typography.Paragraph>
    </PdaPage>
  );
}
