import { Alert, Badge, Button, Card, Input, Progress, Space, Table, Tabs, Typography } from 'antd';
import { FileProtectOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime, fmtQty } from '../../utils/format';

type TabKey = 'pending' | 'wip' | 'released' | 'rejected';
const TABS: Record<TabKey, { label: string; query: Rec; hint: string }> = {
  pending: { label: '待放行', query: { status: 'COMPLETED', dhr_status: 'OPEN' }, hint: '已完工的生产批，成品在库为“待放行”，请逐批审核 DHR 并电子签名放行。' },
  wip: { label: '生产中', query: { status: 'IN_PROGRESS,RELEASED', dhr_status: undefined }, hint: '尚未完工的工单。已完工入库的部分同样为“待放行”，需整批完工后审核放行。' },
  released: { label: '已放行', query: { status: undefined, dhr_status: 'RELEASED' }, hint: '已审核放行的批次，成品为合格库存，可以发货。' },
  rejected: { label: '已拒绝', query: { status: undefined, dhr_status: 'REJECTED' }, hint: 'QA 拒绝放行的批次，成品已冻结（HOLD），需调查处理。' },
};
const KEYS = Object.keys(TABS) as TabKey[];

export default function ReleaseCenter() {
  const nav = useNavigate();
  const [tab, setTab] = useState<TabKey>('pending');
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const { rows, loading, setQuery, reload, pagination } = usePaged('/work-orders', TABS.pending.query);

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
    { title: '进度', dataIndex: 'progress', width: 140, render: (v: number) => <Progress percent={v} size="small" /> },
    { title: '实际完工', dataIndex: 'actual_end', render: (v: string) => fmtDateTime(v) },
    { title: '工单状态', dataIndex: 'status', render: (v: string) => <StatusTag dict="wo_status" value={v} /> },
    { title: 'DHR 状态', dataIndex: 'dhr_status', render: (v: string) => <StatusTag dict="dhr_status" value={v} /> },
    {
      title: '操作', key: 'op', fixed: 'right',
      render: (_: any, r: Rec) => (
        <Button size="small" type={tab === 'pending' ? 'primary' : 'default'} icon={<FileProtectOutlined />} onClick={() => nav(`/quality/dhr/${r.id}`)}>
          {tab === 'pending' ? '审核 DHR' : '查看 DHR'}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="DHR 审核与放行" sub="器械生产记录（DHR）汇集了一个生产批的用料批次、工序与测试数据、设备校准、不合格处置与签名记录。" />
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="成品完工入库后为“待放行”，QA 审核 DHR 并电子签名放行后才能发货。" />
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
                  <Badge count={counts[k]} showZero overflowCount={999} color={k === 'pending' && counts[k]! > 0 ? '#fa541c' : k === 'rejected' && counts[k]! > 0 ? '#cf1322' : '#bfbfbf'} />
                )}
              </Space>
            ),
          }))}
        />
        <Typography.Paragraph type="secondary">{TABS[tab].hint}</Typography.Paragraph>
        <Table<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
