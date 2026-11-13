/** RFID 作业台首页：九宫格入口（带待办数）、各读写器在线状态、进行中的作业、库门待确认、近 24 小时读取统计；条码作业作为兜底入口。 */
import { Alert, Badge, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { BarcodeOutlined, SettingOutlined, TagsOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../../api/http';
import { useAuth } from '../../../auth';
import PageHeader from '../../../components/PageHeader';
import { OnlineBadge, sessionUrl, useRfidOptions } from './kit';
import { RFID_TILES } from './tiles';

export default function RfidHome() {
  const nav = useNavigate();
  const { can } = useAuth();
  const opts = useRfidOptions();
  const [ov, setOv] = useState<Rec | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const load = useCallback(() => {
    get('/rfid/overview', undefined, true).then(setOv).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const h = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(h);
  }, [load]);
  useEffect(() => {
    const n = async (url: string, params?: Rec) => (await get(url, { page_size: 1, ...params }, true).catch(() => ({ total: 0 }))).total ?? 0;
    Promise.all([
      n('/purchase-orders', { status: 'APPROVED,PARTIAL_RECEIVED' }), n('/wms/putaway'), n('/issues', { status: 'DRAFT', issue_type: 'ISSUE' }),
      n('/stock-counts', { status: 'OPEN' }), n('/shipments', { status: 'DRAFT' }), n('/customer-returns', { status: 'RECEIVED' }),
      n('/work-orders', { status: 'IN_PROGRESS,COMPLETED' }),
    ]).then(([po_receive, putaway, issue, count_open, ship, rma, fg]) => setCounts({ po_receive, putaway, issue, count_open, ship, rma, fg }));
  }, []);
  const badge = (k?: string) => (k === 'rfid_gate' ? ov?.gate_pending ?? 0 : k ? counts[k] ?? 0 : 0);
  const tiles = RFID_TILES.filter((t) => !t.perm || can(...t.perm));
  const readers: Rec[] = ov?.readers ?? [];
  const sessions: Rec[] = (ov?.open_sessions ?? []) as Rec[];
  return (
    <div>
      <PageHeader
        title="RFID 作业台"
        sub="收货台、库门、发货口固定读写器自动读取，盘点用手持读写器批量读；仓管在电脑/大屏上核对并确认。标签读不到时，各页面都可扫条码或手输兜底。"
        extra={
          <>
            <Button icon={<BarcodeOutlined />} onClick={() => nav('/wms/pda')}>条码作业（兜底）</Button>
            <Button icon={<TagsOutlined />} onClick={() => nav('/wms/rfid/tags')}>标签管理</Button>
            {can('wms', 'admin') && <Button icon={<SettingOutlined />} onClick={() => nav('/wms/rfid/readers')}>读写器管理</Button>}
          </>
        }
      />
      {!!ov?.gate_pending && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={<span>库门有 <b>{ov.gate_pending}</b> 个过门标签待确认（确认后才移库，防止误读改库存）</span>}
          action={<Button type="primary" size="small" onClick={() => nav('/wms/rfid/gate')}>去确认</Button>} />
      )}
      <Row gutter={[12, 12]}>
        {tiles.map((t) => {
          const n = badge(t.badgeKey);
          return (
            <Col key={t.key} xs={12} sm={8} md={6} xl={4}>
              <Card hoverable onClick={() => nav(t.path)} styles={{ body: { padding: '16px 8px', textAlign: 'center', position: 'relative' } }}>
                {!!n && <div style={{ position: 'absolute', top: 8, right: 10, lineHeight: 1 }}><Badge count={n} overflowCount={99} /></div>}
                <div style={{ fontSize: 30, color: t.color, lineHeight: 1 }}><t.icon /></div>
                <div style={{ marginTop: 8, fontSize: 15, fontWeight: 600 }}>{t.title}</div>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col xs={24} lg={10}>
          <Card size="small" title="读写器" extra={opts?.simulate ? <Tag color="orange">模拟读取已开启（演示/测试）</Tag> : null}>
            {!readers.length ? <Empty description="还没有登记读写器" /> : (
              <Table size="small" rowKey="id" dataSource={readers} pagination={false} columns={[
                { title: '读写器', dataIndex: 'name', render: (v: string, r: Rec) => <div><b>{v}</b><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.code} · {r.purpose_text}</div></div> },
                { title: '状态', key: 's', width: 120, render: (_: any, r: Rec) => <div><OnlineBadge r={r} /><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.last_heartbeat_at ? `心跳 ${dayjs(r.last_heartbeat_at).format('MM-DD HH:mm')}` : '从未连接'}</div></div> },
                { title: '作业', key: 'o', render: (_: any, r: Rec) => (r.open_session ? <a onClick={() => nav(sessionUrl(r.open_session))}>{r.open_session.type_text} {r.open_session.no}</a> : '-') },
              ]} />
            )}
          </Card>
          <Card size="small" title="近 24 小时读取" style={{ marginTop: 12 }}>
            <Row>
              <Col span={8}><Statistic title="原始读取" value={ov?.stats_24h?.reads ?? 0} /></Col>
              <Col span={8}><Statistic title="弱信号已过滤" value={ov?.stats_24h?.low_rssi ?? 0} /></Col>
              <Col span={8}><Statistic title="无作业时读到" value={ov?.stats_24h?.no_session ?? 0} /></Col>
            </Row>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>信号低于 {opts?.rssi_min ?? -70} dBm 的读取视为误读（隔壁货架、擦边）只记录不计入；读写器心跳超过 {opts?.online_seconds ?? 120} 秒显示离线。</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title={`进行中的作业（${sessions.length}）`}>
            <Table size="small" rowKey="id" dataSource={sessions} pagination={false} scroll={{ x: 'max-content' }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有进行中的作业，点上方入口开始" /> }}
              columns={[
                { title: '作业', dataIndex: 'no', render: (v: string, r: Rec) => <a onClick={() => nav(sessionUrl(r))}>{r.type_text} {v}</a> },
                { title: '单据/库位', dataIndex: 'context_no', render: (v: string) => v || '-' },
                { title: '读写器', dataIndex: 'reader_name' },
                { title: '标签', dataIndex: 'tag_count', width: 60 },
                { title: '待处理', dataIndex: 'pending_count', width: 70, render: (v: number) => (v ? <b style={{ color: '#d46b08' }}>{v}</b> : 0) },
                { title: '开始', dataIndex: 'created_at', render: (v: string, r: Rec) => <span>{dayjs(v).format('MM-DD HH:mm')} <Typography.Text type="secondary">{r.created_by}</Typography.Text></span> },
                { title: '', key: 'op', render: (_: any, r: Rec) => <Button size="small" type="primary" onClick={() => nav(sessionUrl(r))}>{r.session_type === 'GATE' ? '去确认' : '继续'}</Button> },
              ]} />
          </Card>
          <Space direction="vertical" style={{ marginTop: 12, width: '100%' }}>
            <Alert type="info" showIcon message="作业方式"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>收货台：选采购单 → 贴好空白标签的料盘/箱放上读写器 → 绑定到订单行 → 确认生成入库单（同时发卡）。</li>
                  <li>库门：货物过门自动生成“待确认”，仓管核对后一键确认才调拨；方向不明、弱信号、未登记的一律不自动过账。</li>
                  <li>领料 / 发货：读到的标签与领料单、发货单逐条核对（多读、少读、读错批次、未放行、不属于本单），全部一致才能过账。</li>
                  <li>盘点：手持读写器扫过整个库位后上传，按“读到 / 账面有没读到 / 读到但账面不在此库位”对账，写入盘点单并按当前账面过账。</li>
                </ul>
              } />
          </Space>
        </Col>
      </Row>
    </div>
  );
}
