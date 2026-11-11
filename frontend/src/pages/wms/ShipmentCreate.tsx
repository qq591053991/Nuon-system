/** 新建发货单：选销售订单 → 自动带出未发明细 → 扫码指定序列号或系统自动选取 → 提交 */
import { Alert, AutoComplete, Button, Col, Empty, Form, Input, InputNumber, Modal, Row, Space, Spin, Table, Tag, Tooltip, Typography, message, type InputRef, type TableColumnsType } from 'antd';
import { BarcodeOutlined, CheckCircleFilled, CloseCircleFilled, SendOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { get, post, type Rec } from '../../api/http';
import RemoteSelect from '../../components/RemoteSelect';
import { fmtDate, fmtQty } from '../../utils/format';
import { MaterialCell } from './common';

interface ShipLine {
  line: Rec; // 销售订单行
  remaining: number; // 未发数量
  serial: boolean; // 是否序列号管理
  available: Rec[]; // 可发序列号（已入库且已放行，按完工先后）
  stockQty: number; // 非序列号物料：合格可发库存
  qty: number; // 本次发货数量
  serials: string[]; // 扫描指定的序列号（为空 = 系统自动选取）
}

const CARRIERS = ['顺丰速运', '京东物流', '德邦物流', '中通快运', 'DHL', 'FedEx', 'UPS', '客户自提'].map((v) => ({ value: v }));
const OPEN_SO = 'CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED';

/** 兼容扫描整串 UDI：(01)GTIN(11)生产日期(10)批号(21)序列号 */
function parseSn(raw: string): string {
  const s = raw.trim();
  const m = s.match(/\(21\)([^()]+)/);
  return (m ? m[1] : s).trim();
}

export default function ShipmentCreate({ open, initialSoId, onClose, onCreated }: {
  open: boolean;
  initialSoId?: number;
  onClose: () => void;
  onCreated: (sh: Rec) => void;
}) {
  const [form] = Form.useForm();
  const [soId, setSoId] = useState<number | undefined>();
  const [so, setSo] = useState<Rec | null>(null);
  const [lines, setLines] = useState<ShipLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scan, setScan] = useState('');
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const scanRef = useRef<InputRef>(null);
  const seq = useRef(0);

  const loadSo = async (id?: number) => {
    const my = ++seq.current;
    setSoId(id);
    setSo(null);
    setLines([]);
    setLast(null);
    if (!id) return;
    setLoading(true);
    try {
      const order: Rec = await get(`/sales-orders/${id}`);
      const openLines = (order.lines as Rec[]).filter((l) => l.qty - (l.shipped_qty || 0) > 1e-9);
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
      const used = new Map<number, number>(); // 同一物料多行时依次分配可发数量
      setLines(openLines.map((l) => {
        const i = byMat.get(l.material_id)!;
        const remaining = Math.round((l.qty - (l.shipped_qty || 0)) * 10000) / 10000;
        const left = Math.max(0, i.stockQty - (used.get(l.material_id) || 0));
        const qty = Math.min(remaining, i.serial ? Math.floor(left) : left);
        used.set(l.material_id, (used.get(l.material_id) || 0) + qty);
        return { line: l, remaining, serial: i.serial, available: i.available, stockQty: i.stockQty, qty, serials: [] };
      }));
      setSo(order);
      form.setFieldsValue({ ship_to: order.ship_to });
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setScan('');
      loadSo(initialSoId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSoId]);

  const patch = (idx: number, p: Partial<ShipLine>) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...p } : l)));

  const onScan = (raw: string) => {
    setScan('');
    scanRef.current?.focus();
    const sn = parseSn(raw);
    if (!sn) return;
    if (lines.some((l) => l.serials.includes(sn))) {
      setLast({ ok: false, text: `${sn} 已扫描过，请勿重复扫描` });
      return;
    }
    const idx = lines.findIndex((l) => l.serial && l.serials.length < l.remaining && l.available.some((a) => a.sn === sn));
    if (idx < 0) {
      const full = lines.find((l) => l.serial && l.available.some((a) => a.sn === sn));
      setLast({
        ok: false,
        text: full
          ? `${sn}：${full.line.material_code} 已扫满未发数量 ${fmtQty(full.remaining)}`
          : `${sn} 不可发货：不是本订单的产品，或未入库 / 未完成 DHR 放行 / 已发货`,
      });
      return;
    }
    const l = lines[idx];
    const serials = [...l.serials, sn];
    patch(idx, { serials, qty: serials.length });
    setLast({ ok: true, text: `${sn} → ${l.line.material_code}（已扫 ${serials.length} / ${fmtQty(l.remaining)}）` });
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
    if (!soId) return message.warning('请选择销售订单');
    if (!body.lines.length) return message.warning('请填写本次发货数量');
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

  const columns: TableColumnsType<ShipLine> = [
    {
      title: '产品', key: 'm', width: 240,
      render: (_, l) => (
        <MaterialCell
          code={l.line.material_code}
          name={l.line.material_name}
          spec={l.line.material_spec}
          extra={l.serial ? <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>逐台序列号</Tag> : undefined}
        />
      ),
    },
    { title: '订单数', key: 'qty', width: 80, align: 'right', render: (_, l) => fmtQty(l.line.qty) },
    { title: '已发', key: 'shipped', width: 70, align: 'right', render: (_, l) => fmtQty(l.line.shipped_qty) },
    { title: '未发', key: 'remain', width: 70, align: 'right', render: (_, l) => <b>{fmtQty(l.remaining)}</b> },
    {
      title: <Tooltip title="已入库且已完成 DHR 放行的合格品">可发库存</Tooltip>, key: 'avail', width: 100, align: 'right',
      render: (_, l) => (
        <span style={{ color: l.stockQty < l.remaining ? '#cf1322' : '#389e0d', fontWeight: 600 }}>
          {fmtQty(l.stockQty)}{l.serial ? ' 台' : ''}
        </span>
      ),
    },
    {
      title: '本次发货', key: 'ship', width: 130,
      render: (_, l, idx) => (
        <InputNumber
          min={0}
          max={l.remaining}
          precision={l.serial ? 0 : undefined}
          value={l.serials.length || l.qty}
          disabled={l.serials.length > 0}
          onChange={(v) => patch(idx, { qty: Number(v) || 0 })}
          style={{ width: 110 }}
        />
      ),
    },
    {
      title: '序列号 / 批次', key: 'sn', width: 380,
      render: (_, l, idx) => {
        if (!l.serial) return <Typography.Text type="secondary">系统按先到期先出自动分配批次</Typography.Text>;
        if (!l.serials.length) {
          const preview = l.available.slice(0, Math.max(0, l.qty));
          return (
            <Tooltip title={preview.length ? <div className="mono">{preview.map((a) => <div key={a.sn}>{a.sn}</div>)}</div> : '暂无可发序列号'}>
              <Typography.Text type="secondary">未扫码：系统按完工先后自动选取 {fmtQty(l.qty)} 台</Typography.Text>
            </Tooltip>
          );
        }
        return (
          <div>
            <Space size={[4, 4]} wrap style={{ maxHeight: 96, overflow: 'auto' }}>
              {l.serials.map((sn) => (
                <Tag
                  key={sn}
                  closable
                  className="mono"
                  style={{ marginInlineEnd: 0 }}
                  onClose={(e) => {
                    e.preventDefault();
                    const serials = l.serials.filter((x) => x !== sn);
                    patch(idx, { serials, qty: serials.length });
                  }}
                >
                  {sn}
                </Tag>
              ))}
            </Space>
            <div>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => patch(idx, { serials: [], qty: Math.min(l.remaining, l.available.length) })}>
                清空，改为自动选取
              </Button>
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      title={<span><SendOutlined style={{ marginRight: 8 }} />新建发货单</span>}
      width={1100}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={submit}
      okText={`生成发货单${totalQty ? `（${fmtQty(totalQty)}）` : ''}`}
      okButtonProps={{ disabled: !so || !lines.length }}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
    >
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="只能发已 DHR 放行的合格成品，序列号逐台校验；未扫码时系统按完工先后自动选取已放行的整机。" />
      <Form form={form} layout="vertical">
        <Form.Item label="销售订单" required>
          <RemoteSelect
            url="/sales-orders"
            params={{ status: OPEN_SO }}
            labelOf={(r) => `${r.no}  ${r.customer_name ?? ''}${r.customer_po ? `（客户PO ${r.customer_po}）` : ''}`}
            value={soId}
            onChange={(v) => loadSo(v as number | undefined)}
            placeholder="输入订单号 / 客户名称搜索（仅显示已确认未发完的订单）"
          />
        </Form.Item>

        <Spin spinning={loading}>
          {so && (
            <Space wrap size={[16, 4]} style={{ marginBottom: 12 }}>
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
                  <Input
                    ref={scanRef}
                    size="large"
                    autoFocus
                    allowClear
                    prefix={<BarcodeOutlined />}
                    placeholder="扫描整机序列号或 UDI 条码，回车添加（可选：不扫则系统自动选取）"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    onPressEnter={() => onScan(scan)}
                  />
                  {last && (
                    <div style={{ marginTop: 6, color: last.ok ? '#389e0d' : '#cf1322' }}>
                      {last.ok ? <CheckCircleFilled /> : <CloseCircleFilled />} {last.text}
                    </div>
                  )}
                </div>
              )}
              <Table rowKey={(l) => l.line.id} size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />
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
            <Form.Item name="tracking_no" label="运单号">
              <Input placeholder="快递 / 物流单号" />
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
