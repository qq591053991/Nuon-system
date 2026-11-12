import {
  Alert, App, Button, Card, Col, Collapse, Descriptions, Empty, Modal, Popconfirm, Popover, Row, Segmented, Select, Space, Spin, Statistic, Table, Tag, Tooltip,
  Typography, message, type TableColumnsType,
} from 'antd';
import { NotificationOutlined, ReloadOutlined, SwapOutlined, ThunderboltOutlined, WarningOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { PrintButton, PrintHeader } from '../../components/Print';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { DocLink, DocNoLink, DueDate, isPast } from './shared';

const ACTIONS = [
  { value: 'ALL', label: '全部' },
  { value: 'PURCHASE', label: '采购' },
  { value: 'PRODUCE', label: '生产' },
  { value: 'CUSTOMER_SUPPLY', label: '客供料' },
  { value: 'EXPEDITE', label: '提前催交' },
];

const num = (v: any) => <span style={{ color: v ? undefined : '#bfbfbf' }}>{fmtQty(v)}</span>;
const weekText = (w?: string | null) => (w ? `${w.replace(/^(\d{4})-W(\d+)$/, '$1 第$2周')}` : '-');

/** 需求来源一条：订单行 / 工单用料 / 上层计划 */
function RefText({ r }: { r: Rec }) {
  if (r.type === 'SO') {
    return (
      <span>
        订单 <Link to={`/sales/orders/${r.id}`} className="mono">{r.no}</Link> 行{r.line_no}
        <Typography.Text type="secondary"> {fmtQty(r.qty)} · 交期 {fmtDate(r.date)}{r.customer ? ` · ${r.customer}` : ''}</Typography.Text>
      </span>
    );
  }
  if (r.type === 'WO') {
    return (
      <span>
        工单 <Link to={`/mes/work-orders/${r.id}`} className="mono">{r.no}</Link>
        <Typography.Text type="secondary"> {r.parent ?? ''} 用料 {fmtQty(r.qty)} · 开工 {fmtDate(r.date)}</Typography.Text>
      </span>
    );
  }
  if (r.type === 'PLAN') {
    return (
      <span>
        上层计划 <span className="mono">{r.parent}</span>
        <Typography.Text type="secondary"> 用料 {fmtQty(r.qty)} · 开工 {fmtDate(r.date)}{r.so?.length ? ` · 来自订单 ${r.so.join('、')}` : ''}</Typography.Text>
      </span>
    );
  }
  return <span>{r.no}</span>;
}

/** 催交对象：采购单 / 工单 */
function ExpediteText({ r }: { r: Rec }) {
  const doc = r.type === 'PO' ? <Link to={`/purchase/orders/${r.id}`} className="mono">{r.no}</Link> : <Link to={`/mes/work-orders/${r.id}`} className="mono">{r.no}</Link>;
  return (
    <span>
      {r.type === 'PO' ? '催采购单' : '提前工单'} {doc} {fmtQty(r.qty)}：{fmtDate(r.date)} → <b>{fmtDate(r.to_date)}</b>
      {r.status && ['CANCELLED', 'CLOSED'].includes(r.status) && <Tag color="red" style={{ marginInlineStart: 4 }}>已{r.status === 'CANCELLED' ? '取消' : '关闭'}</Tag>}
    </span>
  );
}

const refsPlain = (s: Rec) =>
  [
    ...(s.demand || []).map((r: Rec) =>
      r.type === 'SO' ? `订单${r.no}行${r.line_no} ${r.qty}` : r.type === 'WO' ? `工单${r.no} ${r.qty}` : `上层计划${r.parent} ${r.qty}${r.so?.length ? `(${r.so.join('/')})` : ''}`,
    ),
    ...(s.expedite || []).map((r: Rec) => `催交${r.no} ${r.qty} ${r.date}→${r.to_date}`),
  ].join('；');

export default function Mrp() {
  const { can } = useAuth();
  const { modal } = App.useApp();
  const canRun = can('plan');
  const canConvert = can('plan', 'purchase');
  const [runs, setRuns] = useState<Rec[]>([]);
  const [runId, setRunId] = useState<number>();
  const [run, setRun] = useState<Rec | null>(null);
  const [stale, setStale] = useState<Rec | null>(null);
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
      const [r, s] = await Promise.all([get(`/mrp/runs/${rid}`), get(`/mrp/runs/${rid}/staleness`, undefined, true).catch(() => null)]);
      setRun(r);
      setStale(s);
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

  const sugs: Rec[] = run?.suggestions || [];
  const byId = useMemo(() => new Map(sugs.map((s) => [s.id, s])), [sugs]);

  const doConvert = async (force: boolean) => {
    setConverting(true);
    try {
      const r = await post('/mrp/convert', { suggestion_ids: toConvert, force });
      setResult(r);
      setSelected((s) => s.filter((x) => !toConvert.includes(x)));
      if (runId) await loadRun(runId);
    } finally {
      setConverting(false);
    }
  };

  /** 转单前确认：列出将生成的单据；结果过期时提示先重算 */
  const convert = async () => {
    const st: Rec | null = runId ? await get(`/mrp/runs/${runId}/staleness`, undefined, true).catch(() => null) : null;
    setStale(st);
    const picked = toConvert.map((id) => byId.get(id)).filter(Boolean) as Rec[];
    const buy = picked.filter((s) => s.action === 'PURCHASE');
    const make = picked.filter((s) => s.action === 'PRODUCE');
    const suppliers = [...new Set(buy.map((s) => s.supplier_name || '未设置默认供应商'))];
    const sos = [...new Set(make.flatMap((s) => (s.demand || []).filter((r: Rec) => r.type === 'SO').map((r: Rec) => r.no)))];
    modal.confirm({
      title: st?.stale ? 'MRP 结果已过期，确定仍要转单？' : `确认转单（${picked.length} 条建议）`,
      icon: st?.stale ? <WarningOutlined style={{ color: '#faad14' }} /> : undefined,
      width: 600,
      okText: st?.stale ? '仍然转单' : '确认转单',
      okButtonProps: { danger: !!st?.stale },
      cancelText: '取消',
      content: (
        <div>
          {st?.stale && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="运算之后有以下变化，建议取消后点【重新运行】，避免重复下单/排产："
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{st.reasons.map((t: string) => <li key={t}>{t}</li>)}</ul>} />
          )}
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {buy.length > 0 && (
              <li>采购建议 {buy.length} 条 → 按供应商合并为 <b>{suppliers.length}</b> 张采购单草稿（{suppliers.join('、')}），需审批后发给供应商</li>
            )}
            {make.length > 0 && (
              <li>生产建议 {make.length} 条 → 生成计划工单{sos.length ? `，按需求来源关联订单 ${sos.join('、')}（已被工单/库存覆盖的不重复生成）` : ''}</li>
            )}
          </ul>
        </div>
      ),
      onOk: () => doConvert(!!st?.stale),
    });
  };

  const csSelected = selected.filter((id) => byId.get(id)?.action === 'CUSTOMER_SUPPLY');
  const toConvert = selected.filter((id) => byId.get(id)?.action !== 'CUSTOMER_SUPPLY');
  const [notifying, setNotifying] = useState(false);
  const [notice, setNotice] = useState<Rec | null>(null);
  /** 客供料：生成通知单（按客户分组，可打印/导出发给客户），并标记“已通知” */
  const notifyCustomers = async () => {
    setNotifying(true);
    try {
      const r = await post('/mrp/suggestions/notify', { suggestion_ids: csSelected });
      setNotice(r);
      setSelected((s) => s.filter((x) => !csSelected.includes(x)));
      if (runId) loadRun(runId);
    } finally {
      setNotifying(false);
    }
  };

  const ignore = async (sid: number, ok = '已忽略') => {
    await post(`/mrp/suggestions/${sid}/ignore`);
    message.success(ok);
    setSelected((s) => s.filter((x) => x !== sid));
    if (runId) loadRun(runId);
  };

  const isExp = (s: Rec) => s.exception === 'EXPEDITE';
  const count = (a: string) => (a === 'ALL' ? sugs.length : a === 'EXPEDITE' ? sugs.filter(isExp).length : sugs.filter((s) => s.action === a && !isExp(s)).length);
  // 按物料分组（层级 → 物料编码 → 需求日期 → 催交在前），同一物料的各周建议合并显示物料信息
  const data = useMemo(() => {
    const rows = action === 'ALL' ? sugs : action === 'EXPEDITE' ? sugs.filter(isExp) : sugs.filter((s) => s.action === action && !isExp(s));
    const dateOf = (r: Rec) => String(r.required_date ?? r.due_date ?? '');
    return [...rows].sort(
      (a, b) =>
        a.level - b.level || String(a.material_code).localeCompare(String(b.material_code)) || dateOf(a).localeCompare(dateOf(b)) ||
        (isExp(b) ? 1 : 0) - (isExp(a) ? 1 : 0) || a.id - b.id,
    );
  }, [sugs, action]);
  const spans = useMemo(
    () =>
      data.map((r, i) => {
        if (i > 0 && data[i - 1].material_id === r.material_id) return 0;
        let n = 1;
        while (i + n < data.length && data[i + n].material_id === r.material_id) n++;
        return n;
      }),
    [data],
  );
  const merge = (_: Rec, i?: number) => ({ rowSpan: spans[i ?? 0] ?? 1 });
  const stat = (st: string) => sugs.filter((s) => s.status === st).length;
  const openExp = sugs.filter((s) => isExp(s) && s.status === 'OPEN').length;

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', dataIndex: 'material_code', fixed: 'left', width: 190, onCell: merge,
      render: (v, r, i) => (
        <div>
          <Space size={4}>
            <Tooltip title="层级：0 = 成品（独立需求），数字越大越接近原材料"><Tag style={{ marginInlineEnd: 0 }}>L{r.level}</Tag></Tooltip>
            <span className="mono">{v}</span>
          </Space>
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_name}</Typography.Text></div>
          {spans[i] > 1 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{spans[i]} 条建议</Typography.Text>}
        </div>
      ),
    },
    {
      title: '建议', dataIndex: 'action', width: 92,
      render: (v, r) => (isExp(r) ? <Tooltip title="已有后续在途/在制可以满足，只需催交提前，不用新下单"><Tag color="orange">提前催交</Tag></Tooltip> : <StatusTag dict="mrp_action" value={v} />),
    },
    {
      title: <Tooltip title="ISO 周（周一开始）；需求日期 = 该周最早的需求日（订单交期 / 上层开工日），早于本周的计入本周">周次 / 需求日期</Tooltip>, key: 'req', width: 140,
      render: (_, r) => (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{weekText(r.week)}</Typography.Text>
          <div><DueDate value={r.required_date} overdue={r.status === 'OPEN' && isPast(r.required_date)} hint="需求日期已过（逾期需求）" /></div>
        </div>
      ),
    },
    {
      title: <Tooltip title="需求日期 − 提前期（生产周期 / 采购提前期），不早于今天；催交为要求到货/完工日">建议下单/开工</Tooltip>, dataIndex: 'due_date', width: 110,
      render: (v, r) => <DueDate value={v} overdue={r.status === 'OPEN' && isPast(v)} hint="建议日期已过，请尽快处理" />,
    },
    {
      title: '建议数量', dataIndex: 'suggested_qty', align: 'right', width: 110,
      render: (v, r) => (
        <Tooltip
          title={
            <div>
              毛需求 {fmtQty(r.gross_qty)} + 安全库存 {fmtQty(r.safety_stock)} − 期初预计库存 {fmtQty(r.on_hand_qty)} − 本周在途/在制 {fmtQty(r.on_order_qty)} = 净需求 {fmtQty(r.net_qty)}
              {Math.abs(r.suggested_qty - r.net_qty) > 1e-9 && !isExp(r) && <div>按最小订货量/采购单位/整数取整为 {fmtQty(r.suggested_qty)}</div>}
            </div>
          }
        >
          <b>{fmtQty(v)}</b> <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>{r.uom}</Typography.Text>
          {Math.abs(r.suggested_qty - r.net_qty) > 1e-9 && !isExp(r) && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>净需求 {fmtQty(r.net_qty)}</Typography.Text></div>}
        </Tooltip>
      ),
    },
    {
      title: <Tooltip title="为什么要做/要买：哪张订单、哪张工单、哪个上层计划产生的需求">需求来源</Tooltip>, key: 'refs', width: 280,
      render: (_, r) => {
        const refs: Rec[] = r.demand || [];
        const exp: Rec[] = r.expedite || [];
        if (!refs.length && !exp.length) return <Typography.Text type="secondary">{r.note?.includes('安全库存') ? '补足安全库存' : '-'}</Typography.Text>;
        const head = refs.slice(0, 2);
        const all = (
          <Space direction="vertical" size={2}>
            {exp.map((x, i) => <ExpediteText key={`e${i}`} r={x} />)}
            {refs.map((x, i) => <RefText key={i} r={x} />)}
          </Space>
        );
        return (
          <Space direction="vertical" size={0} style={{ width: 260, fontSize: 13 }}>
            {exp.map((x, i) => <ExpediteText key={`e${i}`} r={x} />)}
            {head.map((x, i) => <RefText key={i} r={x} />)}
            {refs.length > 2 && (
              <Popover content={all} title="需求来源" trigger="click">
                <Typography.Link style={{ fontSize: 12 }}>等 {refs.length} 项，查看全部</Typography.Link>
              </Popover>
            )}
          </Space>
        );
      },
    },
    {
      title: '状态', dataIndex: 'status', width: 150,
      render: (v, r) => {
        const conv: Rec[] = r.converted?.length ? r.converted : r.converted_doc_no ? [{ no: r.converted_doc_no, id: r.converted_doc_id, status: r.converted_doc_status, type: r.converted_doc_kind }] : [];
        const kind = (x: Rec) => (x.type === 'PO' || (r.action === 'PURCHASE' && x.type !== 'WO') ? 'po' : 'wo');
        return (
          <Space direction="vertical" size={0}>
            <StatusTag dict="mrp_status" value={v} />
            {r.notified_at && (
              <Tooltip title={`${r.notified_by ?? ''} ${fmtDateTime(r.notified_at)} 已通知客户供料`}>
                <Tag color="purple" style={{ marginInlineEnd: 0 }}>已通知客户</Tag>
              </Tooltip>
            )}
            {conv.map((x) => (
              <span key={x.no}>
                <DocLink kind={kind(x)} id={x.id} no={x.no} />
                {x.status && ['CANCELLED', 'CLOSED'].includes(x.status) && (
                  <Tooltip title="转出的单据已取消/关闭，需求未被满足，请重新运行 MRP"><Tag color="red" style={{ marginInlineStart: 4 }}>{dictLabel(kind(x) === 'po' ? 'po_status' : 'wo_status', x.status)}</Tag></Tooltip>
                )}
              </span>
            ))}
          </Space>
        );
      },
    },
    {
      title: '供应商 / 客户', key: 'partner', width: 150, ellipsis: true,
      render: (_, r) => {
        if (r.action === 'PURCHASE') return r.supplier_name || <Typography.Text type="warning">未设置默认供应商</Typography.Text>;
        return r.customer_name || '-';
      },
    },
    { title: <Tooltip title="本周毛需求">毛需求</Tooltip>, dataIndex: 'gross_qty', align: 'right', width: 90, render: num },
    {
      title: '备注', dataIndex: 'note', width: 200, ellipsis: { showTitle: false },
      render: (v) => (v ? (
        <Tooltip title={v}><Typography.Text type={String(v).includes('交期紧张') ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{v}</Typography.Text></Tooltip>
      ) : '-'),
    },
  ];
  if (canConvert) {
    columns.push({
      title: '操作', key: 'op', fixed: 'right', width: 76,
      render: (_, r) =>
        r.status === 'OPEN' ? (
          isExp(r) ? (
            <Popconfirm title="已联系供应商/车间提前交货？标记后不再提示。" okText="已处理" cancelText="还没有" onConfirm={() => ignore(r.id, '已标记为已催交')}>
              <Button size="small" type="link">已催交</Button>
            </Popconfirm>
          ) : (
            <Popconfirm title="忽略后此建议不再转单，确定？" okText="忽略" cancelText="不忽略" onConfirm={() => ignore(r.id)}>
              <Button size="small" type="link">忽略</Button>
            </Popconfirm>
          )
        ) : null,
    });
  }

  const createdPos: string[] = result?.purchase_orders || [];
  const createdWos: string[] = result?.work_orders || [];
  const skipped: string[] = result?.skipped || [];

  return (
    <>
      {/* 打印客供料通知单时只打印通知单 */}
      {notice && <style>{'@media print { .mrp-screen { display: none !important; } }'}</style>}
      <div className="mrp-screen">
      <PageHeader
        title="MRP 物料需求计划"
        sub="根据已确认的销售订单与在制工单，算出要生产什么、要采购什么、要催什么、要通知客户供什么料。"
        extra={
          canRun && (
            <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={doRun}>
              运行 MRP
            </Button>
          )
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
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
                    <Statistic title="其中催交" value={openExp} valueStyle={{ color: openExp ? '#d46b08' : undefined }} />
                    <Statistic title="已转单" value={stat('CONVERTED')} valueStyle={{ color: '#389e0d' }} />
                    <Statistic title="已忽略" value={stat('IGNORED')} />
                  </Space>
                </Col>
              </Row>
              {stale?.stale && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="这次运算结果已过期：之后订单/工单/采购/库存有变化，直接转单可能重复下单或重复排产"
                  description={<ul style={{ margin: 0, paddingLeft: 18 }}>{stale.reasons.map((t: string) => <li key={t}>{t}</li>)}</ul>}
                  action={canRun && <Button size="small" type="primary" icon={<ReloadOutlined />} loading={running} onClick={doRun}>重新运行</Button>}
                />
              )}
            </Card>
            <Card size="small">
              <Space wrap style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
                <Segmented
                  value={action}
                  onChange={(v) => setAction(v as string)}
                  options={ACTIONS.map((a) => ({ value: a.value, label: `${a.label}（${count(a.value)}）` }))}
                />
                <Space wrap>
                  <ExportButton
                    rows={data}
                    filename={`MRP建议_${run?.no ?? ''}`}
                    columns={[
                      { title: '层级', key: 'level', type: 'number' },
                      { title: '物料编码', key: 'material_code' },
                      { title: '物料名称', key: 'material_name' },
                      { title: '建议', value: (r) => (isExp(r) ? '提前催交' : dictLabel('mrp_action', r.action)) },
                      { title: '周次', key: 'week' },
                      { title: '需求日期', key: 'required_date', type: 'date' },
                      { title: '建议下单/开工', key: 'due_date', type: 'date' },
                      { title: '建议数量', key: 'suggested_qty', type: 'number' },
                      { title: '单位', key: 'uom' },
                      { title: '毛需求', key: 'gross_qty', type: 'number' },
                      { title: '期初预计库存', key: 'on_hand_qty', type: 'number' },
                      { title: '本周在途/在制', key: 'on_order_qty', type: 'number' },
                      { title: '安全库存', key: 'safety_stock', type: 'number' },
                      { title: '净需求', key: 'net_qty', type: 'number' },
                      { title: '供应商/客户', value: (r) => r.supplier_name || r.customer_name || '' },
                      { title: '需求来源', value: refsPlain, width: 60 },
                      { title: '状态', value: (r) => dictLabel('mrp_status', r.status) },
                      { title: '转出单据', value: (r) => (r.converted?.length ? r.converted.map((x: Rec) => x.no).join('、') : r.converted_doc_no || '') },
                      { title: '备注', key: 'note', width: 40 },
                    ]}
                  />
                  {canConvert && csSelected.length > 0 && (
                    <Button icon={<NotificationOutlined />} loading={notifying} onClick={notifyCustomers}>
                      生成客供料通知（{csSelected.length}）
                    </Button>
                  )}
                  {canConvert && (
                    <Button type="primary" icon={<SwapOutlined />} disabled={!toConvert.length} loading={converting} onClick={convert}>
                      一键转单{toConvert.length ? `（${toConvert.length}）` : ''}
                    </Button>
                  )}
                </Space>
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
                          getCheckboxProps: (r: Rec) => ({ disabled: r.status !== 'OPEN' || isExp(r) }),
                        }
                      : undefined
                  }
                />
              </Spin>
            </Card>
          </>
        )}
        <Collapse
          size="small"
          items={[
            {
              key: 'how',
              label: 'MRP 怎么算？（点开查看）',
              children: (
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  按周（ISO 周）逐周净算：独立需求 = 已确认销售订单的未发货数量（按交期）；采购在途按供应商回复交期/预计到货日、在制工单按计划完工日计入当周；
                  每周 净需求 = 毛需求 + 安全库存 − 期初预计库存 − 本周在途/在制。出现缺口时，<b>先看后续各周有没有已下的采购单/工单可以提前</b>（给出“提前催交”，不新建单据），
                  仍不够才建议新下单；建议数量按整数（PCS 等离散单位）、最小订货量、采购单位取整，多出的结转到后续各周。自制件的下层组件需求日期 = 上层开工日；外购件建议下单日 = 需求日期 − 采购提前期。
                  生产建议转工单时按“需求来源”关联销售订单（订单上的【生成工单】也会扣除这些工单，不会重复排产）。运算后订单、工单、采购或库存有变化，转单前会提示重新运行。
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      </Space>

      </div>
      <ResultModal result={result} onClose={() => setResult(null)} createdPos={createdPos} createdWos={createdWos} skipped={skipped} />
      <CsNoticeModal notice={notice} onClose={() => setNotice(null)} />
    </>
  );
}

function ResultModal({ result, onClose, createdPos, createdWos, skipped }: { result: Rec | null; onClose: () => void; createdPos: string[]; createdWos: string[]; skipped: string[] }) {
  return (
    <Modal open={!!result} title="一键转单结果" onCancel={onClose} footer={<Button type="primary" onClick={onClose}>知道了</Button>}>
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
              已生成 <b>{createdWos.length}</b> 张生产工单（计划状态，已关联来源订单），请下达后生产：
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
  );
}

/** 客户供料通知单（按客户分组；打印发给客户，或导出 Excel 发邮件） */
function CsNoticeBody({ n, printing }: { n: Rec; printing?: boolean }) {
  const cell = { border: '1px solid #000', padding: '3px 6px', fontSize: 11 } as const;
  return (
    <div style={printing ? { breakAfter: 'page' } : { marginBottom: 16 }}>
      {printing ? (
        <PrintHeader title="客供料需求通知 Customer-Supplied Material Request" extra={<div>通知人：{n._by}</div>} />
      ) : (
        <Typography.Title level={5} style={{ marginTop: 0 }}>{n.customer_name ?? '（未指定货主客户）'}</Typography.Title>
      )}
      {printing && <p style={{ fontSize: 12 }}>致 To：{n.customer_name}{n.contact ? `　${n.contact}` : ''}{n.phone ? `　${n.phone}` : ''}{n.email ? `　${n.email}` : ''}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>{['物料编码', '名称 / 规格', '需求数量', '单位', '最迟到料日', '需求日期', '对应订单'].map((h) => <th key={h} style={{ ...cell, background: '#f0f0f0' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {(n.items as Rec[]).map((i) => (
            <tr key={i.suggestion_id}>
              <td style={cell}>{i.material_code}</td>
              <td style={cell}>{i.material_name}{i.material_spec ? ` / ${i.material_spec}` : ''}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmtQty(i.qty)}</td>
              <td style={cell}>{i.uom}</td>
              <td style={cell}>{fmtDate(i.latest_arrival)}</td>
              <td style={cell}>{fmtDate(i.required_date)}</td>
              <td style={cell}>{(i.for_orders || []).join('、') || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {printing && <p style={{ fontSize: 11, marginTop: 8 }}>请在“最迟到料日”前送达，送货单注明物料编码与批号；如不能按期供料请尽快告知，以免影响贵司订单交期。</p>}
    </div>
  );
}

function CsNoticeModal({ notice, onClose }: { notice: Rec | null; onClose: () => void }) {
  const notices: Rec[] = (notice?.notices || []).map((n: Rec) => ({ ...n, _by: notice?.notified_by }));
  const rows = notices.flatMap((n) => (n.items as Rec[]).map((i) => ({ ...i, customer_name: n.customer_name })));
  return (
    <>
      {notice && (
        <div className="print-only">
          {notices.map((n) => <CsNoticeBody key={n.customer_id ?? 0} n={n} printing />)}
        </div>
      )}
      <Modal
        open={!!notice}
        wrapClassName="no-print"
        width={900}
        title={`客供料通知已生成（${notices.length} 个客户，已标记“已通知”）`}
        onCancel={onClose}
        footer={[
          <ExportButton
            key="x"
            rows={rows}
            filename="客供料需求通知"
            columns={[
              { title: '客户', key: 'customer_name' }, { title: '物料编码', key: 'material_code' }, { title: '名称', key: 'material_name' },
              { title: '规格', key: 'material_spec' }, { title: '需求数量', key: 'qty', type: 'number' }, { title: '单位', key: 'uom' },
              { title: '最迟到料日', key: 'latest_arrival', type: 'date' }, { title: '需求日期', key: 'required_date', type: 'date' },
              { title: '对应订单', value: (r) => (r.for_orders || []).join('、') },
            ]}
          />,
          <PrintButton key="p" text="打印通知单" />,
          <Button key="ok" type="primary" onClick={onClose}>完成</Button>,
        ]}
      >
        {notices.map((n) => <CsNoticeBody key={n.customer_id ?? 0} n={n} />)}
      </Modal>
    </>
  );
}
