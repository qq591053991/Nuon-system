import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Input, Modal, Popconfirm, Progress, Result, Row, Select, Space, Spin,
  Steps, Table, Tooltip, Typography, message, type TableColumnsType,
} from 'antd';
import { ArrowLeftOutlined, CarOutlined, CheckOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { CustomerSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, toDate } from '../../utils/format';
import {
  CURRENCY_OPTIONS, DueDate, OrderLinesEditor, QtyProgress, checkLines, isPast, linesBody, sumBy, toDayjs, uid, type LineRow,
} from './shared';

const ACTIVE = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'];
const STEP_OF: Record<string, number> = { DRAFT: 0, CONFIRMED: 1, IN_PRODUCTION: 2, PARTIAL_SHIPPED: 3, SHIPPED: 4, CLOSED: 4 };

const NEXT_HINT: Record<string, string> = {
  DRAFT: '草稿可随时修改；确认后订单锁定并进入生产计划（MRP 只统计已确认订单）。',
  CONFIRMED: '下一步：点击【一键生成工单】，系统按已发布的 BOM 为每个订单行生成生产工单。',
  IN_PRODUCTION: '生产进行中。成品完工入库并经 QA 审核 DHR 放行后，即可点击【发货】。',
  PARTIAL_SHIPPED: '已部分发货。剩余数量放行后可继续发货；如客户不再需要，可【关闭（短交结案）】。',
  SHIPPED: '订单已全部发货，应收账款已自动生成（见“应收应付”）。',
  CLOSED: '订单已关闭，不再发货。',
};

function SoSteps({ so }: { so: Rec | null }) {
  const st = so?.status || 'DRAFT';
  if (st === 'CANCELLED') return <Alert type="warning" showIcon message="订单已取消" />;
  const qty = sumBy(so?.lines, 'qty');
  const shipped = sumBy(so?.lines, 'shipped_qty');
  const wos = (so?.work_orders || []).filter((w: Rec) => w.status !== 'CANCELLED');
  const finished = ['CONFIRMED', 'SHIPPED', 'CLOSED'].includes(st);
  return (
    <>
      <Steps
        size="small"
        current={STEP_OF[st] ?? 0}
        status={finished ? 'finish' : 'process'}
        items={[
          { title: '草稿', description: '录入订单' },
          { title: '确认', description: '锁定订单' },
          { title: '生产', description: wos.length ? `工单 ${wos.length} 张` : '生成工单' },
          { title: '发货', description: shipped > 0 ? `已发 ${fmtQty(shipped)}/${fmtQty(qty)}` : '放行后发货' },
          { title: '完成', description: st === 'CLOSED' ? '已关闭' : st === 'SHIPPED' ? '全部发货' : undefined },
        ]}
      />
      {NEXT_HINT[st] && <Alert type="info" showIcon message={NEXT_HINT[st]} style={{ marginTop: 16 }} />}
    </>
  );
}

// ---------------- 编辑（新建 / 草稿） ----------------
function SoEditor({ so, onSaved }: { so: Rec | null; onSaved: (d: Rec) => void }) {
  const nav = useNavigate();
  const [form] = Form.useForm();
  const [lines, setLines] = useState<LineRow[]>(() =>
    so?.lines?.length ? so.lines.map((l: Rec) => ({ ...l, _key: uid() })) : [{ _key: uid() }],
  );
  const [busy, setBusy] = useState<string>();
  const currency: string = Form.useWatch('currency', form) || so?.currency || 'CNY';
  const delivery = Form.useWatch('delivery_date', form);

  const save = async (andConfirm: boolean) => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const err = checkLines(lines, '产品');
    if (err) {
      message.error(err);
      return;
    }
    const body = { ...v, order_date: toDate(v.order_date), delivery_date: toDate(v.delivery_date), lines: linesBody(lines, 'delivery_date') };
    setBusy(andConfirm ? 'confirm' : 'save');
    let saved: Rec | null = null;
    try {
      saved = so ? await put(`/sales-orders/${so.id}`, body) : await post('/sales-orders', body);
      if (andConfirm) {
        await post(`/sales-orders/${saved!.id}/confirm`);
        message.success('订单已确认，下一步：一键生成生产工单');
      } else {
        message.success('草稿已保存');
      }
    } finally {
      setBusy(undefined);
      if (saved) onSaved(saved);
    }
  };

  const cancelOrder = async () => {
    setBusy('cancel');
    try {
      const d = await post(`/sales-orders/${so!.id}/cancel`);
      message.success('订单已取消');
      onSaved(d);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title={so ? <Space>销售订单 {so.no}<StatusTag dict="so_status" value={so.status} /></Space> : '新建销售订单'}
        sub={so ? `创建人 ${so.created_by ?? '-'} · ${fmtDateTime(so.created_at)}` : '选择客户与产品，填写数量、单价和交期'}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/sales/orders')}>返回列表</Button>
            {so && (
              <Popconfirm title="确定取消该订单？取消后不可恢复。" onConfirm={cancelOrder}>
                <Button danger loading={busy === 'cancel'}>取消订单</Button>
              </Popconfirm>
            )}
            <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy && busy !== 'save'} onClick={() => save(false)}>保存草稿</Button>
            <Button type="primary" icon={<CheckOutlined />} loading={busy === 'confirm'} disabled={!!busy && busy !== 'confirm'} onClick={() => save(true)}>
              保存并确认订单
            </Button>
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small"><SoSteps so={so} /></Card>
        <Card title="订单信息" size="small">
          <Form
            form={form}
            layout="vertical"
            initialValues={
              so
                ? {
                    customer_id: so.customer_id, order_date: toDayjs(so.order_date), delivery_date: toDayjs(so.delivery_date),
                    customer_po: so.customer_po, currency: so.currency, ship_to: so.ship_to, remark: so.remark,
                  }
                : { order_date: dayjs(), currency: 'CNY' }
            }
          >
            <Row gutter={16}>
              <Col xs={24} md={12} lg={8}>
                <Form.Item name="customer_id" label="客户（品牌方/注册人）" rules={[{ required: true, message: '请选择客户' }]}>
                  <CustomerSelect
                    onPick={(c) => {
                      if (!c) return;
                      form.setFieldsValue({ currency: c.currency || 'CNY' });
                      if (!form.getFieldValue('ship_to') && c.address) form.setFieldsValue({ ship_to: c.address });
                    }}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="order_date" label="下单日期"><DatePicker style={{ width: '100%' }} allowClear={false} /></Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="delivery_date" label="交期" tooltip="订单行未单独填写交期时，按此日期排产">
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="customer_po" label="客户PO号"><Input placeholder="客户采购单号" /></Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="currency" label="币别"><Select options={CURRENCY_OPTIONS} /></Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="ship_to" label="收货地址"><Input placeholder="默认带出客户地址" /></Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="remark" label="备注"><Input /></Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        <Card title="订单明细" size="small" extra={<Typography.Text type="secondary">代工产品只能销售给该产品的注册人/品牌方</Typography.Text>}>
          <OrderLinesEditor
            value={lines}
            onChange={setLines}
            dateField="delivery_date"
            dateLabel="交期"
            currency={currency}
            materialLabel="产品"
            materialParams={{ category: 'FINISHED' }}
            defaultDate={delivery ? dayjs(delivery).format('YYYY-MM-DD') : null}
          />
        </Card>
      </Space>
    </>
  );
}

// ---------------- 查看（已确认及之后） ----------------
function SoView({ so, reload }: { so: Rec; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string>();
  const [woResult, setWoResult] = useState<Rec | null>(null);
  const st: string = so.status;
  const active = ACTIVE.includes(st);
  const wos: Rec[] = so.work_orders || [];
  const shipments: Rec[] = so.shipments || [];
  const liveWos = wos.filter((w) => w.status !== 'CANCELLED');
  const plannedOf = (lineId: number) => sumBy(liveWos.filter((w) => w.so_line_id === lineId), 'planned_qty');
  const uncovered = (so.lines as Rec[]).some((l) => l.qty - plannedOf(l.id) > 1e-9);

  const act = async (key: string, url: string, ok: string) => {
    setBusy(key);
    try {
      await post(url);
      message.success(ok);
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const createWo = async () => {
    setBusy('wo');
    try {
      const r = await post(`/sales-orders/${so.id}/create-work-orders`);
      await reload();
      setWoResult(r);
    } finally {
      setBusy(undefined);
    }
  };

  const lineCols: TableColumnsType<Rec> = [
    { title: '行号', dataIndex: 'line_no', width: 60 },
    { title: '产品编码', dataIndex: 'material_code', render: (v) => <span className="mono">{v}</span> },
    { title: '产品名称', dataIndex: 'material_name' },
    { title: '规格', dataIndex: 'material_spec', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '单位', dataIndex: 'uom' },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '单价', dataIndex: 'unit_price', align: 'right', render: (v) => fmtMoney(v, so.currency) },
    { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => fmtMoney(v, so.currency) },
    {
      title: '交期', dataIndex: 'delivery_date',
      render: (v, l) => {
        const d = v || so.delivery_date;
        return <DueDate value={d} overdue={active && isPast(d) && (l.shipped_qty || 0) < l.qty} hint="交期已过，尚未发完" />;
      },
    },
    ...(liveWos.length ? [{ title: '已排产', key: 'planned', align: 'right' as const, render: (_: any, l: Rec) => fmtQty(plannedOf(l.id)) }] : []),
    { title: '发货进度', key: 'ship', render: (_, l) => <QtyProgress done={l.shipped_qty || 0} total={l.qty} /> },
    { title: '备注', dataIndex: 'remark', render: (v) => v || '-' },
  ];

  const woCols: TableColumnsType<Rec> = [
    { title: '工单号', dataIndex: 'no', render: (v, w) => <Link to={`/mes/work-orders/${w.id}`} className="mono">{v}</Link> },
    { title: '产品', key: 'm', render: (_, w) => `${w.material_code} ${w.material_name}` },
    { title: '计划数量', dataIndex: 'planned_qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '完工数量', dataIndex: 'completed_qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '进度', dataIndex: 'progress', width: 160, render: (v) => <Progress percent={v || 0} size="small" style={{ margin: 0 }} /> },
    { title: '生产批号', dataIndex: 'lot_no', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '工单状态', dataIndex: 'status', render: (v) => <StatusTag dict="wo_status" value={v} /> },
    { title: '放行状态', dataIndex: 'dhr_status', render: (v) => <StatusTag dict="dhr_status" value={v} /> },
    { title: '计划完工', dataIndex: 'planned_end', render: fmtDate },
  ];

  const shipCols: TableColumnsType<Rec> = [
    { title: '发货单号', dataIndex: 'no', render: (v) => <Link to={`/wms/shipments?q=${encodeURIComponent(v)}`} className="mono">{v}</Link> },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="doc_status" value={v} /> },
    { title: '发货日期', dataIndex: 'ship_date', render: fmtDate },
    { title: '承运商', dataIndex: 'carrier', render: (v) => v || '-' },
    { title: '运单号', dataIndex: 'tracking_no', render: (v) => (v ? <Typography.Text copyable>{v}</Typography.Text> : '-') },
    { title: '发货人', dataIndex: 'shipped_by', render: (v) => v || '-' },
  ];

  const created: string[] = woResult?.work_orders || [];
  const skipped: string[] = woResult?.skipped || [];
  const woPrimary = st === 'CONFIRMED' && uncovered;

  return (
    <>
      <PageHeader
        title={<Space>销售订单 {so.no}<StatusTag dict="so_status" value={st} /></Space>}
        sub={`${so.customer_name ?? ''}${so.customer_po ? ` · 客户PO ${so.customer_po}` : ''}`}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/sales/orders')}>返回列表</Button>
            {st === 'CONFIRMED' && can('sales') && (
              <Popconfirm title="确定取消该订单？" onConfirm={() => act('cancel', `/sales-orders/${so.id}/cancel`, '订单已取消')}>
                <Button danger loading={busy === 'cancel'}>取消订单</Button>
              </Popconfirm>
            )}
            {active && can('sales') && (
              <Popconfirm title="关闭后订单不再发货，未发数量按短交结案。确定关闭？" onConfirm={() => act('close', `/sales-orders/${so.id}/close`, '订单已关闭')}>
                <Button loading={busy === 'close'}>关闭（短交结案）</Button>
              </Popconfirm>
            )}
            {active && can('plan') && (
              <Tooltip title={uncovered ? '按已发布 BOM 为未排产的订单行生成工单' : '所有订单行均已生成工单'}>
                <Button type={woPrimary ? 'primary' : 'default'} icon={<ThunderboltOutlined />} loading={busy === 'wo'} disabled={!uncovered} onClick={createWo}>
                  一键生成工单
                </Button>
              </Tooltip>
            )}
            {active && can('wms', 'sales') && (
              <Button type={woPrimary ? 'default' : 'primary'} icon={<CarOutlined />} onClick={() => nav(`/wms/shipments?so_id=${so.id}&new=1`)}>
                发货
              </Button>
            )}
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small"><SoSteps so={so} /></Card>
        <Card size="small" title="订单信息">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: 'customer', label: '客户', children: so.customer_name },
              { key: 'po', label: '客户PO号', children: so.customer_po || '-' },
              { key: 'amount', label: '订单金额', children: <b>{fmtMoney(so.total_amount, so.currency)}</b> },
              { key: 'order_date', label: '下单日期', children: fmtDate(so.order_date) },
              {
                key: 'delivery', label: '交期',
                children: <DueDate value={so.delivery_date} overdue={active && isPast(so.delivery_date)} hint="交期已过，订单尚未发完" />,
              },
              { key: 'currency', label: '币别', children: so.currency },
              { key: 'ship_to', label: '收货地址', children: so.ship_to || '-' },
              { key: 'creator', label: '创建', children: `${so.created_by ?? '-'} · ${fmtDateTime(so.created_at)}` },
              { key: 'remark', label: '备注', children: so.remark || '-' },
            ]}
          />
        </Card>
        <Card size="small" title="订单明细">
          <Table rowKey="id" size="middle" columns={lineCols} dataSource={so.lines} pagination={false} scroll={{ x: 'max-content' }} />
        </Card>
        <Card size="small" title={`生产工单（${liveWos.length}）`}>
          {wos.length ? (
            <Table rowKey="id" size="middle" columns={woCols} dataSource={wos} pagination={false} scroll={{ x: 'max-content' }} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={active ? '还没有生产工单，点击右上角【一键生成工单】' : '无生产工单'} />
          )}
        </Card>
        <Card size="small" title={`发货记录（${shipments.length}）`}>
          {shipments.length ? (
            <Table rowKey="id" size="middle" columns={shipCols} dataSource={shipments} pagination={false} scroll={{ x: 'max-content' }} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发货" />
          )}
        </Card>
      </Space>

      <Modal
        open={!!woResult}
        title="一键生成工单结果"
        onCancel={() => setWoResult(null)}
        footer={[
          <Button key="list" onClick={() => nav('/mes/work-orders')}>前往生产工单</Button>,
          <Button key="ok" type="primary" onClick={() => setWoResult(null)}>知道了</Button>,
        ]}
      >
        {created.length > 0 && (
          <>
            <Typography.Paragraph>
              已生成 <b>{created.length}</b> 张生产工单（计划状态），请在工单页面【下达】后开始生产：
            </Typography.Paragraph>
            <Space wrap>
              {created.map((no) => {
                const w = wos.find((x) => x.no === no);
                return w ? <Link key={no} to={`/mes/work-orders/${w.id}`} className="mono">{no}</Link> : <span key={no} className="mono">{no}</span>;
              })}
            </Space>
          </>
        )}
        {!created.length && !skipped.length && <Alert type="info" showIcon message="所有订单行均已生成工单，无需重复生成" />}
        {skipped.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: created.length ? 16 : 0 }}
            message="以下订单行未生成工单"
            description={
              <>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{skipped.map((s) => <li key={s}>{s}</li>)}</ul>
                <Link to="/engineering/boms">前往 BOM 维护 →</Link>
              </>
            }
          />
        )}
      </Modal>
    </>
  );
}

export default function SalesOrderDetail() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const { can } = useAuth();
  const [so, setSo] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (isNew) {
      setSo(null);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      setSo(await get(`/sales-orders/${id}`));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    setSo(null);
    load();
  }, [load]);

  if (isNew && !can('sales')) return <Result status="403" title="没有新建销售订单的权限" extra={<Button onClick={() => nav('/sales/orders')}>返回列表</Button>} />;
  if (failed && !so) return <Result status="404" title="销售订单不存在或无法加载" extra={<Button onClick={() => nav('/sales/orders')}>返回列表</Button>} />;
  if (!isNew && !so) return <Spin style={{ display: 'block', padding: 80 }} />;

  if (isNew || (so!.status === 'DRAFT' && can('sales'))) {
    return (
      <SoEditor
        key={so?.id ?? 'new'}
        so={so}
        onSaved={(d) => (isNew ? nav(`/sales/orders/${d.id}`, { replace: true }) : load())}
      />
    );
  }
  return (
    <Spin spinning={loading}>
      <SoView so={so!} reload={load} />
    </Spin>
  );
}
