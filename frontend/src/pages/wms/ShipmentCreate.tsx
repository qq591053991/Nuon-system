/** 新建发货单：扫/选销售订单 → 自动带出未发明细 → 逐台扫码（UDI/GS1 原始串均可）或系统自动选取 → 生成发货单 */
import { Alert, AutoComplete, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Row, Space, Spin, Table, Tag, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { DeleteOutlined, SendOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { get, post, type Rec } from '../../api/http';
import RemoteSelect from '../../components/RemoteSelect';
import { useNarrow } from '../../components/ResponsiveTable';
import ScanInput, { type ScanInputHandle } from '../../components/ScanInput';
import { fmtDate, fmtQty } from '../../utils/format';
import type { ScanResult } from '../../utils/scan';
import { MaterialCell } from './common';
import { FeedbackBar, useFeedback } from './pda/kit';

interface ShipLine {
  line: Rec; // 销售订单行
  remaining: number; // 未发数量
  serial: boolean; // 是否序列号管理
  available: Rec[]; // 可发序列号（已入库且已放行，按完工先后）
  stockQty: number; // 非序列号物料：合格可发库存
  qty: number; // 本次发货数量（计划）
  serials: string[]; // 扫描指定的序列号（为空 = 系统自动选取）
}

const CARRIERS = ['顺丰速运', '京东物流', '德邦物流', '中通快运', 'DHL', 'FedEx', 'UPS', '客户自提'].map((v) => ({ value: v }));
const OPEN_SO = 'CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED';

export default function ShipmentCreate({ open, initialSoId, onClose, onCreated }: {
  open: boolean;
  initialSoId?: number;
  onClose: () => void;
  onCreated: (sh: Rec) => void;
}) {
  const narrow = useNarrow(768);
  const [form] = Form.useForm();
  const [soId, setSoId] = useState<number | undefined>();
  const [so, setSo] = useState<Rec | null>(null);
  const [lines, setLines] = useState<ShipLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState<string[]>([]); // 扫描顺序（最新在前）
  const { fb, show, clear } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const seq = useRef(0);
  const [modal, holder] = Modal.useModal();
  const soBox = useRef<HTMLDivElement>(null);

  const loadSo = async (id?: number) => {
    const my = ++seq.current;
    setSoId(id);
    setSo(null);
    setLines([]);
    setOrder([]);
    clear();
    if (!id) return;
    setLoading(true);
    try {
      const o: Rec = await get(`/sales-orders/${id}`);
      const openLines = (o.lines as Rec[]).filter((l) => l.qty - (l.shipped_qty || 0) > 1e-9);
      const matIds = [...new Set(openLines.map((l) => l.material_id as number))];
      const info = await Promise.all(matIds.map(async (mid) => {
        const m: Rec | null = await get(`/materials/${mid}`, undefined, true).catch(() => null);
        if (m?.serial_control) {
          const sns: Rec[] = await get('/serials/available', { material_id: mid }, true).catch(() => []);
          return { mid, serial: true, available: sns, stockQty: sns.length };
        }
        const st = await get('/stock', { material_id: mid, status: 'AVAILABLE', page_size: 1000 }, true).catch(() => ({ items: [] }));
        const qty = (st.items as Rec[]).reduce((s, r) => s + (r.qty || 0), 0);
        return { mid, serial: false, available: [] as Rec[], stockQty: qty };
      }));
      if (my !== seq.current) return;
      const byMat = new Map(info.map((i) => [i.mid, i]));
      const used = new Map<number, number>();
      setLines(openLines.map((l) => {
        const i = byMat.get(l.material_id)!;
        const remaining = Math.round((l.qty - (l.shipped_qty || 0)) * 10000) / 10000;
        const left = Math.max(0, i.stockQty - (used.get(l.material_id) || 0));
        const qty = Math.min(remaining, i.serial ? Math.floor(left) : left);
        used.set(l.material_id, (used.get(l.material_id) || 0) + qty);
        return { line: l, remaining, serial: i.serial, available: i.available, stockQty: i.stockQty, qty, serials: [] };
      }));
      setSo(o);
      form.setFieldsValue({ ship_to: o.ship_to });
      show('info', `订单 ${o.no}（${o.customer_name}）已带出 ${openLines.length} 行未发明细${info.some((i) => i.serial) ? '，请逐台扫整机 SN / UDI' : ''}`, false);
      setTimeout(() => scanRef.current?.focus(), 100);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadSo(initialSoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSoId]);

  const patch = (idx: number, p: Partial<ShipLine>) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...p } : l)));
  const scannedCount = lines.reduce((s, l) => s + l.serials.length, 0);
  const planCount = lines.filter((l) => l.serial).reduce((s, l) => s + l.qty, 0);

  /** 扫码：UDI（带括号或 GS1 原始串）/ 纯 SN；拒绝时给出具体原因并响提示音，扫码框自动清空、保持焦点 */
  const onScan = async (_code: string, p: ScanResult) => {
    const sn = (p.sn || p.code).trim();
    if (!sn) return;
    if (lines.some((l) => l.serials.includes(sn))) return show('err', `${sn} 已扫描过，请勿重复扫描`);
    const r = await get('/wms/serial-check', { sn, so_id: soId }, true).catch(() => null);
    if (!r) return show('err', '校验失败，请重扫');
    if (!r.ok) return show('err', r.message);
    const cands = lines.map((l, i) => [l, i] as const).filter(([l]) => l.serial && l.line.material_id === r.material_id);
    const slot = cands.find(([l]) => l.serials.length < l.remaining);
    if (!slot) {
      const l = cands[0]?.[0];
      return show('err', l ? `${sn}：${l.line.material_code} 已扫满订单未发数量 ${fmtQty(l.remaining)}，请放回` : `${sn} 不是本订单需要发的产品`);
    }
    const [l, idx] = slot;
    const serials = [...l.serials, sn];
    patch(idx, { serials, qty: Math.max(l.qty, serials.length) });
    setOrder((o) => [sn, ...o]);
    show('ok', <>✓ <b>{sn}</b> → {l.line.material_code}（已扫 <b>{scannedCount + 1}</b> / 本次 {fmtQty(Math.max(planCount, scannedCount + 1))}）</>);
  };

  const removeSn = (sn: string) => {
    setLines((ls) => ls.map((l) => (l.serials.includes(sn) ? { ...l, serials: l.serials.filter((x) => x !== sn) } : l)));
    setOrder((o) => o.filter((x) => x !== sn));
    show('info', `已移除 ${sn}（已扫 ${scannedCount - 1}）`, false);
    setTimeout(() => scanRef.current?.focus(), 30);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const body = {
      so_id: soId,
      carrier: v.carrier,
      tracking_no: v.tracking_no,
      ship_to: v.ship_to,
      remark: v.remark,
      lines: lines
        .filter((l) => (l.serials.length || l.qty) > 0)
        .map((l) => ({ so_line_id: l.line.id, qty: l.serials.length || l.qty, serials: l.serials.length ? l.serials : undefined })),
    };
    if (!soId) return void message.warning('请选择销售订单');
    if (!body.lines.length) return void message.warning('请填写本次发货数量');
    const partialScan = lines.find((l) => l.serial && l.serials.length > 0 && l.serials.length < l.qty);
    if (partialScan && !(await modal.confirm({ title: '扫码数量少于计划数', content: `${partialScan.line.material_code} 已扫 ${partialScan.serials.length} 台，计划 ${fmtQty(partialScan.qty)} 台。按已扫的 ${partialScan.serials.length} 台发货？`, okText: '按已扫数量发货', cancelText: '继续扫码' }))) return;
    setSaving(true);
    try {
      const sh = await post('/shipments', body);
      form.resetFields();
      onCreated(sh);
    } finally {
      setSaving(false);
    }
  };

  const hasSerial = lines.some((l) => l.serial);
  const totalQty = lines.reduce((s, l) => s + (l.serials.length || l.qty || 0), 0);

  const qtyCell = (l: ShipLine, idx: number) => (
    <InputNumber min={0} max={l.remaining} precision={l.serial ? 0 : undefined} value={l.serials.length || l.qty} disabled={l.serials.length > 0}
      onChange={(v) => patch(idx, { qty: Number(v) || 0 })} style={{ width: narrow ? '100%' : 110 }} size={narrow ? 'large' : 'middle'} />
  );
  const snHint = (l: ShipLine) => {
    if (!l.serial) return <Typography.Text type="secondary">系统按先到期先出自动分配批次</Typography.Text>;
    if (l.serials.length) return <Typography.Text>已扫 <b>{l.serials.length}</b> / 本次 {fmtQty(l.qty)} 台</Typography.Text>;
    const preview = l.available.slice(0, Math.max(0, l.qty));
    return (
      <Tooltip title={preview.length ? <div className="mono">{preview.map((a) => <div key={a.sn}>{a.sn}</div>)}</div> : '暂无可发序列号'}>
        <Typography.Text type="secondary">未扫码：系统按完工先后自动选取 {fmtQty(l.qty)} 台</Typography.Text>
      </Tooltip>
    );
  };

  const columns: TableColumnsType<ShipLine> = [
    {
      title: '产品', key: 'm', width: 240,
      render: (_, l) => <MaterialCell code={l.line.material_code} name={l.line.material_name} spec={l.line.material_spec} extra={l.serial ? <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>逐台序列号</Tag> : undefined} />,
    },
    { title: '订单数', key: 'qty', width: 80, align: 'right', render: (_, l) => fmtQty(l.line.qty) },
    { title: '已发', key: 'shipped', width: 70, align: 'right', render: (_, l) => fmtQty(l.line.shipped_qty) },
    { title: '未发', key: 'remain', width: 70, align: 'right', render: (_, l) => <b>{fmtQty(l.remaining)}</b> },
    {
      title: <Tooltip title="已入库且已完成 DHR 放行的合格品">可发库存</Tooltip>, key: 'avail', width: 100, align: 'right',
      render: (_, l) => <span style={{ color: l.stockQty < l.remaining ? '#cf1322' : '#389e0d', fontWeight: 600 }}>{fmtQty(l.stockQty)}{l.serial ? ' 台' : ''}</span>,
    },
    { title: '本次发货', key: 'ship', width: 130, render: (_, l, idx) => qtyCell(l, idx) },
    {
      title: '序列号', key: 'sn', width: 300,
      render: (_, l, idx) => (
        <div>
          {snHint(l)}
          {l.serials.length > 0 && (
            <div><Button type="link" size="small" style={{ padding: 0 }} onClick={() => { patch(idx, { serials: [], qty: Math.min(l.remaining, l.available.length) }); setOrder((o) => o.filter((x) => !l.serials.includes(x))); }}>清空，改为自动选取</Button></div>
          )}
        </div>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      title={<span><SendOutlined style={{ marginRight: 8 }} />新建发货单</span>}
      width={narrow ? '100%' : 1100}
      style={narrow ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : undefined}
      onCancel={() => { form.resetFields(); onClose(); }}
      onOk={submit}
      okText={`生成发货单${totalQty ? `（${fmtQty(totalQty)}）` : ''}`}
      cancelText="返回"
      okButtonProps={{ disabled: !so || !lines.length, size: narrow ? 'large' : 'middle' }}
      cancelButtonProps={{ size: narrow ? 'large' : 'middle' }}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      // 打开即聚焦“销售订单”（可直接扫订单号）
      afterOpenChange={(o) => { if (o && !initialSoId) setTimeout(() => soBox.current?.querySelector('input')?.focus(), 60); }}
    >
      {holder}
      {!narrow && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="只能发已 DHR 放行的合格成品，序列号逐台校验；支持扫描 UDI（带括号或 DataMatrix 原始串）。未扫码时系统按完工先后自动选取已放行的整机。" />}
      <Form form={form} layout="vertical">
        <Form.Item label="销售订单（可扫订单号 / 客户 PO）" required>
          <div ref={soBox}>
          <RemoteSelect
            url="/sales-orders"
            noun="销售订单"
            matchKeys={['no', 'customer_po']}
            params={{ status: OPEN_SO }}
            labelOf={(r) => `${r.no}  ${r.customer_name ?? ''}${r.customer_po ? `（客户PO ${r.customer_po}）` : ''}`}
            value={soId}
            onChange={(v) => loadSo(v as number | undefined)}
            placeholder="扫描或输入订单号 / 客户名称（仅显示已确认未发完的订单）"
            size={narrow ? 'large' : 'middle'}
          />
          </div>
        </Form.Item>

        <Spin spinning={loading}>
          {so && (
            <Space wrap size={[16, 4]} style={{ marginBottom: 8 }}>
              <span>客户：<b>{so.customer_name}</b></span>
              {so.customer_po && <span>客户 PO：{so.customer_po}</span>}
              <span>交期：{fmtDate(so.delivery_date)}</span>
            </Space>
          )}
          {so && !lines.length && !loading && <Empty description="该订单已全部发货" />}
          {lines.length > 0 && (
            <>
              {hasSerial && (
                <div style={{ marginBottom: 12 }}>
                  <ScanInput ref={scanRef} onScan={onScan} autoFocus={false} captureGlobal placeholder="逐台扫描整机 SN 或 UDI 条码，回车添加" style={{ height: 52, fontSize: 18 }} />
                  <FeedbackBar fb={fb} />
                  {order.length > 0 && (
                    <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 6, maxHeight: 260, overflow: 'auto' }}>
                      <div style={{ fontWeight: 600, padding: '2px 4px' }}>已扫 {order.length} 台{planCount ? ` / 本次 ${fmtQty(Math.max(planCount, order.length))}` : ''}（最新在上）</div>
                      {order.map((sn, i) => (
                        <div key={sn} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', borderTop: i ? '1px solid #f5f5f5' : undefined }}>
                          <span style={{ width: 28, color: '#999' }}>{order.length - i}</span>
                          <span className="mono" style={{ flex: 1, fontSize: 16 }}>{sn}</span>
                          <Button danger icon={<DeleteOutlined />} aria-label={`删除 ${sn}`} style={{ width: 44, height: 40 }} onClick={() => removeSn(sn)} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {narrow ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {lines.map((l, idx) => (
                    <Card key={l.line.id} size="small">
                      <MaterialCell code={l.line.material_code} name={l.line.material_name} spec={l.line.material_spec} />
                      <div>未发 <b>{fmtQty(l.remaining)}</b> · 可发 {fmtQty(l.stockQty)}{l.serial ? ' 台' : ''}</div>
                      <div style={{ margin: '6px 0' }}>本次发货</div>{qtyCell(l, idx)}
                      <div style={{ marginTop: 6 }}>{snHint(l)}</div>
                    </Card>
                  ))}
                </Space>
              ) : (
                <Table rowKey={(l) => l.line.id} size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />
              )}
            </>
          )}
        </Spin>

        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col xs={24} md={8}>
            <Form.Item name="carrier" label="承运商">
              <AutoComplete options={CARRIERS} placeholder="选择或输入" filterOption={(i, o) => !!o?.value.includes(i)} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="tracking_no" label="运单号（可过账后补录）">
              <Input placeholder="快递 / 物流单号，可扫码" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="remark" label="备注">
              <Input />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="ship_to" label="收货地址">
              <Input placeholder="默认带出销售订单收货地址" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
