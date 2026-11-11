import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Input, InputNumber, Modal, Popconfirm, Result, Row, Select, Space, Spin,
  Steps, Table, Tag, Typography, message, type TableColumnsType,
} from 'antd';
import { ArrowLeftOutlined, AuditOutlined, ImportOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { LocationSelect, SupplierSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, toDate } from '../../utils/format';
import {
  CURRENCY_OPTIONS, DueDate, OrderLinesEditor, QtyProgress, checkLines, isPast, linesBody, sumBy, toDayjs, uid, type LineRow,
} from './shared';

const RECEIVABLE = ['APPROVED', 'PARTIAL_RECEIVED'];
const STEP_OF: Record<string, number> = { DRAFT: 0, APPROVED: 1, PARTIAL_RECEIVED: 2, RECEIVED: 3, CLOSED: 3 };
const NEXT_HINT: Record<string, string> = {
  DRAFT: '确认无误后点击【保存并审批】。GMP 采购控制：只有“合格供方”且资质在有效期内的供应商才能审批通过，不符合时系统会拒绝并提示原因；客供料不能采购。',
  APPROVED: '订单已审批，可发送给供应商。到货后点击【收货】，登记批号、库位与生产/有效期。',
  PARTIAL_RECEIVED: '部分到货。剩余数量到货后继续【收货】；供应商不再供货时可【关闭】订单。',
  RECEIVED: '已全部到货。来料检验结果见下方收货记录中的 IQC 检验单。',
  CLOSED: '订单已关闭，不再收货。',
};

const remainOf = (l: Rec) => Math.max(0, Math.round((l.qty - (l.received_qty || 0)) * 10000) / 10000);

/** 采购单位换算率（下单时记录：1 采购单位 = qty / purchase_qty 库存单位） */
const factorOf = (l: Rec) => (l.purchase_uom && l.purchase_qty ? l.qty / l.purchase_qty : 0);
/** 库存单位数量折合采购单位（提示用） */
const inPurchase = (l: Rec, q: number) => {
  const f = factorOf(l);
  return f ? `≈ ${fmtQty(q / f)} ${l.purchase_uom}` : null;
};
/** 单价（最多 6 位小数） */
const fmtPrice = (v: number | null | undefined, currency: string) =>
  v === null || v === undefined
    ? '-'
    : `${currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥'}${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

function PoSteps({ po }: { po: Rec | null }) {
  const st = po?.status || 'DRAFT';
  if (st === 'CANCELLED') return <Alert type="warning" showIcon message="订单已取消" />;
  const qty = sumBy(po?.lines, 'qty');
  const got = sumBy(po?.lines, 'received_qty');
  return (
    <>
      <Steps
        size="small"
        current={STEP_OF[st] ?? 0}
        status={['APPROVED', 'RECEIVED', 'CLOSED'].includes(st) ? 'finish' : 'process'}
        items={[
          { title: '草稿', description: '录入订单' },
          { title: '审批', description: po?.approved_by ? `${po.approved_by} 已审批` : '合格供方校验' },
          { title: '收货', description: got > 0 ? `已收 ${fmtQty(got)}/${fmtQty(qty)}` : '到货待检' },
          { title: '完成', description: st === 'CLOSED' ? '已关闭' : st === 'RECEIVED' ? '全部到货' : undefined },
        ]}
      />
      {NEXT_HINT[st] && <Alert type="info" showIcon message={NEXT_HINT[st]} style={{ marginTop: 16 }} />}
    </>
  );
}

/** 供应商合格状态提示 */
function SupplierCheck({ supplierId }: { supplierId?: number }) {
  const [sup, setSup] = useState<Rec | null>(null);
  useEffect(() => {
    setSup(null);
    if (supplierId) get(`/suppliers/${supplierId}`, undefined, true).then(setSup).catch(() => undefined);
  }, [supplierId]);
  if (!sup) return null;
  const expired = sup.qualification_expiry && isPast(sup.qualification_expiry);
  if (sup.status === 'QUALIFIED' && !expired) {
    return (
      <Typography.Text type="success" style={{ fontSize: 12 }}>
        合格供方{sup.qualification_expiry ? `，资质有效期至 ${fmtDate(sup.qualification_expiry)}` : ''}
      </Typography.Text>
    );
  }
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 4 }}
      message={
        expired
          ? `该供应商资质已于 ${fmtDate(sup.qualification_expiry)} 过期，订单可保存草稿，但无法审批。请先完成供应商再评价。`
          : `该供应商当前为“${dictLabel('supplier_status', sup.status)}”，不在合格供方名录内，订单可保存草稿，但无法审批。`
      }
    />
  );
}

// ---------------- 编辑（新建 / 草稿） ----------------
function PoEditor({ po, onSaved }: { po: Rec | null; onSaved: (d: Rec) => void }) {
  const nav = useNavigate();
  const [form] = Form.useForm();
  const [lines, setLines] = useState<LineRow[]>(() =>
    po?.lines?.length
      ? po.lines.map((l: Rec) => ({ ...l, _key: uid(), purchase_uom_def: l.purchase_uom ?? null, purchase_factor: factorOf(l) || null }))
      : [{ _key: uid() }],
  );
  // 修改草稿：读取物料的采购单位设置（已按采购单位下单的行保留下单时的换算率）
  useEffect(() => {
    const ids = [...new Set(((po?.lines || []) as Rec[]).map((l) => l.material_id))];
    if (!ids.length) return;
    Promise.all(ids.map((mid) => get(`/materials/${mid}`, undefined, true).catch(() => null))).then((mats) => {
      const byId = new Map((mats.filter(Boolean) as Rec[]).map((m) => [m.id, m]));
      setLines((old) =>
        old.map((r) => {
          const m = byId.get(r.material_id);
          return !m || r.purchase_uom ? r : { ...r, purchase_uom_def: m.purchase_uom ?? null, purchase_factor: m.purchase_factor ?? null };
        }),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState<string>();
  const currency: string = Form.useWatch('currency', form) || po?.currency || 'CNY';
  const expected = Form.useWatch('expected_date', form);
  const supplierId: number | undefined = Form.useWatch('supplier_id', form);

  const save = async (andApprove: boolean) => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const err = checkLines(lines);
    if (err) {
      message.error(err);
      return;
    }
    const body = { ...v, order_date: toDate(v.order_date), expected_date: toDate(v.expected_date), lines: linesBody(lines, 'expected_date') };
    setBusy(andApprove ? 'approve' : 'save');
    let saved: Rec | null = null;
    try {
      saved = po ? await put(`/purchase-orders/${po.id}`, body) : await post('/purchase-orders', body);
      if (andApprove) {
        await post(`/purchase-orders/${saved!.id}/approve`);
        message.success('采购订单已审批，可发送给供应商');
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
      const d = await post(`/purchase-orders/${po!.id}/cancel`);
      message.success('订单已取消');
      onSaved(d);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title={po ? <Space>采购订单 {po.no}<StatusTag dict="po_status" value={po.status} /></Space> : '新建采购订单'}
        sub={po ? `创建人 ${po.created_by ?? '-'} · ${fmtDateTime(po.created_at)}${po.source ? ` · 来源 ${po.source}` : ''}` : '选择供应商与物料，填写数量、单价和预计到货日期'}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/purchase/orders')}>返回列表</Button>
            {po && (
              <Popconfirm title="确定取消该采购订单？" onConfirm={cancelOrder}>
                <Button danger loading={busy === 'cancel'}>取消订单</Button>
              </Popconfirm>
            )}
            <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy && busy !== 'save'} onClick={() => save(false)}>保存草稿</Button>
            <Button type="primary" icon={<AuditOutlined />} loading={busy === 'approve'} disabled={!!busy && busy !== 'approve'} onClick={() => save(true)}>
              保存并审批
            </Button>
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small"><PoSteps po={po} /></Card>
        <Card title="订单信息" size="small">
          <Form
            form={form}
            layout="vertical"
            initialValues={
              po
                ? {
                    supplier_id: po.supplier_id, order_date: toDayjs(po.order_date), expected_date: toDayjs(po.expected_date),
                    currency: po.currency, remark: po.remark,
                  }
                : { order_date: dayjs(), currency: 'CNY' }
            }
          >
            <Row gutter={16}>
              <Col xs={24} md={12} lg={8}>
                <Form.Item name="supplier_id" label="供应商" rules={[{ required: true, message: '请选择供应商' }]} style={{ marginBottom: 4 }}>
                  <SupplierSelect onPick={(s) => s && form.setFieldsValue({ currency: s.currency || 'CNY' })} />
                </Form.Item>
                <div style={{ marginBottom: 16 }}><SupplierCheck supplierId={supplierId} /></div>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="order_date" label="下单日期"><DatePicker style={{ width: '100%' }} allowClear={false} /></Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="expected_date" label="预计到货"><DatePicker style={{ width: '100%' }} /></Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="currency" label="币别"><Select options={CURRENCY_OPTIONS} /></Form.Item>
              </Col>
              <Col xs={24} md={18} lg={4}>
                <Form.Item name="remark" label="备注"><Input /></Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        <Card
          title="采购明细"
          size="small"
          extra={<Typography.Text type="secondary">选择物料后自动带出标准成本作为参考单价；设置了采购单位的物料（如 LED 按卷）默认按采购单位下单，系统自动换算为库存单位</Typography.Text>}
        >
          <OrderLinesEditor
            value={lines}
            onChange={setLines}
            dateField="expected_date"
            dateLabel="预计到货"
            currency={currency}
            purchaseUnit
            defaultDate={expected ? dayjs(expected).format('YYYY-MM-DD') : null}
            defaultPrice={(m) => (m.std_cost ? Number(m.std_cost) : undefined)}
          />
        </Card>
      </Space>
    </>
  );
}

// ---------------- 收货弹窗 ----------------
function ReceiveModal({ po, open, onClose, onDone }: { po: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [rows, setRows] = useState<Rec[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(
      (po.lines as Rec[])
        .filter((l) => remainOf(l) > 0)
        .map((l) => ({ _key: String(l.id), po_line_id: l.id, line: l, qty: remainOf(l) })),
    );
  }, [open, po]);

  const patch = (key: string, p: Rec) => setRows((old) => old.map((r) => (r._key === key ? { ...r, ...p } : r)));
  const dateCell = (r: Rec, k: string, placeholder?: string) => (
    <DatePicker
      style={{ width: 140 }}
      placeholder={placeholder}
      value={r[k] ? dayjs(r[k]) : null}
      onChange={(d) => patch(r._key, { [k]: d ? d.format('YYYY-MM-DD') : null })}
    />
  );

  const submit = async () => {
    const head = await form.validateFields().catch(() => null);
    if (!head) return;
    const use = rows.filter((r) => Number(r.qty) > 0);
    if (!use.length) {
      message.error('请至少填写一行本次收货数量');
      return;
    }
    const noLoc = use.find((r) => !r.location_id);
    if (noLoc) {
      message.error(`${noLoc.line.material_code} 请选择收货库位`);
      return;
    }
    setSaving(true);
    try {
      const rc = await post(`/purchase-orders/${po.id}/receive`, {
        delivery_note: head.delivery_note || null,
        remark: head.remark || null,
        lines: use.map((r) => ({
          po_line_id: r.po_line_id,
          qty: Number(r.qty),
          location_id: r.location_id,
          lot_no: r.lot_no || null,
          supplier_lot: r.supplier_lot || null,
          mfg_date: r.mfg_date || null,
          expiry_date: r.expiry_date || null,
        })),
      });
      const quarantine = ((rc.lines || []) as Rec[]).some((l) => l.status === 'QUARANTINE');
      message.success(quarantine ? '已收货，物料处于“待检”状态，已自动生成 IQC 检验单' : '已收货入库（免检物料直接为合格状态）', 5);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', key: 'm', width: 220, fixed: 'left',
      render: (_, r) => (
        <div>
          <div className="mono">{r.line.material_code}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.line.material_name}{r.line.material_spec ? ` | ${r.line.material_spec}` : ''}</Typography.Text>
        </div>
      ),
    },
    {
      title: '订单 / 已收 / 未收', key: 'q', width: 170,
      render: (_, r) => (
        <div>
          {`${fmtQty(r.line.qty)} / ${fmtQty(r.line.received_qty || 0)} / ${fmtQty(remainOf(r.line))} ${r.line.uom || ''}`}
          {r.line.purchase_uom && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              下单 {fmtQty(r.line.purchase_qty)} {r.line.purchase_uom}（1 {r.line.purchase_uom} = {fmtQty(factorOf(r.line))} {r.line.uom}）
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '本次收货（库存单位）', key: 'qty', width: 140,
      render: (_, r) => (
        <div>
          <InputNumber min={0} max={Math.round(remainOf(r.line) * 1.05 * 10000) / 10000} style={{ width: 120 }} value={r.qty} onChange={(v) => patch(r._key, { qty: v })} />
          {inPurchase(r.line, Number(r.qty) || 0) && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{inPurchase(r.line, Number(r.qty) || 0)}</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '收货库位', key: 'loc', width: 240,
      render: (_, r) => (
        <LocationSelect style={{ width: 230 }} value={r.location_id} onChange={(v) => patch(r._key, { location_id: v })} status={Number(r.qty) > 0 && !r.location_id ? 'error' : undefined} />
      ),
    },
    {
      title: '批号', key: 'lot', width: 150,
      render: (_, r) => <Input style={{ width: 140 }} placeholder="留空自动生成" value={r.lot_no ?? ''} onChange={(e) => patch(r._key, { lot_no: e.target.value })} />,
    },
    {
      title: '供应商批号', key: 'slot', width: 140,
      render: (_, r) => <Input style={{ width: 130 }} value={r.supplier_lot ?? ''} onChange={(e) => patch(r._key, { supplier_lot: e.target.value })} />,
    },
    { title: '生产日期', key: 'mfg', width: 150, render: (_, r) => dateCell(r, 'mfg_date') },
    { title: '有效期至', key: 'exp', width: 150, render: (_, r) => dateCell(r, 'expiry_date', '留空按保质期算') },
  ];

  return (
    <Modal
      open={open}
      title={`采购收货 - ${po.no} ${po.supplier_name ?? ''}`}
      width={1360}
      okText="确认收货"
      onOk={submit}
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="收货一律按库存单位（如 PCS）登记，按采购单位下单的行会提示折合的采购单位数量。需检验的物料收货后为“待检”状态，IQC 检验合格后才能领用；本次收货数量默认为未收数量，允许超收 5%。数量填 0 的行不收货。"
      />
      <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }} preserve={false}>
        <Form.Item name="delivery_note" label="送货单号"><Input style={{ width: 180 }} placeholder="供应商送货单号" /></Form.Item>
        <Form.Item label="统一库位">
          <LocationSelect
            style={{ width: 240 }}
            placeholder="一次设置所有行的库位"
            onChange={(v) => setRows((old) => old.map((r) => ({ ...r, location_id: v })))}
          />
        </Form.Item>
        <Form.Item name="remark" label="备注"><Input style={{ width: 220 }} /></Form.Item>
      </Form>
      <Table rowKey="_key" size="small" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} />
    </Modal>
  );
}

// ---------------- 查看（审批后） ----------------
function PoView({ po, reload }: { po: Rec; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string>();
  const [receiving, setReceiving] = useState(false);
  const st: string = po.status;
  const receivable = RECEIVABLE.includes(st);
  const anyReceived = (po.lines as Rec[]).some((l) => (l.received_qty || 0) > 0);

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

  const receiptRows = useMemo(
    () =>
      ((po.receipts || []) as Rec[]).flatMap((rc) =>
        ((rc.lines || []) as Rec[]).map((l) => ({ ...l, receipt_no: rc.no, receipt_date: rc.receipt_date, delivery_note: rc.delivery_note, receiver: rc.created_by })),
      ),
    [po],
  );

  const lineCols: TableColumnsType<Rec> = [
    { title: '行号', dataIndex: 'line_no', width: 60 },
    { title: '物料编码', dataIndex: 'material_code', render: (v) => <span className="mono">{v}</span> },
    { title: '物料名称', dataIndex: 'material_name' },
    { title: '规格', dataIndex: 'material_spec', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '单位', dataIndex: 'uom' },
    {
      title: '数量', dataIndex: 'qty', align: 'right',
      render: (v, l) => (
        <div>
          {fmtQty(v)}
          {l.purchase_uom && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>= {fmtQty(l.purchase_qty)} {l.purchase_uom}</Typography.Text>}
        </div>
      ),
    },
    {
      title: '单价', dataIndex: 'unit_price', align: 'right',
      render: (v, l) =>
        l.purchase_uom ? (
          <div>
            {fmtPrice(l.purchase_price, po.currency)}/{l.purchase_uom}
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>= {fmtPrice(v, po.currency)}/{l.uom}</Typography.Text>
          </div>
        ) : (
          fmtPrice(v, po.currency)
        ),
    },
    { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => fmtMoney(v, po.currency) },
    {
      title: '预计到货', dataIndex: 'expected_date',
      render: (v, l) => {
        const d = v || po.expected_date;
        return <DueDate value={d} overdue={receivable && isPast(d) && remainOf(l) > 0} hint="已过预计到货日期，尚未到齐" />;
      },
    },
    { title: '到货进度', key: 'recv', render: (_, l) => <QtyProgress done={l.received_qty || 0} total={l.qty} /> },
    { title: '备注', dataIndex: 'remark', render: (v) => v || '-' },
  ];

  const receiptCols: TableColumnsType<Rec> = [
    { title: '入库单号', dataIndex: 'receipt_no', render: (v) => <Link to={`/wms/receipts?q=${encodeURIComponent(v)}`} className="mono">{v}</Link> },
    { title: '收货日期', dataIndex: 'receipt_date', render: fmtDate },
    { title: '送货单号', dataIndex: 'delivery_note', render: (v) => v || '-' },
    { title: '物料', key: 'm', render: (_, l) => `${l.material_code} ${l.material_name}` },
    {
      title: '批号', dataIndex: 'lot_no',
      render: (v, l) => <Link to={`/trace?material_code=${encodeURIComponent(l.material_code)}&lot_no=${encodeURIComponent(v)}`} className="mono">{v}</Link>,
    },
    { title: '供应商批号', dataIndex: 'supplier_lot', render: (v) => v || '-' },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, l) => `${fmtQty(v)} ${l.uom || ''}` },
    { title: '库位', dataIndex: 'location_code', render: (v) => v || '-' },
    { title: '有效期至', dataIndex: 'expiry_date', render: fmtDate },
    { title: '质量状态', dataIndex: 'status', render: (v) => <StatusTag dict="stock_status" value={v} /> },
    {
      title: 'IQC 检验单', dataIndex: 'inspection_id',
      render: (v) => (v ? <Link to={`/quality/inspections/${v}`}>查看检验单</Link> : <Tag>免检</Tag>),
    },
    { title: '收货人', dataIndex: 'receiver', render: (v) => v || '-' },
  ];

  return (
    <>
      <PageHeader
        title={<Space>采购订单 {po.no}<StatusTag dict="po_status" value={st} /></Space>}
        sub={`${po.supplier_name ?? ''}${po.source ? ` · 来源 ${po.source}` : ''}`}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/purchase/orders')}>返回列表</Button>
            {st === 'APPROVED' && !anyReceived && can('purchase') && (
              <Popconfirm title="确定取消该采购订单？" onConfirm={() => act('cancel', `/purchase-orders/${po.id}/cancel`, '订单已取消')}>
                <Button danger loading={busy === 'cancel'}>取消订单</Button>
              </Popconfirm>
            )}
            {receivable && can('purchase') && (
              <Popconfirm title="关闭后不再收货（剩余数量不再到货）。确定关闭？" onConfirm={() => act('close', `/purchase-orders/${po.id}/close`, '订单已关闭')}>
                <Button loading={busy === 'close'}>关闭</Button>
              </Popconfirm>
            )}
            {receivable && can('wms', 'purchase') && (
              <Button type="primary" icon={<ImportOutlined />} onClick={() => setReceiving(true)}>收货</Button>
            )}
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small"><PoSteps po={po} /></Card>
        <Card size="small" title="订单信息">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: 'supplier', label: '供应商', children: po.supplier_name },
              { key: 'amount', label: '订单金额', children: <b>{fmtMoney(po.total_amount, po.currency)}</b> },
              { key: 'currency', label: '币别', children: po.currency },
              { key: 'order_date', label: '下单日期', children: fmtDate(po.order_date) },
              {
                key: 'expected', label: '预计到货',
                children: <DueDate value={po.expected_date} overdue={receivable && isPast(po.expected_date)} hint="已过预计到货日期，尚未到齐" />,
              },
              { key: 'approved', label: '审批', children: po.approved_by ? `${po.approved_by} · ${fmtDateTime(po.approved_at)}` : '-' },
              { key: 'source', label: '来源', children: po.source || '手工' },
              { key: 'creator', label: '创建', children: `${po.created_by ?? '-'} · ${fmtDateTime(po.created_at)}` },
              { key: 'remark', label: '备注', children: po.remark || '-' },
            ]}
          />
        </Card>
        <Card size="small" title="采购明细">
          <Table rowKey="id" size="middle" columns={lineCols} dataSource={po.lines} pagination={false} scroll={{ x: 'max-content' }} />
        </Card>
        <Card size="small" title={`收货记录（${(po.receipts || []).length} 次）`}>
          {receiptRows.length ? (
            <Table rowKey="id" size="middle" columns={receiptCols} dataSource={receiptRows} pagination={false} scroll={{ x: 'max-content' }} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={receivable ? '尚未收货，到货后点击右上角【收货】' : '无收货记录'} />
          )}
        </Card>
      </Space>
      {receivable && (
        <ReceiveModal
          po={po}
          open={receiving}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            reload();
          }}
        />
      )}
    </>
  );
}

export default function PurchaseOrderDetail() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const { can } = useAuth();
  const [po, setPo] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (isNew) {
      setPo(null);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      setPo(await get(`/purchase-orders/${id}`));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    setPo(null);
    load();
  }, [load]);

  if (isNew && !can('purchase')) return <Result status="403" title="没有新建采购订单的权限" extra={<Button onClick={() => nav('/purchase/orders')}>返回列表</Button>} />;
  if (failed && !po) return <Result status="404" title="采购订单不存在或无法加载" extra={<Button onClick={() => nav('/purchase/orders')}>返回列表</Button>} />;
  if (!isNew && !po) return <Spin style={{ display: 'block', padding: 80 }} />;

  if (isNew || (po!.status === 'DRAFT' && can('purchase'))) {
    return (
      <PoEditor
        key={po?.id ?? 'new'}
        po={po}
        onSaved={(d) => (isNew ? nav(`/purchase/orders/${d.id}`, { replace: true }) : load())}
      />
    );
  }
  return (
    <Spin spinning={loading}>
      <PoView po={po!} reload={load} />
    </Spin>
  );
}
