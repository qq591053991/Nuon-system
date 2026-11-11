import { Alert, Badge, Button, Card, Input, Progress, Space, Table, Tabs, Typography } from 'antd';
import { FileProtectOutlined, ReloadOutlined, SplitCellsOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { ReleaseBatchModal, WoReleaseHistory } from '../mes/ReleaseBatch';

type TabKey = 'partial' | 'pending' | 'wip' | 'released' | 'rejected';
const TABS: Record<TabKey, { label: string; query: Rec; hint: string }> = {
  partial: {
    label: '可分批放行', query: { status: undefined, dhr_status: undefined, releasable: 1 },
    hint: '有已完工入库、尚未放行成品的工单（含生产中的大工单）。可按序列号或数量分批审核放行，已放行的部分即可发货。',
  },
  pending: {
    label: '待整单放行', query: { status: 'COMPLETED', dhr_status: 'OPEN', releasable: undefined },
    hint: '已完工的生产批，请审核 DHR 并电子签名【放行全部剩余】（或继续分批放行）；全部放行后工单关闭。',
  },
  wip: {
    label: '生产中', query: { status: 'IN_PROGRESS,RELEASED', dhr_status: undefined, releasable: undefined },
    hint: '尚未完工的工单。已完工入库的部分为“待放行”，可在【可分批放行】中先行放行。',
  },
  released: { label: '已放行', query: { status: undefined, dhr_status: 'RELEASED', releasable: undefined }, hint: '已全部审核放行的批次，成品为合格库存，可以发货。' },
  rejected: { label: '已拒绝', query: { status: undefined, dhr_status: 'REJECTED', releasable: undefined }, hint: 'QA 整单拒绝放行的批次，剩余成品已冻结（HOLD），需调查处理。' },
};
const KEYS = Object.keys(TABS) as TabKey[];

export default function ReleaseCenter() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState<TabKey>('partial');
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const [batchWo, setBatchWo] = useState<Rec | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const { rows, loading, setQuery, reload, pagination } = usePaged('/work-orders', TABS.partial.query);

  const loadCounts = useCallback(() => {
    Promise.all(KEYS.map((k) => get('/work-orders', { ...TABS[k].query, page_size: 1 }, true).then((d) => [k, d.total] as const).catch(() => [k, undefined] as const)))
      .then((list) => setCounts(Object.fromEntries(list)));
  }, []);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  const columns: any[] = [
    { title: '工单号', dataIndex: 'no', fixed: 'left', render: (v: string, r: Rec) => <Link to={`/mes/work-orders/${r.id}`}>{v}</Link> },
    {
      title: '产品', dataIndex: 'material_name',
      render: (v: string, r: Rec) => (
        <div>
          <div>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}</Typography.Text>
        </div>
      ),
    },
    { title: '客户', dataIndex: 'customer_name', render: (v: string) => v || '-' },
    {
      title: '生产批号', dataIndex: 'lot_no',
      render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> : '-'),
    },
    {
      title: '计划 / 完工 / 报废', key: 'qty', align: 'right',
      render: (_: any, r: Rec) => <span>{fmtQty(r.planned_qty)} / <b>{fmtQty(r.completed_qty)}</b> / <span style={{ color: r.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(r.scrap_qty)}</span></span>,
    },
    {
      title: '已入库', dataIndex: 'received_qty', align: 'right',
      render: (v: number, r: Rec) => <span style={{ color: v < r.completed_qty ? '#d48806' : undefined }}>{fmtQty(v)}</span>,
    },
    {
      title: '已放行', dataIndex: 'released_qty', align: 'right',
      render: (v: number, r: Rec) => <span style={{ color: v > 0 ? '#389e0d' : undefined, fontWeight: v > 0 && v < r.received_qty ? 600 : undefined }}>{fmtQty(v)}</span>,
    },
    { title: '进度', dataIndex: 'progress', width: 140, render: (v: number) => <Progress percent={v} size="small" /> },
    { title: '实际完工', dataIndex: 'actual_end', render: (v: string) => fmtDateTime(v) },
    { title: '工单状态', dataIndex: 'status', render: (v: string) => <StatusTag dict="wo_status" value={v} /> },
    { title: 'DHR 状态', dataIndex: 'dhr_status', render: (v: string) => <StatusTag dict="dhr_status" value={v} /> },
    {
      title: '操作', key: 'op', fixed: 'right',
      render: (_: any, r: Rec) => (
        <Space size={4}>
          {can('qa') && r.dhr_status === 'OPEN' && ['IN_PROGRESS', 'COMPLETED'].includes(r.status) && (tab === 'partial' || r.received_qty > r.released_qty) && (
            <Button size="small" type={tab === 'partial' ? 'primary' : 'default'} icon={<SplitCellsOutlined />} onClick={() => setBatchWo(r)}>分批放行</Button>
          )}
          <Button size="small" type={tab === 'pending' ? 'primary' : 'default'} icon={<FileProtectOutlined />} onClick={() => nav(`/quality/dhr/${r.id}`)}>
            {tab === 'pending' || tab === 'partial' ? '审核 DHR' : '查看 DHR'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="DHR 审核与放行" sub="器械生产记录（DHR）汇集了一个生产批的用料批次、工序与测试数据、设备校准、不合格处置与签名记录。" />
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="成品完工入库后为“待放行”，QA 审核 DHR 并电子签名放行后才能发货；大工单可按“放行批”分批放行，只有已放行批中的产品可以发货。" />
      <Card styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => {
            setTab(k as TabKey);
            setQuery(TABS[k as TabKey].query);
          }}
          tabBarExtraContent={
            <Space>
              <Input.Search allowClear placeholder="工单号 / 批号 / 产品" style={{ width: 220 }} onSearch={(q) => setQuery({ q })} />
              <Button icon={<ReloadOutlined />} onClick={() => { reload(); loadCounts(); }} />
            </Space>
          }
          items={KEYS.map((k) => ({
            key: k,
            label: (
              <Space size={6}>
                {TABS[k].label}
                {counts[k] !== undefined && (
                  <Badge count={counts[k]} showZero overflowCount={999} color={(k === 'pending' || k === 'partial') && counts[k]! > 0 ? '#fa541c' : k === 'rejected' && counts[k]! > 0 ? '#cf1322' : '#bfbfbf'} />
                )}
              </Space>
            ),
          }))}
        />
        <Typography.Paragraph type="secondary">{TABS[tab].hint}</Typography.Paragraph>
        <Table<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }}
          expandable={{
            rowExpandable: (r) => (r.released_qty || 0) > 0 || r.dhr_status !== 'OPEN',
            expandedRowRender: (r) => (
              <div style={{ padding: '4px 0' }}>
                <Typography.Text strong>放行记录</Typography.Text>
                <WoReleaseHistory woId={r.id} refreshKey={historyKey} />
              </div>
            ),
          }} />
      </Card>
      <ReleaseBatchModal wo={batchWo} open={!!batchWo} onClose={() => setBatchWo(null)}
        onDone={() => {
          reload();
          loadCounts();
          setHistoryKey((k) => k + 1);
        }} />
    </>
  );
}
