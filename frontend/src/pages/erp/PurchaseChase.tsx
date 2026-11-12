/** 催货清单：未到齐的采购订单行，按逾期天数排序；可直接登记供应商回复交期（留痕） */
import {
  Alert, Button, Card, Col, DatePicker, Form, Input, Popover, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography, message,
  type TableColumnsType,
} from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { PrintButton, PrintHeader } from '../../components/Print';
import { usePaged } from '../../components/usePaged';
import { fmtDate, fmtMoney, fmtQty } from '../../utils/format';
import { QualifiedSupplierSelect } from './purchaseKit';

const STATE: Record<string, [string, string]> = {
  OVERDUE: ['逾期', 'red'],
  DUE_SOON: ['3 天内到期', 'orange'],
  ON_TRACK: ['未到期', 'blue'],
  NO_DATE: ['未定交期', 'default'],
};
const VIEWS = [
  { value: 'OVERDUE', label: '逾期未到' },
  { value: 'OVERDUE,DUE_SOON', label: '逾期 + 3 天内到期' },
  { value: 'DUE_SOON', label: '3 天内到期' },
  { value: 'NO_DATE', label: '未定交期' },
  { value: '', label: '全部未到齐' },
];

/** 登记供应商回复交期（变更原因默认“供应商回复交期”，可改） */
function PromiseEditor({ row, onDone }: { row: Rec; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSaving(true);
    try {
      await post(`/purchase-orders/${row.po_id}/change`, { reason: v.reason, lines: [{ id: row.id, promised_date: v.promised_date ? v.promised_date.format('YYYY-MM-DD') : null }] });
      message.success(`${row.po_no} 第 ${row.line_no} 行回复交期已登记`);
      setOpen(false);
      onDone();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) form.setFieldsValue({ promised_date: row.promised_date ? dayjs(row.promised_date) : null, reason: '供应商回复交期' });
      }}
      trigger="click"
      title={`回复交期 · ${row.po_no} 第 ${row.line_no} 行 ${row.material_code}`}
      content={
        <Form form={form} layout="vertical" style={{ width: 280 }} onFinish={submit}>
          <Form.Item name="promised_date" label="供应商回复交期" style={{ marginBottom: 8 }}>
            <DatePicker style={{ width: '100%' }} autoFocus />
          </Form.Item>
          <Form.Item name="reason" label="变更原因（留痕）" rules={[{ required: true, min: 2, message: '请填写变更原因' }]} style={{ marginBottom: 8 }}>
            <Input />
          </Form.Item>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setOpen(false)}>取消</Button>
            <Button size="small" type="primary" htmlType="submit" loading={saving}>保存</Button>
          </Space>
        </Form>
      }
    >
      <Tooltip title="登记/修改供应商回复交期">
        <Button type="link" size="small" icon={<EditOutlined />} className="no-print">
          {row.promised_date ? fmtDate(row.promised_date) : '登记'}
        </Button>
      </Tooltip>
    </Popover>
  );
}

export default function PurchaseChase() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const initState = sp.get('state') ?? (sp.get('overdue') === '1' ? 'OVERDUE' : 'OVERDUE,DUE_SOON');
  const init = { state: initState || undefined, supplier_id: sp.get('supplier_id') ? Number(sp.get('supplier_id')) : undefined, q: sp.get('q') || undefined };
  const { rows, loading, setQuery, reload, pagination, query, onTableChange, total } = usePaged('/purchase/chase', init, 50);
  const [counts, setCounts] = useState<Rec | null>(null);
  const [view, setView] = useState<string>(initState);
  // 统计卡（逾期/即将到期/未定交期/全部）：随供应商、关键字筛选刷新
  const loadCounts = useCallback(() => {
    get('/purchase/chase', { page_size: 1, supplier_id: query.supplier_id, q: query.q }, true).then((d) => setCounts(d.counts)).catch(() => undefined);
  }, [query.supplier_id, query.q]);
  useEffect(() => {
    loadCounts();
  }, [loadCounts]);
  const refresh = () => {
    reload();
    loadCounts();
  };

  const columns: TableColumnsType<Rec> = [
    {
      title: '应到日期', dataIndex: 'due_date', sorter: true, fixed: 'left', width: 120,
      render: (v, r) => (
        <div>
          <span style={{ color: r.state === 'OVERDUE' ? '#cf1322' : undefined, fontWeight: r.state === 'OVERDUE' ? 600 : undefined }}>{fmtDate(v)}</span>
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{r.promised_date ? '按供应商回复' : '按预计到货'}</Typography.Text>
        </div>
      ),
    },
    {
      title: '逾期天数', dataIndex: 'overdue_days', sorter: true, align: 'right', width: 100,
      render: (v, r) =>
        r.state === 'OVERDUE' ? <b style={{ color: '#cf1322' }}>{v} 天</b> : r.days_to_due !== null && r.days_to_due !== undefined ? <span>还有 {r.days_to_due} 天</span> : '-',
    },
    { title: '状态', dataIndex: 'state', width: 110, render: (v) => <Tag color={STATE[v]?.[1]}>{STATE[v]?.[0] ?? v}</Tag> },
    {
      title: '采购单', dataIndex: 'po_no', sorter: true,
      render: (v, r) => (
        <div>
          <Link to={`/purchase/orders/${r.po_id}`} className="mono">{v}</Link>
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>第 {r.line_no} 行 · 下单 {fmtDate(r.order_date)}</Typography.Text>
        </div>
      ),
    },
    {
      title: '供应商', dataIndex: 'supplier_name', sorter: true, width: 220,
      render: (v, r) => (
        <div>
          <div>{v}</div>
          {(r.supplier_contact || r.supplier_phone) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{[r.supplier_contact, r.supplier_phone].filter(Boolean).join(' ')}</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '物料', dataIndex: 'material_code', sorter: true, width: 240,
      render: (v, r) => (
        <div>
          <span className="mono">{v}</span> {r.material_name}
          {r.material_spec && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{r.material_spec}</Typography.Text>}
        </div>
      ),
    },
    {
      title: '未交数量', dataIndex: 'open_qty', sorter: true, align: 'right',
      render: (v, r) => (
        <div>
          <b>{fmtQty(v)}</b> {r.uom}
          {r.purchase_uom && r.open_purchase_qty !== null && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>≈ {fmtQty(r.open_purchase_qty)} {r.purchase_uom}</Typography.Text>}
        </div>
      ),
    },
    { title: '已收 / 订购', key: 'recv', align: 'right', render: (_, r) => `${fmtQty(r.received_qty)} / ${fmtQty(r.qty)}` },
    { title: '未交金额', dataIndex: 'open_amount', sorter: true, align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: '预计到货', dataIndex: 'expected_date', sorter: true, render: fmtDate },
    {
      title: '供应商回复交期', dataIndex: 'promised_date', sorter: true, width: 140,
      render: (v, r) => (can('purchase') ? <PromiseEditor row={r} onDone={refresh} /> : fmtDate(v)),
    },
    {
      title: <Tooltip title="缺这种料的未完工工单（齐套分析口径），催货时可告诉供应商影响哪张工单">影响工单</Tooltip>, key: 'affected', width: 170,
      render: (_, r) =>
        r.affected_wos?.length ? (
          <Space direction="vertical" size={0}>
            {(r.affected_wos as Rec[]).map((w) => (
              <span key={w.wo_id}>
                <Link to={`/mes/work-orders/${w.wo_id}?tab=kitting`} className="mono">{w.wo_no}</Link>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}> 缺 {fmtQty(w.shortage)}{w.planned_start ? ` · ${fmtDate(w.planned_start).slice(5)} 开工` : ''}</Typography.Text>
              </span>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    { title: '最近到货', dataIndex: 'last_receipt_date', render: (v) => (v ? fmtDate(v) : '-') },
    { title: '采购员', dataIndex: 'buyer', render: (v) => v || '-' },
  ];

  const exportCols = [
    { title: '状态', value: (r: Rec) => STATE[r.state]?.[0] ?? r.state },
    { title: '应到日期', key: 'due_date', type: 'date' as const },
    { title: '逾期天数', key: 'overdue_days', type: 'number' as const },
    { title: '采购单号', key: 'po_no' },
    { title: '行号', key: 'line_no', type: 'number' as const },
    { title: '下单日期', key: 'order_date', type: 'date' as const },
    { title: '供应商', key: 'supplier_name', width: 28 },
    { title: '联系人', key: 'supplier_contact' },
    { title: '电话', key: 'supplier_phone' },
    { title: '物料编码', key: 'material_code', width: 18 },
    { title: '物料名称', key: 'material_name', width: 20 },
    { title: '规格', key: 'material_spec', width: 24 },
    { title: '单位', key: 'uom' },
    { title: '订购数量', key: 'qty', type: 'number' as const },
    { title: '已收数量', key: 'received_qty', type: 'number' as const },
    { title: '未交数量', key: 'open_qty', type: 'number' as const },
    { title: '未交金额', key: 'open_amount', type: 'money' as const },
    { title: '影响工单', value: (r: Rec) => ((r.affected_wos || []) as Rec[]).map((w) => `${w.wo_no}缺${w.shortage}`).join('、'), width: 30 },
    { title: '币别', key: 'currency' },
    { title: '预计到货', key: 'expected_date', type: 'date' as const },
    { title: '供应商回复交期', key: 'promised_date', type: 'date' as const },
    { title: '最近到货', key: 'last_receipt_date', type: 'date' as const },
    { title: '采购员', key: 'buyer' },
  ];

  const stat = (title: string, value: number | undefined, color: string | undefined, v: string, suffix?: string) => (
    <Col xs={12} md={6}>
      <Card size="small" hoverable onClick={() => { setView(v); setQuery({ state: v || undefined }); }} style={{ borderColor: view === v ? '#722ed1' : undefined }}>
        <Statistic title={title} value={value ?? '-'} valueStyle={{ color }} suffix={suffix ? <span style={{ fontSize: 13, color: '#8c8c8c', marginLeft: 8 }}>{suffix}</span> : undefined} />
      </Card>
    </Col>
  );

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="催货清单"
          sub="所有已审批、尚未到齐的采购订单行。应到日期 = 供应商回复交期（未回复则按预计到货）；逾期天数按今天计算。"
          extra={
            <>
              <ExportButton url="/purchase/chase" params={{ ...query, sort: undefined, order: undefined }} filename={`催货清单_${dayjs().format('YYYYMMDD')}`} columns={exportCols} />
              <PrintButton landscape title="催货清单" />
              <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
            </>
          }
        />
      </div>
      <PrintHeader title="催货清单" extra={<div>{VIEWS.find((x) => x.value === view)?.label ?? ''}</div>} />
      <Row gutter={16} style={{ marginBottom: 16 }} className="no-print">
        {stat('逾期未到（行）', counts?.overdue, counts?.overdue ? '#cf1322' : undefined, 'OVERDUE', counts?.suppliers ? `涉及 ${counts.suppliers} 家供应商` : undefined)}
        {stat('3 天内到期（行）', counts?.due_soon, counts?.due_soon ? '#d48806' : undefined, 'DUE_SOON')}
        {stat('未定交期（行）', counts?.no_date, undefined, 'NO_DATE')}
        {stat('全部未到齐（行）', counts?.total, undefined, '')}
      </Row>
      <Card>
        <Space wrap style={{ marginBottom: 16 }} className="no-print">
          <Segmented
            value={view}
            options={VIEWS}
            onChange={(v) => {
              setView(String(v));
              setQuery({ state: String(v) || undefined });
            }}
          />
          <QualifiedSupplierSelect style={{ width: 260 }} placeholder="按供应商筛选" defaultValue={init.supplier_id} onChange={(v) => setQuery({ supplier_id: v })} />
          <Input.Search allowClear placeholder="采购单号 / 物料编码或名称" defaultValue={init.q || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
        </Space>
        {total === 0 && !loading && view === 'OVERDUE' && <Alert type="success" showIcon message="没有逾期未到的采购订单行" style={{ marginBottom: 12 }} />}
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          onChange={onTableChange}
          scroll={{ x: 'max-content' }}
          onRow={(r) => ({ style: r.state === 'OVERDUE' ? { background: '#fff7f6' } : undefined })}
        />
      </Card>
    </>
  );
}
