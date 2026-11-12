import {
  Alert, App, Button, Card, Checkbox, Col, Collapse, DatePicker, Descriptions, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Progress, Result, Row,
  Select, Space, Spin, Steps, Table, Tag, Timeline, Tooltip, Typography, message, type TableColumnsType,
} from 'antd';
import {
  ArrowLeftOutlined, CarOutlined, CheckOutlined, CopyOutlined, DownOutlined, EditOutlined, PlusOutlined, RollbackOutlined, SaveOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { PrintButton, PrintHeader, PrintSignatures } from '../../components/Print';
import { CustomerSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, toDate } from '../../utils/format';
import {
  CURRENCY_OPTIONS, DueDate, KittingTable, OrderLinesEditor, QtyProgress, checkLines, isPast, kittingSummary, linesBody, sumBy, toDayjs, uid,
  type LineLock, type LineRow,
} from './shared';

const ACTIVE = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'];
const STEP_OF: Record<string, number> = { DRAFT: 0, CONFIRMED: 1, IN_PRODUCTION: 2, PARTIAL_SHIPPED: 3, SHIPPED: 4, CLOSED: 4 };
/** 打印形式发票时的卖方名称（部署时用 VITE_COMPANY_NAME 配置；未配置则不打印卖方抬头） */
const COMPANY = (import.meta as any).env?.VITE_COMPANY_NAME as string | undefined;

const NEXT_HINT: Record<string, string> = {
  DRAFT: '草稿可随时修改；确认后进入生产计划（MRP 只统计已确认订单）。',
  CONFIRMED: '下一步：计划员点【生成工单】（先预览，按交期倒排开工）；需要改数量/交期请点【变更】，还没排产也可【撤销确认】退回草稿。',
  IN_PRODUCTION: '生产进行中。成品完工入库并经 QA 放行后即可【发货】。客户改数量/交期请点【变更】，系统会提示受影响的工单。',
  PARTIAL_SHIPPED: '已部分发货。剩余数量放行后可继续发货；客户不再需要时可【关闭（短交结案）】。',
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

// ---------------- 新建客户（销售可直接建档） ----------------
function QuickCustomerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Rec) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const c = await post('/customers', { ...v, is_active: true });
      message.success(`客户 ${c.code} ${c.name} 已建档`);
      onCreated(c);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} title="新建客户" okText="保存客户" onOk={submit} confirmLoading={saving} onCancel={onClose} destroyOnHidden maskClosable={false} width={640}
      afterOpenChange={(o) => o && form.resetFields()}>
      <Typography.Paragraph type="secondary">
        先建基本信息即可下单；质量协议、注册人等资料可稍后在【基础资料 → 客户】补全。代工产品需由工程部在物料中设置“所属品牌客户”后才能卖给该客户。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ currency: 'CNY', payment_terms_days: 30 }}>
        <Row gutter={16}>
          <Col span={8}><Form.Item name="code" label="客户编码" rules={[{ required: true, message: '请填写客户编码' }]}><Input autoFocus placeholder="如 C004" /></Form.Item></Col>
          <Col span={16}><Form.Item name="name" label="客户名称" rules={[{ required: true, message: '请填写客户名称' }]}><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="short_name" label="简称"><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="country" label="国家/地区"><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="currency" label="结算币别"><Select options={CURRENCY_OPTIONS} /></Form.Item></Col>
          <Col span={8}><Form.Item name="contact" label="联系人"><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="phone" label="电话"><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="payment_terms_days" label="账期（天）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={24}><Form.Item name="address" label="收货地址"><Input /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}

// ---------------- 编辑（新建 / 草稿 / 已确认订单变更） ----------------
type EditMode = 'new' | 'draft' | 'change';

function SoEditor({ so, mode, copyFrom, onSaved, onExit }: { so: Rec | null; mode: EditMode; copyFrom?: Rec | null; onSaved: (d: Rec) => void; onExit?: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { modal } = App.useApp();
  const [form] = Form.useForm();
  const src = so ?? copyFrom ?? null;
  const [lines, setLines] = useState<LineRow[]>(() => {
    if (so?.lines?.length) return so.lines.map((l: Rec) => ({ ...l, _key: uid() }));
    if (copyFrom?.lines?.length) {
      return copyFrom.lines.map((l: Rec) => ({
        material_id: l.material_id, material_code: l.material_code, material_name: l.material_name, material_spec: l.material_spec, uom: l.uom,
        qty: l.qty, unit_price: l.unit_price, remark: l.remark, delivery_date: null, _key: uid(),
      }));
    }
    return [{ _key: uid() }];
  });
  const [busy, setBusy] = useState<string>();
  const [custOpen, setCustOpen] = useState(false);
  const [dupPo, setDupPo] = useState<Rec[]>([]);
  const [prices, setPrices] = useState<Record<number, Rec>>({});
  const [reason, setReason] = useState('');
  const [impact, setImpact] = useState<Rec | null>(null);
  const [checking, setChecking] = useState(false);
  const currency: string = Form.useWatch('currency', form) || src?.currency || 'CNY';
  const delivery = Form.useWatch('delivery_date', form);
  const customerId: number | undefined = Form.useWatch('customer_id', form) ?? so?.customer_id ?? copyFrom?.customer_id;
  const isChange = mode === 'change';

  // 同一客户 PO 号重复提示
  const checkPo = useCallback(async () => {
    const po = (form.getFieldValue('customer_po') || '').trim();
    const cid = form.getFieldValue('customer_id');
    if (!po || !cid) {
      setDupPo([]);
      return [];
    }
    const rows: Rec[] = await get('/sales-orders/check-po', { customer_id: cid, customer_po: po, exclude_id: so?.id }, true).catch(() => []);
    setDupPo(rows);
    return rows;
  }, [form, so?.id]);

  // 上次成交价：客户 + 产品变化时取一次
  const materialKey = useMemo(() => [...new Set(lines.map((l) => l.material_id).filter(Boolean))].sort().join(','), [lines]);
  useEffect(() => {
    if (!customerId || !materialKey || !can('sales')) return;
    let off = false;
    get('/sales-orders/last-prices', { customer_id: customerId, material_ids: materialKey, exclude_id: so?.id }, true)
      .then((d: Rec) => {
        if (off) return;
        setPrices(d);
        if (isChange) return;
        // 新录的行没填单价：带出上次成交价（币别相同才带）
        setLines((rows) =>
          rows.map((r) => {
            const h = r.material_id ? d[r.material_id] : null;
            return h && (r.unit_price === undefined || r.unit_price === null || r.unit_price === '') && h.currency === (form.getFieldValue('currency') || 'CNY')
              ? { ...r, unit_price: h.unit_price }
              : r;
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [customerId, materialKey, isChange, form, can, so?.id]);

  const priceHint = (mid: number) => {
    const h = prices[mid];
    if (!h) return undefined;
    return { price: h.unit_price, text: `上次 ${fmtMoney(h.unit_price, h.currency)}（${h.so_no}）` };
  };

  // 变更：行级锁定（已排产/已发货的行不能换产品、不能删；数量不少于已发货）
  const lockedRow = (r: LineRow): LineLock | null => {
    if (!isChange || !r.id) return null;
    const shipped = Number(r.shipped_qty) || 0;
    const planned = Number(r.planned_qty) || 0;
    const busyLine = shipped > 0 || planned > 0;
    return {
      material: busyLine ? `已${planned > 0 ? '排产' : '发货'}，不能更换产品；如需换产品请另起一行` : undefined,
      price: shipped > 0 ? '已发货（已生成应收），不能修改单价' : undefined,
      noDelete: busyLine ? `已${planned > 0 ? '排产' : '发货'}，不能删除；可把数量改为已发货数量` : undefined,
      minQty: shipped,
      qtyHint: [shipped > 0 ? `已发 ${fmtQty(shipped)}` : '', planned > 0 ? `已排产 ${fmtQty(planned)}` : ''].filter(Boolean).join(' · ') || undefined,
    };
  };

  // 变更：实时预览影响（差异、阻止项、受影响工单）
  const changeBody = useCallback(() => {
    const v = form.getFieldsValue();
    return {
      delivery_date: toDate(v.delivery_date), customer_po: v.customer_po ?? null, ship_to: v.ship_to ?? null, remark: v.remark ?? null,
      lines: linesBody(lines, 'delivery_date', { withId: true }),
    };
  }, [form, lines]);
  const previewTimer = useRef<any>();
  const runPreview = useCallback(() => {
    if (!isChange || !so) return;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      setChecking(true);
      try {
        setImpact(await post(`/sales-orders/${so.id}/change`, { ...changeBody(), preview: true }, true));
      } catch {
        /* 预览失败不弹窗 */
      } finally {
        setChecking(false);
      }
    }, 350);
  }, [isChange, so, changeBody]);
  useEffect(() => {
    runPreview();
  }, [lines, runPreview]);

  const save = async (andConfirm: boolean) => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const err = checkLines(lines, '产品');
    if (err) {
      message.error(err);
      return;
    }
    const dups = await checkPo();
    if (dups.length) {
      const ok = await modal.confirm({
        title: '客户 PO 号重复',
        content: `该客户的 PO 号“${v.customer_po}”已用于 ${dups.map((d) => `${d.no}（${dictLabel('so_status', d.status)}）`).join('、')}。确定不是重复下单？`,
        okText: '不是重复，继续保存',
        cancelText: '返回检查',
      });
      if (!ok) return;
    }
    const body = { ...v, order_date: toDate(v.order_date), delivery_date: toDate(v.delivery_date), lines: linesBody(lines, 'delivery_date', { withId: mode === 'draft' }) };
    setBusy(andConfirm ? 'confirm' : 'save');
    let saved: Rec | null = null;
    try {
      saved = so ? await put(`/sales-orders/${so.id}`, body) : await post('/sales-orders', body);
      if (andConfirm) {
        await post(`/sales-orders/${saved!.id}/confirm`);
        message.success('订单已确认，下一步：计划员生成工单');
      } else {
        message.success('草稿已保存');
      }
    } finally {
      setBusy(undefined);
      if (saved) onSaved(saved);
    }
  };

  const submitChange = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const err = checkLines(lines, '产品');
    if (err) {
      message.error(err);
      return;
    }
    if (!reason.trim()) {
      message.error('请填写变更原因（如：客户邮件要求追加 5 台）');
      return;
    }
    setBusy('change');
    try {
      const r = await post(`/sales-orders/${so!.id}/change`, { ...changeBody(), reason });
      message.success(`订单已变更：${r.changes.join('；')}`);
      if (r.affected?.length || r.warnings?.length) {
        modal.info({
          title: '变更已保存，请跟进以下事项',
          width: 640,
          content: (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {[...(r.warnings || []), ...(r.affected || []).map((a: Rec) => a.message)].map((t: string) => <li key={t}>{t}</li>)}
            </ul>
          ),
        });
      }
      onSaved(r.order);
    } finally {
      setBusy(undefined);
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

  const title = isChange ? (
    <Space>变更订单 {so!.no}<StatusTag dict="so_status" value={so!.status} /></Space>
  ) : so ? (
    <Space>销售订单 {so.no}<StatusTag dict="so_status" value={so.status} /></Space>
  ) : copyFrom ? (
    `新建销售订单（复制自 ${copyFrom.no}）`
  ) : (
    '新建销售订单'
  );

  return (
    <>
      <PageHeader
        title={title}
        sub={
          isChange
            ? '修改数量、交期、单价后填写变更原因提交；系统校验已发货/已排产数量并提示受影响的工单，全部变更记入审计追踪'
            : so
              ? `创建人 ${so.created_by ?? '-'} · ${fmtDateTime(so.created_at)}`
              : '选择客户与产品，填写数量、单价和交期（明细行可全程用键盘：回车跳下一格）'
        }
        extra={
          isChange ? (
            <>
              <Button onClick={onExit}>放弃变更</Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={busy === 'change'}
                disabled={!!impact?.errors?.length}
                onClick={submitChange}
              >
                提交变更
              </Button>
            </>
          ) : (
            <>
              <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/sales/orders')}>返回列表</Button>
              {so && (
                <Popconfirm title="确定取消该订单？" description="取消后不可恢复。" okText="确认取消订单" cancelText="不取消" okButtonProps={{ danger: true }} onConfirm={cancelOrder}>
                  <Button danger loading={busy === 'cancel'}>取消订单</Button>
                </Popconfirm>
              )}
              <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy && busy !== 'save'} onClick={() => save(false)}>保存草稿</Button>
              <Button type="primary" icon={<CheckOutlined />} loading={busy === 'confirm'} disabled={!!busy && busy !== 'confirm'} onClick={() => save(true)}>
                保存并确认订单
              </Button>
            </>
          )
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {!isChange && <Card size="small"><SoSteps so={so} /></Card>}
        <Card title="订单信息" size="small">
          <Form
            form={form}
            layout="vertical"
            onValuesChange={(ch) => {
              if (isChange) runPreview();
              if ('customer_id' in ch) setDupPo([]);
            }}
            initialValues={
              src
                ? {
                    customer_id: src.customer_id, order_date: so ? toDayjs(so.order_date) : dayjs(), delivery_date: so ? toDayjs(so.delivery_date) : undefined,
                    customer_po: so ? so.customer_po : undefined, currency: src.currency, ship_to: src.ship_to, remark: so ? so.remark : src.remark,
                  }
                : { order_date: dayjs(), currency: 'CNY' }
            }
          >
            <Row gutter={16}>
              <Col xs={24} md={12} lg={8}>
                <Form.Item label="客户（品牌方/注册人）" required style={{ marginBottom: 0 }}>
                  <Space.Compact style={{ width: '100%' }}>
                    <Form.Item name="customer_id" noStyle rules={[{ required: true, message: '请选择客户' }]}>
                      <CustomerSelect
                        autoFocus={mode === 'new' && !copyFrom}
                        disabled={isChange}
                        params={{ is_active: true }}
                        onPick={(c) => {
                          if (!c) return;
                          form.setFieldsValue({ currency: c.currency || 'CNY' });
                          if (!form.getFieldValue('ship_to') && c.address) form.setFieldsValue({ ship_to: c.address });
                        }}
                      />
                    </Form.Item>
                    {!isChange && can('master', 'sales') && (
                      <Tooltip title="新客户：直接建档">
                        <Button icon={<PlusOutlined />} onClick={() => setCustOpen(true)} tabIndex={-1} />
                      </Tooltip>
                    )}
                  </Space.Compact>
                </Form.Item>
                {!isChange && !can('master', 'sales') && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>新客户请联系销售或工程部在【基础资料 → 客户】建档</Typography.Text>
                )}
                <div style={{ height: 24 }} />
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="order_date" label="下单日期"><DatePicker style={{ width: '100%' }} allowClear={false} disabled={isChange} /></Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="delivery_date" label="交期" tooltip="订单行未单独填写交期时，按此日期倒排生产">
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="customer_po" label="客户PO号" validateStatus={dupPo.length ? 'warning' : undefined}>
                  <Input placeholder="客户采购单号" onBlur={checkPo} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6} lg={4}>
                <Form.Item name="currency" label="币别"><Select options={CURRENCY_OPTIONS} disabled={isChange} /></Form.Item>
              </Col>
              {dupPo.length > 0 && (
                <Col span={24}>
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message={
                      <span>
                        该客户的 PO 号已用于{' '}
                        {dupPo.map((d, i) => (
                          <span key={d.id}>
                            {i > 0 && '、'}
                            <Link to={`/sales/orders/${d.id}`} target="_blank">{d.no}</Link>（{dictLabel('so_status', d.status)}，{fmtDate(d.order_date)}）
                          </span>
                        ))}
                        ，请确认不是重复下单（分批交货可在备注中注明）
                      </span>
                    }
                  />
                </Col>
              )}
              <Col xs={24} md={12}>
                <Form.Item name="ship_to" label="收货地址"><Input placeholder="默认带出客户地址" /></Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="remark" label="备注"><Input /></Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
        <Card
          title="订单明细"
          size="small"
          extra={<Typography.Text type="secondary">产品下拉只列该客户品牌的产品（代工产品只能卖给注册人/品牌方）</Typography.Text>}
        >
          {!customerId && !isChange && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="先选客户，产品下拉会只列出该客户的产品" />}
          <OrderLinesEditor
            value={lines}
            onChange={setLines}
            dateField="delivery_date"
            dateLabel="交期"
            currency={currency}
            materialLabel="产品"
            materialParams={{ category: 'FINISHED', is_active: true, ...(customerId ? { customer_id: customerId } : {}) }}
            materialEmpty={customerId ? '该客户还没有可销售的产品：请工程部在物料中把成品的“所属品牌客户”设为该客户' : undefined}
            defaultDate={delivery ? dayjs(delivery).format('YYYY-MM-DD') : null}
            priceHint={priceHint}
            lockedRow={lockedRow}
          />
        </Card>
        {isChange && (
          <Card title="变更原因与影响" size="small">
            <Row gutter={24}>
              <Col xs={24} lg={10}>
                <Typography.Text strong>变更原因（必填，记入审计追踪）</Typography.Text>
                <Input.TextArea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="如：客户 11-12 邮件要求追加 5 台，交期提前到 12-20"
                  style={{ marginTop: 8 }}
                  status={!reason.trim() && impact?.changes?.length ? 'warning' : undefined}
                />
              </Col>
              <Col xs={24} lg={14}>
                <Spin spinning={checking}>
                  {!impact?.changes?.length && !impact?.errors?.length && <Typography.Text type="secondary">修改数量、交期或单价后，这里会显示变更内容和受影响的工单。</Typography.Text>}
                  {!!impact?.errors?.length && (
                    <Alert type="error" showIcon message="以下修改不能保存" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{impact.errors.map((t: string) => <li key={t}>{t}</li>)}</ul>} style={{ marginBottom: 8 }} />
                  )}
                  {!!impact?.changes?.length && (
                    <Alert type="info" showIcon message="本次变更" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{impact.changes.map((t: string) => <li key={t}>{t}</li>)}</ul>} style={{ marginBottom: 8 }} />
                  )}
                  {!!(impact?.affected?.length || impact?.warnings?.length) && (
                    <Alert
                      type="warning"
                      showIcon
                      message="受影响的工单 / 需跟进"
                      description={
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {(impact.warnings || []).map((t: string) => <li key={t}>{t}</li>)}
                          {(impact.affected || []).map((a: Rec) => (
                            <li key={a.message}>
                              <Link to={`/mes/work-orders/${a.wo_id}`} target="_blank">{a.wo_no}</Link>：{a.message}
                            </li>
                          ))}
                        </ul>
                      }
                    />
                  )}
                </Spin>
              </Col>
            </Row>
          </Card>
        )}
      </Space>
      <QuickCustomerModal
        open={custOpen}
        onClose={() => setCustOpen(false)}
        onCreated={(c) => {
          form.setFieldsValue({ customer_id: c.id, currency: c.currency || 'CNY', ...(c.address ? { ship_to: c.address } : {}) });
        }}
      />
    </>
  );
}

// ---------------- 生成工单预览（下推前预览） ----------------
function WoPlanModal({ so, open, onClose, onDone }: { so: Rec; open: boolean; onClose: () => void; onDone: (r: Rec) => void }) {
  const [plan, setPlan] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [link, setLink] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    get(`/sales-orders/${so.id}/work-order-plan`).then((p: Rec) => {
      setPlan(p);
      setRows(p.lines.map((l: Rec) => ({ ...l, gen_qty: l.suggest_qty })));
      const used = new Set(p.lines.flatMap((l: Rec) => (l.free_sources || []).filter((s: Rec) => s.type === 'WO').map((s: Rec) => s.id)));
      setLink(p.linkable_work_orders.filter((w: Rec) => used.has(w.id)).map((w: Rec) => w.id));
    });
  }, [open, so.id]);
  const set = (id: number, p: Rec) => setRows((rs) => rs.map((r) => (r.line_id === id ? { ...r, ...p } : r)));
  const total = rows.reduce((s, r) => s + (Number(r.gen_qty) || 0), 0);
  const submit = async () => {
    setSaving(true);
    try {
      const r = await post(`/sales-orders/${so.id}/create-work-orders`, {
        lines: rows.filter((r) => Number(r.gen_qty) > 0).map((r) => ({ so_line_id: r.line_id, qty: Number(r.gen_qty), planned_start: r.planned_start, planned_end: r.planned_end })),
        link_wo_ids: link,
      });
      onDone(r);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  const cols: TableColumnsType<Rec> = [
    { title: '行', dataIndex: 'line_no', width: 44 },
    { title: '产品', key: 'p', render: (_, r) => <div><span className="mono">{r.material_code}</span><div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_name}</Typography.Text></div></div> },
    { title: '订单 / 已发', key: 'q', align: 'right', render: (_, r) => <span>{fmtQty(r.qty)}{r.shipped_qty > 0 && <Typography.Text type="secondary"> / {fmtQty(r.shipped_qty)}</Typography.Text>}</span> },
    {
      title: '已排产', key: 'wo', align: 'right',
      render: (_, r) => (r.wo_qty > 0 ? <Tooltip title={r.wo_nos.join('、')}>{fmtQty(r.wo_qty)}</Tooltip> : '-'),
    },
    {
      title: <Tooltip title="成品库存、未关联订单的在制工单，按交期先后分摊给各订单">库存/其他工单覆盖</Tooltip>, key: 'free', align: 'right',
      render: (_, r) => (r.free_qty > 0 ? <Tooltip title={r.notes.join('；')}>{fmtQty(r.free_qty)}</Tooltip> : '-'),
    },
    {
      title: '本次生成', key: 'n', width: 130,
      render: (_, r) => (
        <InputNumber min={0} precision={r.serial_control ? 0 : 4} value={r.gen_qty} disabled={!r.has_bom} onChange={(v) => set(r.line_id, { gen_qty: v })} style={{ width: 110 }}
          status={r.gen_qty > r.uncovered + 1e-9 ? 'warning' : undefined} />
      ),
    },
    {
      title: <Tooltip title="按交期倒排：开工 = 交期 − 生产周期（不早于今天），完工 = 交期">计划开工 ~ 完工</Tooltip>, key: 'd', width: 280,
      render: (_, r) => (
        <DatePicker.RangePicker
          size="small"
          allowClear={false}
          value={[dayjs(r.planned_start), dayjs(r.planned_end)]}
          onChange={(v) => v && set(r.line_id, { planned_start: toDate(v[0]), planned_end: toDate(v[1]) })}
          style={{ width: 250 }}
        />
      ),
    },
    {
      title: '说明', key: 'notes', width: 260,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          {r.tight && r.gen_qty > 0 && <Typography.Text type="warning" style={{ fontSize: 12 }}>交期紧张，开工已压到今天</Typography.Text>}
          {r.gen_qty > r.uncovered + 1e-9 && <Typography.Text type="warning" style={{ fontSize: 12 }}>超过未覆盖数量 {fmtQty(r.uncovered)}，多出的将成为库存</Typography.Text>}
          {r.notes.map((t: string) => <Typography.Text key={t} type="secondary" style={{ fontSize: 12 }}>{t}</Typography.Text>)}
        </Space>
      ),
    },
  ];
  return (
    <Modal open={open} title={`生成工单预览 - ${so.no}`} width={1100} onCancel={onClose} destroyOnHidden maskClosable={false}
      okText={total > 0 || link.length ? `确认生成${total > 0 ? `（${fmtQty(total)}）` : ''}` : '没有需要生成的'} okButtonProps={{ disabled: !(total > 0 || link.length) }}
      onOk={submit} confirmLoading={saving}>
      {!plan ? (
        <Spin style={{ display: 'block', padding: 40 }} />
      ) : (
        <>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            message="本次生成 = 订单数量 − 本订单已排产 − 已由库存或未关联订单的工单覆盖的数量（与 MRP 口径一致，不会重复排产）。数量和日期可改。" />
          <Table rowKey="line_id" size="small" columns={cols} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} />
          {plan.linkable_work_orders.length > 0 && (
            <Card size="small" style={{ marginTop: 12 }} title="未关联订单的同产品工单（勾选后关联到本订单，不新建）">
              <Checkbox.Group value={link} onChange={(v) => setLink(v as number[])}>
                <Space direction="vertical">
                  {plan.linkable_work_orders.map((w: Rec) => (
                    <Checkbox key={w.id} value={w.id}>
                      <Link to={`/mes/work-orders/${w.id}`} target="_blank" className="mono">{w.no}</Link> {w.material_code} 未入库 {fmtQty(w.qty)} · {dictLabel('wo_status', w.status)}
                      {w.planned_end ? ` · 计划完工 ${fmtDate(w.planned_end)}` : ''}
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            </Card>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------- 变更记录 ----------------
const HIST_FIELDS: Record<string, string> = {
  status: '状态', qty: '数量', unit_price: '单价', amount: '金额', delivery_date: '交期', customer_po: '客户PO号', ship_to: '收货地址', remark: '备注',
  material_id: '产品', total_amount: '订单金额', change_reason: '原因',
};
function SoHistory({ soId, refreshKey }: { soId: number; refreshKey: number }) {
  const [rows, setRows] = useState<Rec[] | null>(null);
  useEffect(() => {
    get(`/sales-orders/${soId}/history`, undefined, true).then(setRows).catch(() => setRows([]));
  }, [soId, refreshKey]);
  if (!rows) return <Spin />;
  const shown = rows.filter((r) => r.action !== 'CREATE' || r.target === 'ORDER');
  if (!shown.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无变更记录" />;
  const val = (k: string, v: any) => (v === null || v === undefined || v === '' ? '空' : k === 'status' ? dictLabel('so_status', String(v)) : String(v));
  return (
    <Timeline
      items={shown.map((r) => {
        const ch: Rec = r.changes || {};
        let text: string;
        if (ch.change_reason) text = String(Array.isArray(ch.change_reason) ? ch.change_reason[1] : ch.change_reason);
        else if (r.action === 'CREATE') text = '创建订单';
        else if (r.action === 'DELETE') text = `删除第 ${r.line_no ?? '?'} 行`;
        else {
          text = (r.target === 'LINE' ? `第 ${r.line_no ?? '?'} 行 ` : '') +
            Object.keys(ch)
              .filter((k) => HIST_FIELDS[k] && Array.isArray(ch[k]))
              .map((k) => `${HIST_FIELDS[k]} ${val(k, ch[k][0])} → ${val(k, ch[k][1])}`)
              .join('；');
        }
        return {
          color: ch.change_reason ? 'orange' : 'gray',
          children: (
            <span style={{ fontSize: 13 }}>
              <Typography.Text type="secondary">{fmtDateTime(r.ts)} {r.full_name}</Typography.Text> {text || '（系统字段更新）'}
            </span>
          ),
        };
      })}
    />
  );
}

// ---------------- 形式发票（打印） ----------------
function ProformaInvoice({ so, customer }: { so: Rec; customer: Rec | null }) {
  const cell = { border: '1px solid #000', padding: '3px 6px', fontSize: 11 } as const;
  return (
    <div className="print-only">
      <PrintHeader title="形式发票 PROFORMA INVOICE" no={so.no} extra={<div>日期 Date：{fmtDate(so.order_date)}</div>} />
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <tbody>
          <tr>
            <td style={{ ...cell, width: '50%', verticalAlign: 'top' }}>
              <b>买方 Buyer</b><br />
              {customer?.name ?? so.customer_name}<br />
              {customer?.address || so.ship_to || ''}<br />
              {[customer?.contact, customer?.phone, customer?.email].filter(Boolean).join(' / ')}
              {customer?.tax_no ? <><br />税号 Tax No.：{customer.tax_no}</> : null}
            </td>
            <td style={{ ...cell, verticalAlign: 'top' }}>
              {COMPANY ? <><b>卖方 Seller</b><br />{COMPANY}<br /></> : null}
              客户订单号 Customer PO：{so.customer_po || '-'}<br />
              币别 Currency：{so.currency}<br />
              交期 Delivery：{fmtDate(so.delivery_date)}<br />
              付款条件 Payment：{customer?.payment_terms_days != null ? `${customer.payment_terms_days} 天 / ${customer.payment_terms_days} days` : '-'}<br />
              收货地址 Ship to：{so.ship_to || customer?.address || '-'}
            </td>
          </tr>
        </tbody>
      </table>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['No.', '产品编码 Item', '品名/规格 Description', '数量 Qty', '单位 Unit', `单价 Unit Price (${so.currency})`, `金额 Amount (${so.currency})`, '交期 Delivery'].map((h) => (
              <th key={h} style={{ ...cell, background: '#f0f0f0' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(so.lines as Rec[]).map((l) => (
            <tr key={l.id}>
              <td style={cell}>{l.line_no}</td>
              <td style={cell}>{l.material_code}</td>
              <td style={cell}>{l.material_name}{l.material_spec ? ` / ${l.material_spec}` : ''}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmtQty(l.qty)}</td>
              <td style={cell}>{l.uom}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmtMoney(l.unit_price, so.currency)}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmtMoney(l.amount, so.currency)}</td>
              <td style={cell}>{fmtDate(l.delivery_date || so.delivery_date)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...cell, textAlign: 'right' }} colSpan={6}><b>合计 Total</b></td>
            <td style={{ ...cell, textAlign: 'right' }}><b>{fmtMoney(so.total_amount, so.currency)}</b></td>
            <td style={cell} />
          </tr>
        </tbody>
      </table>
      {so.remark && <p style={{ fontSize: 11, marginTop: 8 }}>备注 Remarks：{so.remark}</p>}
      <PrintSignatures roles={['卖方（签章）Seller', '买方（签章）Buyer']} />
    </div>
  );
}

// ---------------- 查看（已确认及之后） ----------------
function SoView({ so, reload, onChange }: { so: Rec; reload: () => Promise<unknown>; onChange: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { modal } = App.useApp();
  const [busy, setBusy] = useState<string>();
  const [woResult, setWoResult] = useState<Rec | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [unconfirmOpen, setUnconfirmOpen] = useState(false);
  const [unReason, setUnReason] = useState('');
  const [kit, setKit] = useState<Rec | null>(null);
  const [kitLoading, setKitLoading] = useState(false);
  const [customer, setCustomer] = useState<Rec | null>(null);
  const [histKey, setHistKey] = useState(0);
  const st: string = so.status;
  const active = ACTIVE.includes(st);
  const wos: Rec[] = so.work_orders || [];
  const shipments: Rec[] = so.shipments || [];
  const liveWos = wos.filter((w) => w.status !== 'CANCELLED');
  const liveShip = shipments.filter((s) => s.status !== 'CANCELLED');
  const plannedOf = (l: Rec) => Number(l.planned_qty) || sumBy(liveWos.filter((w) => w.so_line_id === l.id), 'planned_qty');
  const uncovered = (so.lines as Rec[]).some((l) => l.qty - plannedOf(l) > 1e-9);
  const canUnconfirm = ['CONFIRMED', 'IN_PRODUCTION'].includes(st) && !liveWos.length && !liveShip.length;

  const loadKit = useCallback(async () => {
    if (!active) return;
    setKitLoading(true);
    try {
      setKit(await get(`/kitting/sales-orders/${so.id}`, undefined, true));
    } catch {
      setKit(null);
    } finally {
      setKitLoading(false);
    }
  }, [so.id, active]);
  useEffect(() => {
    loadKit();
  }, [loadKit, so]);
  useEffect(() => {
    get(`/customers/${so.customer_id}`, undefined, true).then(setCustomer).catch(() => undefined);
  }, [so.customer_id]);

  const act = async (key: string, url: string, ok: string, body?: Rec) => {
    setBusy(key);
    try {
      await post(url, body);
      message.success(ok);
      await reload();
      setHistKey((k) => k + 1);
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
    {
      title: '已排产', key: 'planned', align: 'right',
      render: (_: any, l: Rec) => {
        const p = plannedOf(l);
        if (!active && !p) return '-';
        return p + 1e-9 >= l.qty ? <span style={{ color: '#389e0d' }}>{fmtQty(p)}</span> : <Tooltip title={`还有 ${fmtQty(l.qty - p)} 未排产`}><span style={{ color: '#d48806' }}>{fmtQty(p)}</span></Tooltip>;
      },
    },
    { title: '发货进度', key: 'ship', render: (_, l) => <QtyProgress done={l.shipped_qty || 0} total={l.qty} /> },
    { title: '备注', dataIndex: 'remark', render: (v) => v || '-' },
  ];

  const woCols: TableColumnsType<Rec> = [
    { title: '工单号', dataIndex: 'no', render: (v, w) => <Link to={`/mes/work-orders/${w.id}`} className="mono">{v}</Link> },
    { title: '产品', key: 'm', render: (_, w) => `${w.material_code} ${w.material_name}` },
    { title: '计划数量', dataIndex: 'planned_qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '完工数量', dataIndex: 'completed_qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '进度', dataIndex: 'progress', width: 160, render: (v) => <Progress percent={v || 0} size="small" style={{ margin: 0 }} /> },
    { title: '计划开工 ~ 完工', key: 'plan', render: (_, w) => `${fmtDate(w.planned_start)} ~ ${fmtDate(w.planned_end)}` },
    {
      title: '齐套', key: 'kit',
      render: (_, w) => {
        const k = kit?.work_orders?.find((x: Rec) => x.wo_id === w.id);
        if (!k) return '-';
        return k.kitted ? <Tag color="green">齐套</Tag> : <Tooltip title={k.eta ? `预计 ${fmtDate(k.eta)} 齐套` : '有物料无在途'}><Tag color="red">缺 {k.shortage_count} 项</Tag></Tooltip>;
      },
    },
    { title: '工单状态', dataIndex: 'status', render: (v) => <StatusTag dict="wo_status" value={v} /> },
    {
      title: '放行状态', dataIndex: 'dhr_status',
      render: (v, w) => (['COMPLETED', 'CLOSED'].includes(w.status) || w.received_qty > 0 ? <StatusTag dict="dhr_status" value={v} /> : <Typography.Text type="secondary">-</Typography.Text>),
    },
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
  const linked: string[] = woResult?.linked || [];
  const woPrimary = st === 'CONFIRMED' && uncovered;
  const ks = kittingSummary(kit);

  /** 不常用的操作收进“更多”：复制、撤销确认（反审核）、取消、关闭 */
  const moreItems = [
    ...(can('sales') ? [{ key: 'copy', icon: <CopyOutlined />, label: '复制订单' }] : []),
    ...(canUnconfirm && can('sales') ? [{ key: 'unconfirm', icon: <RollbackOutlined />, label: '撤销确认（退回草稿，即“反审核”）' }] : []),
    ...(st === 'CONFIRMED' && !liveWos.length && can('sales') ? [{ key: 'cancel', label: '取消订单', danger: true }] : []),
    ...(active && can('sales') ? [{ key: 'close', label: '关闭（短交结案）' }] : []),
  ];
  const onMore = (key: string) => {
    if (key === 'copy') nav(`/sales/orders/new?copy=${so.id}`);
    else if (key === 'unconfirm') setUnconfirmOpen(true);
    else if (key === 'cancel') {
      modal.confirm({
        title: `确定取消订单 ${so.no}？`, content: '取消后不可恢复。', okText: '确认取消订单', cancelText: '不取消', okButtonProps: { danger: true },
        onOk: () => act('cancel', `/sales-orders/${so.id}/cancel`, '订单已取消'),
      });
    } else if (key === 'close') {
      modal.confirm({
        title: `关闭订单 ${so.no}？`, content: '关闭后订单不再发货，未发数量按短交结案。', okText: '确认关闭', cancelText: '不关闭',
        onOk: () => act('close', `/sales-orders/${so.id}/close`, '订单已关闭'),
      });
    }
  };

  return (
    <>
      <PageHeader
        title={<Space>销售订单 {so.no}<StatusTag dict="so_status" value={st} /></Space>}
        sub={`${so.customer_name ?? ''}${so.customer_po ? ` · 客户PO ${so.customer_po}` : ''}`}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/sales/orders')}>返回列表</Button>
            <PrintButton text="打印形式发票" title={`PI-${so.no}`} />
            {moreItems.length > 0 && (
              <Dropdown menu={{ items: moreItems, onClick: ({ key }) => onMore(key) }}>
                <Button>
                  更多 <DownOutlined />
                </Button>
              </Dropdown>
            )}
            {active && can('sales') && (
              <Tooltip title="改数量、交期、单价、新增行（校验已发货/已排产，提示受影响工单）">
                <Button icon={<EditOutlined />} onClick={onChange}>变更</Button>
              </Tooltip>
            )}
            {active && can('plan') && (
              <Tooltip title={uncovered ? '先预览：按交期倒排开工，扣除已排产和库存覆盖的数量' : '所有订单行均已排产'}>
                <Button type={woPrimary ? 'primary' : 'default'} icon={<ThunderboltOutlined />} disabled={!uncovered} onClick={() => setPlanOpen(true)}>
                  生成工单
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
      <div className="no-print">
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
          {active && (
            <Card
              size="small"
              title={
                <Space>
                  齐套分析
                  {kit && kit.lines?.length > 0 && (kit.kitted ? <Tag color="green">齐套</Tag> : <Tag color={ks.type === 'error' ? 'red' : 'orange'}>缺 {kit.shortage_count} 项</Tag>)}
                </Space>
              }
              extra={<Button size="small" onClick={loadKit} loading={kitLoading}>刷新</Button>}
            >
              <KittingTable data={kit} loading={kitLoading} />
            </Card>
          )}
          <Card size="small" title={`生产工单（${liveWos.length}）`}>
            {wos.length ? (
              <Table rowKey="id" size="middle" columns={woCols} dataSource={wos} pagination={false} scroll={{ x: 'max-content' }} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={active ? '还没有生产工单，计划员点右上角【生成工单】' : '无生产工单'} />
            )}
          </Card>
          <Card size="small" title={`发货记录（${shipments.length}）`}>
            {shipments.length ? (
              <Table rowKey="id" size="middle" columns={shipCols} dataSource={shipments} pagination={false} scroll={{ x: 'max-content' }} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发货" />
            )}
          </Card>
          <Collapse
            size="small"
            items={[{ key: 'h', label: '变更记录（审计追踪）', children: <SoHistory soId={so.id} refreshKey={histKey} /> }]}
          />
        </Space>
      </div>
      <ProformaInvoice so={so} customer={customer} />

      <WoPlanModal so={so} open={planOpen} onClose={() => setPlanOpen(false)}
        onDone={async (r) => {
          await reload();
          setWoResult(r);
          loadKit();
        }} />

      <Modal
        open={unconfirmOpen}
        title={`撤销确认 ${so.no}`}
        okText="退回草稿"
        okButtonProps={{ disabled: !unReason.trim(), loading: busy === 'unconfirm' }}
        onCancel={() => setUnconfirmOpen(false)}
        onOk={async () => {
          await act('unconfirm', `/sales-orders/${so.id}/unconfirm`, '已退回草稿，可修改后重新确认', { reason: unReason });
          setUnconfirmOpen(false);
          setUnReason('');
        }}
        destroyOnHidden
      >
        <Typography.Paragraph>订单还没有生成工单、没有发货，退回草稿后可直接修改再确认。原因将记入审计追踪。</Typography.Paragraph>
        <Input.TextArea autoFocus rows={3} value={unReason} onChange={(e) => setUnReason(e.target.value)} placeholder="如：客户更换型号，需重新下单" />
      </Modal>

      <Modal
        open={!!woResult}
        title="生成工单结果"
        onCancel={() => setWoResult(null)}
        footer={[
          <Button key="list" onClick={() => nav('/mes/work-orders')}>前往生产工单</Button>,
          <Button key="ok" type="primary" onClick={() => setWoResult(null)}>知道了</Button>,
        ]}
      >
        {created.length > 0 && (
          <>
            <Typography.Paragraph>
              已生成 <b>{created.length}</b> 张生产工单（计划状态，已按交期倒排开工日期），确认无误后在工单页【下达】：
            </Typography.Paragraph>
            <Space wrap>
              {created.map((no) => {
                const w = wos.find((x) => x.no === no);
                return w ? <Link key={no} to={`/mes/work-orders/${w.id}`} className="mono">{no}</Link> : <span key={no} className="mono">{no}</span>;
              })}
            </Space>
          </>
        )}
        {linked.length > 0 && <Alert type="success" showIcon style={{ marginTop: 12 }} message={`已关联工单：${linked.join('、')}`} />}
        {!created.length && !skipped.length && !linked.length && <Alert type="info" showIcon message="所有订单行均已排产，无需重复生成" />}
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
  const [sp] = useSearchParams();
  const copyId = sp.get('copy');
  const isNew = id === 'new';
  const nav = useNavigate();
  const { can } = useAuth();
  const [so, setSo] = useState<Rec | null>(null);
  const [copyFrom, setCopyFrom] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);

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
    setChanging(false);
    load();
  }, [load]);

  useEffect(() => {
    if (!isNew || !copyId) {
      setCopyFrom(null);
      return;
    }
    get(`/sales-orders/${copyId}`).then(setCopyFrom).catch(() => setCopyFrom(null));
  }, [isNew, copyId]);

  if (isNew && !can('sales')) return <Result status="403" title="没有新建销售订单的权限" extra={<Button onClick={() => nav('/sales/orders')}>返回列表</Button>} />;
  if (failed && !so) return <Result status="404" title="销售订单不存在或无法加载" extra={<Button onClick={() => nav('/sales/orders')}>返回列表</Button>} />;
  if (!isNew && !so) return <Spin style={{ display: 'block', padding: 80 }} />;
  if (isNew && copyId && !copyFrom) return <Spin style={{ display: 'block', padding: 80 }} />;

  if (isNew || (so!.status === 'DRAFT' && can('sales'))) {
    return (
      <SoEditor
        key={so?.id ?? `new-${copyId ?? ''}`}
        so={so}
        mode={isNew ? 'new' : 'draft'}
        copyFrom={copyFrom}
        onSaved={(d) => (isNew ? nav(`/sales/orders/${d.id}`, { replace: true }) : load())}
      />
    );
  }
  if (changing && can('sales')) {
    return (
      <SoEditor
        key={`change-${so!.id}`}
        so={so}
        mode="change"
        onSaved={() => {
          setChanging(false);
          load();
        }}
        onExit={() => setChanging(false)}
      />
    );
  }
  return (
    <Spin spinning={loading}>
      <SoView so={so!} reload={load} onChange={() => setChanging(true)} />
    </Spin>
  );
}
