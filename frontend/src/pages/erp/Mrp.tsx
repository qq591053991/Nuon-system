import {
  Alert, Button, Card, Col, Descriptions, Empty, Modal, Popconfirm, Row, Segmented, Select, Space, Spin, Statistic, Table, Tooltip, Typography, message,
  type TableColumnsType,
} from 'antd';
import { SwapOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { DocNoLink, DueDate, isPast } from './shared';

const ACTIONS = [
  { value: 'ALL', label: '全部' },
  { value: 'PURCHASE', label: '采购' },
  { value: 'PRODUCE', label: '生产' },
  { value: 'CUSTOMER_SUPPLY', label: '客供料' },
];

const num = (v: any) => <span style={{ color: v ? undefined : '#bfbfbf' }}>{fmtQty(v)}</span>;

export default function Mrp() {
  const { can } = useAuth();
  const canRun = can('plan');
  const canConvert = can('plan', 'purchase');
  const [runs, setRuns] = useState<Rec[]>([]);
  const [runId, setRunId] = useState<number>();
  const [run, setRun] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [converting, setConverting] = useState(false);
  const [action, setAction] = useState('ALL');
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<Rec | null>(null);

  const loadRuns = useCallback(async (pick?: number) => {
    const d = await get('/mrp/runs', { page_size: 50 });
    setRuns(d.items);
    setRunId(pick ?? d.items[0]?.id);
  }, []);

  const loadRun = useCallback(async (rid: number) => {
    setLoading(true);
    try {
      setRun(await get(`/mrp/runs/${rid}`));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    setSelected([]);
    if (runId) loadRun(runId);
    else setRun(null);
  }, [runId, loadRun]);

  const doRun = async () => {
    setRunning(true);
    try {
      const r = await post('/mrp/run');
      message.success(`MRP 运算完成：${r.summary ?? ''}`);
      await loadRuns(r.id);
    } finally {
      setRunning(false);
    }
  };

  const convert = async () => {
    setConverting(true);
    try {
      const r = await post('/mrp/convert', { suggestion_ids: selected });
      setResult(r);
      setSelected([]);
      if (runId) await loadRun(runId);
    } finally {
      setConverting(false);
    }
  };

  const ignore = async (sid: number) => {
    await post(`/mrp/suggestions/${sid}/ignore`);
    message.success('已忽略');
    setSelected((s) => s.filter((x) => x !== sid));
    if (runId) loadRun(runId);
  };

  const sugs: Rec[] = run?.suggestions || [];
  const count = (a: string) => (a === 'ALL' ? sugs.length : sugs.filter((s) => s.action === a).length);
  const data = useMemo(() => (action === 'ALL' ? sugs : sugs.filter((s) => s.action === action)), [sugs, action]);
  const stat = (st: string) => sugs.filter((s) => s.status === st).length;
  const isLatest = !!runs.length && runs[0].id === runId;

  const columns: TableColumnsType<Rec> = [
    {
      title: <Tooltip title="0 = 成品（独立需求），数字越大越接近原材料">层级</Tooltip>,
      dataIndex: 'level', width: 60, align: 'center', render: (v) => `L${v}`,
    },
    { title: '物料编码', dataIndex: 'material_code', fixed: 'left', render: (v) => <span className="mono">{v}</span> },
    {
      title: '物料名称 / 规格', key: 'name', width: 220,
      render: (_, r) => (
        <div>
          <div>{r.material_name}</div>
          {r.material_spec && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_spec}</Typography.Text>}
        </div>
      ),
    },
    { title: '建议', dataIndex: 'action', render: (v) => <StatusTag dict="mrp_action" value={v} /> },
    {
      title: '建议数量', dataIndex: 'suggested_qty', align: 'right',
      render: (v, r) => <b>{fmtQty(v)} <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>{r.uom}</Typography.Text></b>,
    },
    {
      title: '需求日期', dataIndex: 'due_date',
      render: (v, r) => <DueDate value={v} overdue={r.status === 'OPEN' && isPast(v)} hint="需求日期已过，请尽快处理" />,
    },
    {
      title: '供应商 / 客户', key: 'partner', width: 200, ellipsis: true,
      render: (_, r) => {
        if (r.action === 'PURCHASE') return r.supplier_name || <Typography.Text type="warning">未设置默认供应商</Typography.Text>;
        return r.customer_name || '-';
      },
    },
    {
      title: '状态', dataIndex: 'status',
      render: (v, r) => (
        <Space size={4}>
          <StatusTag dict="mrp_status" value={v} />
          {r.converted_doc_no && <DocNoLink kind={r.action === 'PURCHASE' ? 'po' : 'wo'} no={r.converted_doc_no} />}
        </Space>
      ),
    },
    { title: '毛需求', dataIndex: 'gross_qty', align: 'right', render: num },
    { title: '库存', dataIndex: 'on_hand_qty', align: 'right', render: num },
    { title: <Tooltip title="采购在途 + 在制工单未完工">在途+在制</Tooltip>, dataIndex: 'on_order_qty', align: 'right', render: num },
    { title: '安全库存', dataIndex: 'safety_stock', align: 'right', render: num },
    { title: '净需求', dataIndex: 'net_qty', align: 'right', render: num },
    { title: '备注', dataIndex: 'remark', ellipsis: true, width: 160, render: (v) => v || '-' },
  ];
  if (canConvert) {
    columns.push({
      title: '操作', key: 'op', fixed: 'right', width: 70,
      render: (_, r) =>
        r.status === 'OPEN' ? (
          <Popconfirm title="忽略后此建议不再转单，确定？" onConfirm={() => ignore(r.id)}>
            <Button size="small" type="link">忽略</Button>
          </Popconfirm>
        ) : null,
    });
  }

  const createdPos: string[] = result?.purchase_orders || [];
  const createdWos: string[] = result?.work_orders || [];
  const skipped: string[] = result?.skipped || [];

  return (
    <>
      <PageHeader
        title="MRP 物料需求计划"
        sub="根据已确认的销售订单，自动算出要生产什么、要采购什么、要通知客户供什么料。"
        extra={
          canRun && (
            <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={doRun}>
              运行 MRP
            </Button>
          )
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="MRP 运算逻辑"
          description="独立需求 = 已确认销售订单的未发货数量；按已发布 BOM 逐层展开得到各级物料毛需求；净需求 = 毛需求 + 安全库存 − 库存 − 采购在途 − 在制工单。自制件建议“生产”，外购件建议“采购”（按默认供应商合并成采购订单），客供料提示“通知客户供料”。"
        />
        {!runs.length ? (
          <Card>
            <Empty description="还没有运行过 MRP">
              {canRun && <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={doRun}>立即运行</Button>}
            </Empty>
          </Card>
        ) : (
          <>
            <Card size="small">
              <Row gutter={[24, 12]} align="middle">
                <Col flex="auto">
                  <Space wrap style={{ marginBottom: 8 }}>
                    <span>运算记录：</span>
                    <Select
                      style={{ width: 360 }}
                      value={runId}
                      onChange={setRunId}
                      options={runs.map((r, i) => ({ value: r.id, label: `${r.no}  ${fmtDateTime(r.run_at)}  ${r.run_by ?? ''}${i === 0 ? '（最新）' : ''}` }))}
                    />
                  </Space>
                  {run && (
                    <Descriptions
                      size="small"
                      column={{ xs: 1, md: 2 }}
                      items={[
                        { key: 'at', label: '运行', children: `${fmtDateTime(run.run_at)} · ${run.run_by ?? '-'}` },
                        { key: 'sum', label: '结果', children: run.summary || '-' },
                      ]}
                    />
                  )}
                </Col>
                <Col>
                  <Space size={32}>
                    <Statistic title="待处理" value={stat('OPEN')} valueStyle={{ color: stat('OPEN') ? '#d48806' : undefined }} />
                    <Statistic title="已转单" value={stat('CONVERTED')} valueStyle={{ color: '#389e0d' }} />
                    <Statistic title="已忽略" value={stat('IGNORED')} />
                  </Space>
                </Col>
              </Row>
              {!isLatest && runId && (
                <Alert type="warning" showIcon style={{ marginTop: 12 }} message="当前查看的不是最新一次运算结果，订单与库存可能已变化，建议重新运行 MRP 后再转单。" />
              )}
            </Card>
            <Card size="small">
              <Space wrap style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
                <Segmented
                  value={action}
                  onChange={(v) => setAction(v as string)}
                  options={ACTIONS.map((a) => ({ value: a.value, label: `${a.label}（${count(a.value)}）` }))}
                />
                {canConvert && (
                  <Space>
                    <Typography.Text type="secondary">勾选“待处理”的采购/生产建议后一键转单</Typography.Text>
                    <Button type="primary" icon={<SwapOutlined />} disabled={!selected.length} loading={converting} onClick={convert}>
                      一键转单{selected.length ? `（${selected.length}）` : ''}
                    </Button>
                  </Space>
                )}
              </Space>
              <Spin spinning={loading}>
                <Table
                  rowKey="id"
                  size="middle"
                  columns={columns}
                  dataSource={data}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需要处理的建议：库存与在途可以满足订单需求" /> }}
                  rowSelection={
                    canConvert
                      ? {
                          selectedRowKeys: selected,
                          onChange: (keys) => setSelected(keys as number[]),
                          getCheckboxProps: (r: Rec) => ({ disabled: r.status !== 'OPEN' || r.action === 'CUSTOMER_SUPPLY' }),
                        }
                      : undefined
                  }
                />
              </Spin>
            </Card>
          </>
        )}
      </Space>

      <Modal
        open={!!result}
        title="一键转单结果"
        onCancel={() => setResult(null)}
        footer={<Button type="primary" onClick={() => setResult(null)}>知道了</Button>}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {createdPos.length > 0 && (
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                已生成 <b>{createdPos.length}</b> 张采购订单（草稿），请审批后发给供应商：
              </Typography.Paragraph>
              <Space wrap>{createdPos.map((no) => <DocNoLink key={no} kind="po" no={no} />)}</Space>
            </div>
          )}
          {createdWos.length > 0 && (
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                已生成 <b>{createdWos.length}</b> 张生产工单（计划状态），请下达后生产：
              </Typography.Paragraph>
              <Space wrap>{createdWos.map((no) => <DocNoLink key={no} kind="wo" no={no} />)}</Space>
            </div>
          )}
          {!createdPos.length && !createdWos.length && !skipped.length && <Alert type="info" showIcon message="所选建议已处理，没有生成新单据" />}
          {skipped.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="以下建议未转单"
              description={
                <>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{skipped.map((s) => <li key={s}>{s}</li>)}</ul>
                  <Space size={16}>
                    <Link to="/master/materials">维护物料默认供应商 →</Link>
                    <Link to="/engineering/boms">维护 BOM →</Link>
                  </Space>
                </>
              }
            />
          )}
        </Space>
      </Modal>
    </>
  );
}
