import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Row, Segmented, Space, Table, Tag, Tooltip, Typography, message,
  type TableColumnsType,
} from 'antd';
import { CheckCircleOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import RemoteSelect, { CustomerSelect, LocationSelect, MaterialSelect } from '../../components/RemoteSelect';
import ScanInput, { type ScanInputHandle } from '../../components/ScanInput';
import StatusTag from '../../components/StatusTag';
import type { ScanResult } from '../../utils/scan';
import { errText, FeedbackBar, useFeedback } from './pda/kit';
import { usePaged } from '../../components/usePaged';
import ExportButton from '../../components/ExportButton';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';
import { LotLink, MaterialCell, Qty, SnLink } from './common';

const STATUS_TABS = [
  { value: '', label: '全部' },
  { value: 'RECEIVED', label: '待处置' },
  { value: 'CLOSED', label: '已关闭' },
];

/** 关闭退货单时按 NCR 处置执行的库存动作 */
const CLOSE_EFFECT: Record<string, string> = {
  SCRAP: '冻结库存报废出库，序列号标记为“已报废”。',
  RETURN: '冻结库存出库返还客户，序列号恢复为“已发货”。',
  REWORK: '返修完成：冻结库存转为“合格”并上架到指定库位，序列号恢复为“在库”。',
  USE_AS_IS: '让步接收：冻结库存转为“合格”并上架到指定库位，序列号恢复为“在库”。',
};

const stop = (e: MouseEvent) => e.stopPropagation();

/** 常用退货原因（点选即可，也可手输） */
const REASONS = ['不亮 / 不开机', '亮度不足 / 光衰', '外观破损', '功能异常', '运输损坏', '客户无理由退货'];

// ---------------- 登记客户退货 ----------------
function CreateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: Rec) => void }) {
  const narrow = useNarrow(768);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [rejLoc, setRejLoc] = useState<number | undefined>();
  const { fb, show, clear } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const customerId: number | undefined = Form.useWatch('customer_id', form);
  const soId: number | undefined = Form.useWatch('so_id', form);
  const lineList: Rec[] = Form.useWatch('lines', form) || [];

  // 退货品默认放入不合格品仓（冻结，待 QA 评审）
  useEffect(() => {
    get('/locations', { page_size: 200, is_active: true }, true)
      .then((d) => setRejLoc((d.items as Rec[]).find((l) => l.location_type === 'REJECT' || l.warehouse_type === 'REJECT')?.id))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ return_date: dayjs(), lines: [] });
      clear();
      setTimeout(() => scanRef.current?.focus(), 200);
    }
  }, [open, form, clear]);

  /** 扫描序列号或 UDI（带括号 / GS1 原始串）：自动带出产品、批号、客户、原订单、原发货单，追加一行；失败也清空扫码框并保持焦点 */
  const addBySn = async (_code: string, p: ScanResult) => {
    const sn = (p.sn || p.code).trim();
    if (!sn) return;
    const lines: Rec[] = form.getFieldValue('lines') || [];
    if (lines.some((l) => l.sn === sn)) return show('err', `序列号 ${sn} 已在列表中，请勿重复扫描`);
    try {
      const d = await get('/wms/rma-scan', { code: sn }, true);
      const cur = form.getFieldValue('customer_id');
      if (cur && d.customer_id && cur !== d.customer_id) return show('err', `${sn} 是发给“${d.customer_name}”的，与本退货单客户不同，请分开登记`);
      const patch: Rec = { lines: [...lines, { sn, material_id: d.material_id, lot_no: d.lot_no, qty: 1, location_id: rejLoc }] };
      if (!cur && d.customer_id) patch.customer_id = d.customer_id;
      if (!form.getFieldValue('so_id') && d.so_id) patch.so_id = d.so_id;
      if (!form.getFieldValue('shipment_id') && d.shipment_id) patch.shipment_id = d.shipment_id;
      form.setFieldsValue(patch);
      show('ok', <>✓ <b>{sn}</b> {d.material_code}｜客户 {d.customer_name}｜订单 {d.so_no ?? '-'}｜发货单 {d.shipment_no ?? '-'}（{fmtDate(d.ship_date)}）</>);
    } catch (e) {
      show('err', errText(e));
    }
  };

  const submit = async () => {
    const v = await form.validateFields();
    const lines = (v.lines || []).map((l: Rec) => ({
      material_id: l.material_id, sn: l.sn?.trim() || null, lot_no: l.lot_no?.trim() || null, qty: l.sn ? 1 : l.qty, location_id: l.location_id,
    }));
    if (!lines.length) {
      message.warning('请扫描序列号或添加退货明细');
      return;
    }
    setSaving(true);
    try {
      const r = await post('/customer-returns', {
        customer_id: v.customer_id, so_id: v.so_id ?? null, shipment_id: v.shipment_id ?? null, reason: v.reason,
        return_date: toDate(v.return_date), remark: v.remark || null, lines,
      });
      message.success(`已登记客户退货 ${r.no}，退货品已冻结，并自动开具 ${r.ncr_no}`, 5);
      onDone(r);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title={<span><RollbackOutlined style={{ marginRight: 8 }} />登记客户退货（RMA）</span>} width={narrow ? '100%' : 1100} okText="确认收货" cancelText="返回"
      style={narrow ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : undefined}
      styles={narrow ? { body: { maxHeight: 'calc(100vh - 130px)', overflowY: 'auto', overflowX: 'hidden' } } : undefined}
      okButtonProps={{ size: narrow ? 'large' : 'middle' }} cancelButtonProps={{ size: narrow ? 'large' : 'middle' }}
      confirmLoading={saving} onOk={submit} onCancel={onClose} destroyOnHidden maskClosable={false}>
      {!narrow && <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="退货品一律以“冻结”状态入库（默认放不合格品仓，不能领用或发货），系统自动开具来源为“客户”的 NCR，由 QA 评审处置后关闭退货单。序列号产品请逐台扫描。" />}
      <ScanInput ref={scanRef} onScan={addBySn} autoFocus captureGlobal placeholder="扫描产品序列号 / UDI，自动带出客户、订单、发货单" style={{ height: 50, fontSize: 17 }} />
      <FeedbackBar fb={fb} />
      {lineList.filter((l) => l?.sn).length > 0 && (
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 6, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, padding: '2px 4px' }}>已扫 {lineList.filter((l) => l?.sn).length} 台</div>
          {lineList.map((l, i) => (l?.sn ? (
            <div key={l.sn} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px' }}>
              <span className="mono" style={{ flex: 1, fontSize: 16 }}>{l.sn}</span>
              <Button danger icon={<DeleteOutlined />} aria-label={`删除 ${l.sn}`} style={{ width: 44, height: 40 }}
                onClick={() => { form.setFieldsValue({ lines: lineList.filter((_, j) => j !== i) }); show('info', `已移除 ${l.sn}`, false); scanRef.current?.focus(); }} />
            </div>
          ) : null))}
        </div>
      )}
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="customer_id" label="退货客户" rules={[{ required: true, message: '请选择客户' }]}>
              <CustomerSelect onChange={() => form.setFieldsValue({ so_id: undefined, shipment_id: undefined })} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="so_id" label="原销售订单（可选）">
              <RemoteSelect url="/sales-orders" params={{ customer_id: customerId }} disabled={!customerId} placeholder={customerId ? '搜索订单号' : '请先选择客户'}
                labelOf={(r) => `${r.no} ${r.customer_po ?? ''}`} onChange={() => form.setFieldsValue({ shipment_id: undefined })} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="shipment_id" label="原发货单（可选）">
              <RemoteSelect url="/shipments" params={{ status: 'SHIPPED', so_id: soId }} disabled={!customerId} placeholder="搜索发货单号"
                labelOf={(r) => `${r.no} ${r.customer_name ?? ''} ${r.ship_date ?? ''}`} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={6}>
            <Form.Item name="return_date" label="收货日期" rules={[{ required: true, message: '请选择日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={18}>
            <Form.Item name="reason" label="退货原因" rules={[{ required: true, whitespace: true, message: '请填写退货原因' }]} style={{ marginBottom: 6 }}>
              <Input placeholder="客户描述的故障现象 / 退货理由（将写入 NCR）" />
            </Form.Item>
            <Space size={[6, 6]} wrap style={{ marginBottom: 12 }}>
              {REASONS.map((r) => <Tag.CheckableTag key={r} checked={false} style={{ padding: '4px 10px', fontSize: 14, border: '1px solid #d9d9d9' }} onChange={() => form.setFieldsValue({ reason: r })}>{r}</Tag.CheckableTag>)}
            </Space>
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>序列号产品逐台扫描（上方扫码框）；非序列号物料点击“添加明细”。</Typography.Paragraph>
        <Form.List name="lines">
          {(fields, { add, remove }) => {
            const columns: TableColumnsType<(typeof fields)[number]> = [
              {
                title: '序列号', key: 'sn', width: 170,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'sn']} style={{ margin: 0 }}>
                    <Input className="mono" style={{ width: 160 }} placeholder="序列号产品必填" />
                  </Form.Item>
                ),
              },
              {
                title: '物料/产品', key: 'm', width: 260,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'material_id']} rules={[{ required: true, message: '请选择物料' }]} style={{ margin: 0 }}>
                    <MaterialSelect style={{ width: 260 }} />
                  </Form.Item>
                ),
              },
              {
                title: '批号', key: 'lot', width: 140,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'lot_no']} style={{ margin: 0 }}>
                    <Input className="mono" style={{ width: 130 }} />
                  </Form.Item>
                ),
              },
              {
                title: '数量', key: 'qty', width: 100,
                render: (_, f) => (
                  <Form.Item noStyle shouldUpdate>
                    {() => {
                      const hasSn = !!form.getFieldValue(['lines', f.name, 'sn']);
                      return (
                        <Form.Item name={[f.name, 'qty']} rules={[{ required: !hasSn, message: '必填' }]} style={{ margin: 0 }}>
                          <InputNumber min={0.0001} style={{ width: 90 }} disabled={hasSn} placeholder={hasSn ? '1' : '数量'} />
                        </Form.Item>
                      );
                    }}
                  </Form.Item>
                ),
              },
              {
                title: '入库库位（冻结）', key: 'loc', width: 220,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'location_id']} rules={[{ required: true, message: '请选择库位' }]} style={{ margin: 0 }}>
                    <LocationSelect style={{ width: 210 }} />
                  </Form.Item>
                ),
              },
              { title: '', key: 'del', width: 48, render: (_, f) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} /> },
            ];
            return (
              <>
                <Table rowKey="key" size="small" columns={columns} dataSource={fields} pagination={false} scroll={{ x: 'max-content' }}
                  locale={{ emptyText: '请扫描序列号或添加明细' }} />
                <Button type="dashed" icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => add({ qty: 1, location_id: rejLoc })}>添加明细</Button>
              </>
            );
          }}
        </Form.List>
        <Form.Item name="remark" label="备注" style={{ marginTop: 16 }}>
          <Input placeholder="物流单号、外观检查情况等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 关闭（按 NCR 处置执行，电子签名） ----------------
function CloseModal({ rma, onClose, onDone }: { rma: Rec | null; onClose: () => void; onDone: (r: Rec) => void }) {
  const [locId, setLocId] = useState<number | undefined>();
  const [remark, setRemark] = useState('');
  const [touched, setTouched] = useState(false);
  const [sign, signHolder] = useESign();
  const [saving, setSaving] = useState(false);
  const disp = rma?.ncr_disposition as string | undefined;
  const restock = disp === 'REWORK' || disp === 'USE_AS_IS';
  useEffect(() => {
    setLocId(undefined);
    setRemark('');
    setTouched(false);
  }, [rma]);
  return (
    <Modal open={!!rma} title={`关闭客户退货 ${rma?.no ?? ''}`} width={620} okText="签名并关闭" confirmLoading={saving} onCancel={onClose} destroyOnHidden maskClosable={false}
      onOk={async () => {
        setTouched(true);
        if (restock && !locId) return;
        try {
          setSaving(true);
          const r = await sign({
            meaning: '客户退货关闭', description: `${rma!.no}：按 ${rma!.ncr_no} 处置【${dictLabel('disposition', disp)}】执行。${CLOSE_EFFECT[disp ?? ''] ?? ''}`,
            submit: (signature) => post(`/customer-returns/${rma!.id}/close`, { location_id: locId ?? null, remark: remark.trim() || null, signature }),
          });
          message.success(`${rma!.no} 已关闭`);
          onDone(r);
          onClose();
        } catch (e) {
          if (!isCancel(e)) throw e;
        } finally {
          setSaving(false);
        }
      }}>
      {signHolder}
      <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message={<span>NCR 处置：<StatusTag dict="disposition" value={disp} /></span>}
        description={CLOSE_EFFECT[disp ?? ''] ?? ''} />
      <Form layout="vertical">
        {restock && (
          <Form.Item label="合格品上架库位" required validateStatus={touched && !locId ? 'error' : undefined} help={touched && !locId ? '请选择上架库位（不能是不合格品区）' : undefined}>
            <LocationSelect params={{ is_active: true }} value={locId} onChange={(v) => setLocId(v as number | undefined)} />
          </Form.Item>
        )}
        <Form.Item label="关闭说明">
          <Input.TextArea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：返修更换电源板，复测合格" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 详情 ----------------
function RmaDrawer({ rma, onClose, onCloseIt }: { rma: Rec | null; onClose: () => void; onCloseIt: () => void }) {
  const { can } = useAuth();
  const narrow = useNarrow(768);
  if (!rma) return <Drawer open={false} onClose={onClose} />;
  const ncrDone = rma.ncr_status && rma.ncr_status !== 'OPEN';
  const columns: TableColumnsType<Rec> = [
    { title: '物料/产品', key: 'm', render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} /> },
    { title: '序列号', dataIndex: 'sn', render: (v) => (v ? <SnLink sn={v} /> : '-') },
    { title: '序列号状态', dataIndex: 'sn_status', render: (v) => (v ? <StatusTag dict="sn_status" value={v} /> : '-') },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    { title: '入库库位', dataIndex: 'location_code', render: (v) => <span className="mono">{v}</span> },
  ];
  return (
    <Drawer
      open
      width={narrow ? '100%' : 900}
      onClose={onClose}
      title={<Space>客户退货 <span className="mono">{rma.no}</span><StatusTag dict="rma_status" value={rma.status} /></Space>}
      extra={can('qa') && rma.status === 'RECEIVED' && (
        <Tooltip title={ncrDone ? '' : '关联 NCR 尚未评审处置'}>
          <Button type="primary" icon={<CheckCircleOutlined />} disabled={!ncrDone} onClick={onCloseIt}>按处置关闭</Button>
        </Tooltip>
      )}
    >
      {rma.status === 'RECEIVED' && (
        <Alert type={ncrDone ? 'warning' : 'info'} showIcon style={{ marginBottom: 16 }}
          message={ncrDone
            ? `NCR 已处置（${dictLabel('disposition', rma.ncr_disposition)}），请 QA 关闭退货单以执行库存处置。`
            : '退货品已冻结。请 QA 在关联 NCR 中评审处置（返修/报废/让步接收/返还客户），然后在此关闭退货单，系统按处置结果执行库存。'} />
      )}
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }} items={[
        { key: 'c', label: '客户', children: rma.customer_name },
        { key: 'd', label: '收货日期', children: fmtDate(rma.return_date) },
        { key: 'so', label: '原销售订单', children: rma.so_no ? <Link to={`/sales/orders/${rma.so_id}`}>{rma.so_no}</Link> : '-' },
        { key: 'sh', label: '原发货单', children: rma.shipment_no ? <Link to={`/wms/shipments?q=${encodeURIComponent(rma.shipment_no)}`}>{rma.shipment_no}</Link> : '-' },
        { key: 'r', label: '退货原因', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{rma.reason}</span> },
        {
          key: 'ncr', label: '关联 NCR', span: 2,
          children: rma.ncr_no
            ? <Space><Link to={`/quality/ncrs?q=${encodeURIComponent(rma.ncr_no)}`}>{rma.ncr_no}</Link><StatusTag dict="ncr_status" value={rma.ncr_status} />{rma.ncr_disposition && <StatusTag dict="disposition" value={rma.ncr_disposition} />}</Space>
            : '-',
        },
        { key: 'by', label: '登记', children: `${rma.created_by || '-'} · ${fmtDateTime(rma.created_at)}` },
        { key: 'rm', label: '备注', children: <span style={{ whiteSpace: 'pre-wrap' }}>{rma.remark || '-'}</span> },
      ]} />
      <Table rowKey="id" size="small" columns={columns} dataSource={rma.lines} pagination={false} scroll={{ x: 'max-content' }} />
      <div style={{ marginTop: 16 }}>
        <Attachments entity="wms_customer_return" entityId={rma.id} bare hint="退货照片、客户退货单、物流单据、检测报告等。" canUpload={can('wms', 'qa')} />
      </div>
    </Drawer>
  );
}

export default function CustomerReturns() {
  const { can } = useAuth();
  const narrow = useNarrow();
  const [sp, setSp] = useSearchParams();
  const qParam = sp.get('q') || '';
  const [status, setStatus] = useState(sp.get('status') || '');
  const { rows, loading, query, setQuery, reload, pagination } = usePaged('/customer-returns', { q: qParam || undefined, status: sp.get('status') || undefined });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // /wms/customer-returns?new=1 直接打开登记（PDA 首页入口）
  useEffect(() => {
    if (sp.get('new') === '1' && can('wms', 'qa')) {
      setCreateOpen(true);
      const next = new URLSearchParams(sp);
      next.delete('new');
      setSp(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const [closing, setClosing] = useState<Rec | null>(null);

  const lastQ = useRef(qParam);
  useEffect(() => {
    if (lastQ.current === qParam) return;
    lastQ.current = qParam;
    setQuery({ q: qParam || undefined });
  }, [qParam, setQuery]);

  const changed = (r: Rec) => {
    setCurrent((c) => (c && c.id === r.id ? r : c));
    reload();
  };
  const openRow = async (r: Rec) => setCurrent(await get(`/customer-returns/${r.id}`));

  const columns: RColumn[] = [
    { title: '退货单号', dataIndex: 'no', fixed: narrow ? undefined : 'left', mobile: 'title', render: (v) => <Typography.Link className="mono" style={{ fontWeight: 600 }}>{v}</Typography.Link> },
    { title: '收货日期', dataIndex: 'return_date', render: (v) => fmtDate(v) },
    { title: '客户', dataIndex: 'customer_name' },
    {
      title: '退货明细', key: 'lines',
      render: (_, r) => (
        <Space size={4} wrap style={{ maxWidth: 320 }}>
          {(r.lines as Rec[]).slice(0, 4).map((l) => <Tag key={l.id} className="mono">{l.sn || `${l.material_code} ${l.lot_no || ''} ×${l.qty}`}</Tag>)}
          {r.lines.length > 4 && <Typography.Text type="secondary">等 {r.lines.length} 行</Typography.Text>}
        </Space>
      ),
    },
    { title: '数量', dataIndex: 'total_qty', align: 'right' },
    { title: '退货原因', dataIndex: 'reason', width: 220, ellipsis: { showTitle: true } },
    { title: '原发货单', dataIndex: 'shipment_no', mobile: 'hidden', render: (v) => v || '-' },
    {
      title: 'NCR', dataIndex: 'ncr_no',
      render: (v, r) => (v ? <Space size={4}><Link className="mono" to={`/quality/ncrs?q=${encodeURIComponent(v)}`} onClick={stop}>{v}</Link><StatusTag dict="ncr_status" value={r.ncr_status} /></Space> : '-'),
    },
    { title: '处置', dataIndex: 'ncr_disposition', render: (v) => (v ? <StatusTag dict="disposition" value={v} /> : '-') },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="rma_status" value={v} /> },
    { title: '登记人', dataIndex: 'created_by', mobile: 'hidden' },
    {
      title: '操作', key: '_op', fixed: narrow ? undefined : 'right',
      render: (_, r) =>
        can('qa') && r.status === 'RECEIVED' && r.ncr_status && r.ncr_status !== 'OPEN' ? (
          <Button size="small" type="primary" onClick={(e) => { stop(e); setClosing(r); }}>关闭</Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="客户退货"
        sub="登记客户退回的产品：冻结入库、序列号标记“客户退回”、自动开具 NCR；QA 评审处置后关闭，系统按处置执行库存。"
        extra={can('wms', 'qa') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>登记退货</Button>}
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: (v as string) || undefined }); }} />
          <Input.Search key={qParam} allowClear placeholder="退货单号 / 序列号 / 批号 / 原因" defaultValue={qParam} style={{ width: 280 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton url="/customer-returns" params={query} filename="客户退货" columns={[
            { title: '退货单号', key: 'no' }, { title: '收货日期', key: 'return_date', type: 'date' }, { title: '客户', key: 'customer_name' },
            { title: '原订单', key: 'so_no' }, { title: '原发货单', key: 'shipment_no' },
            { title: '明细', value: (r) => (r.lines as Rec[]).map((l) => l.sn || `${l.material_code} ${l.lot_no || ''}×${l.qty}`).join('、') },
            { title: '数量', key: 'total_qty', type: 'number' }, { title: '退货原因', key: 'reason' }, { title: 'NCR', key: 'ncr_no' },
            { title: '处置', value: (r) => dictLabel('disposition', r.ncr_disposition) }, { title: '状态', value: (r) => dictLabel('rma_status', r.status) }, { title: '登记人', key: 'created_by' },
          ]} />
        </Space>
        <ResponsiveTable
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          scroll={{ x: 'max-content' }}
          onRow={(r) => ({ onClick: () => openRow(r), style: { cursor: 'pointer' } })}
        />
      </Card>
      <RmaDrawer rma={current} onClose={() => setCurrent(null)} onCloseIt={() => setClosing(current)} />
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={(r) => { reload(); setCurrent(r); }} />
      <CloseModal rma={closing} onClose={() => setClosing(null)} onDone={changed} />
    </>
  );
}
