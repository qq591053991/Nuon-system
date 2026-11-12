import {
  Alert, App, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Input, InputNumber, Modal, Popconfirm, Result, Row, Select, Space, Spin,
  Steps, Table, Tag, Typography, message, type TableColumnsType,
} from 'antd';
import {
  ArrowLeftOutlined, AuditOutlined, CheckOutlined, EditOutlined, HistoryOutlined, ImportOutlined, MobileOutlined, RollbackOutlined, SaveOutlined, SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { isCancel, useESign } from '../../components/ESign';
import { PrintButton, PrintHeader, PrintSignatures } from '../../components/Print';
import { useCompany } from '../../utils/company';
import { LocationSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty, toDate } from '../../utils/format';
import {
  CURRENCY_OPTIONS, DueDate, OrderLinesEditor, QtyProgress, checkLines, isPast, linesBody, sumBy, toDayjs, uid, type LineRow,
} from './shared';
import { QualifiedSupplierSelect } from './purchaseKit';

const RECEIVABLE = ['APPROVED', 'PARTIAL_RECEIVED'];
const STEP_OF: Record<string, number> = { DRAFT: 0, SUBMITTED: 1, APPROVED: 1, PARTIAL_RECEIVED: 2, RECEIVED: 3, CLOSED: 3 };
const NEXT_HINT: Record<string, string> = {
  DRAFT: '确认无误后点击【保存并审批】（大额采购单为【保存并提交厂长审批】）。GMP 采购控制：只有“合格供方”且资质在有效期内的供应商才能审批通过；客供料不能采购。',
  SUBMITTED: '大额采购单已提交厂长审批：厂长在工作台“待我拍板”或本页【批准】/【退回】（电子签名）。审批前不能修改；如需修改请厂长退回。',
  APPROVED: '订单已审批：点【打印 / 导出 PDF】发给供应商。供应商回复交期或调价时点【变更】登记（需填原因，留痕）。到货后点击【收货】。',
  PARTIAL_RECEIVED: '部分到货。剩余数量到货后继续【收货】；交期/单价有变点【变更】；供应商不再供货时可【关闭】订单。',
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

/** 按采购单位（卷/包/箱）录入的行只允许整包：小数向上取整，并同步库存单位数量 */
function wholePacks(rows: LineRow[]): LineRow[] {
  return rows.map((r) => {
    if (!r.purchase_uom || r.purchase_qty === null || r.purchase_qty === undefined) return r;
    const q = Number(r.purchase_qty);
    if (!(q > 0) || Math.abs(q - Math.round(q)) < 1e-6) return r;
    const whole = Math.ceil(q - 1e-9);
    const f = Number(r.purchase_factor) || (r.qty && q ? Number(r.qty) / q : 0);
    message.info(`${r.material_code ?? ''} 按${r.purchase_uom}整包下单：${fmtQty(q)} ${r.purchase_uom} → ${whole} ${r.purchase_uom}`, 3);
    return { ...r, purchase_qty: whole, qty: f ? Math.round(whole * f * 10000) / 10000 : r.qty };
  });
}

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
          { title: '审批', description: po?.approved_by ? `${po.approved_by} 已审批` : st === 'SUBMITTED' ? '待厂长审批' : '合格供方校验' },
          { title: '收货', description: got > 0 ? `已收 ${fmtQty(got)}/${fmtQty(qty)}` : '到货待检' },
          { title: '完成', description: st === 'CLOSED' ? '已关闭' : st === 'RECEIVED' ? '全部到货' : undefined },
        ]}
      />
      {po?.rejection && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message={<span>被厂长退回：<b>{po.rejection.reason || '（未填写原因）'}</b></span>}
          description={`${po.rejection.by} 于 ${fmtDateTime(po.rejection.at)} 退回（电子签名）。请按原因修改后重新【提交审批】。`}
        />
      )}
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
          ? `该供应商资质已于 ${fmtDate(sup.qualification_expiry)} 过期：订单可保存草稿，但无法审批。请联系质量部完成供应商再评价（更新资质有效期），或改选合格供应商。`
          : `该供应商当前为“${dictLabel('supplier_status', sup.status)}”，不在合格供方名录内：订单可保存草稿，但无法审批。请联系质量部完成供应商评审，或改选合格供应商。`
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
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  // 大额采购单（本位币 ≥ 审批标准）：采购员只能“提交厂长审批”；厂长可直接审批（电子签名）
  const total = useMemo(() => lines.reduce((a, r) => a + (r.purchase_uom ? (Number(r.purchase_qty) || 0) * (Number(r.purchase_price) || 0) : (Number(r.qty) || 0) * (Number(r.unit_price) || 0)), 0), [lines]);
  const [rule, setRule] = useState<Rec | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      get('/purchase-orders/approval-rule', { amount: total, currency }, true).then(setRule).catch(() => setRule(null));
    }, 300);
    return () => clearTimeout(t);
  }, [total, currency]);
  const big = !!rule?.big;
  const bigBoss = big && can('po_big_approve');

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
        const r: Rec = saved!;
        if (r.approval?.big ?? big) {
          if (can('po_big_approve')) {
            let ok = true;
            await sign({ meaning: '大额采购单审批', submit: (signature) => post(`/purchase-orders/${r.id}/approve`, { signature }) }).catch((e) => {
              ok = false;
              if (!isCancel(e)) throw e;
            });
            message.success(ok ? '大额采购单已审批，可发送给供应商' : '草稿已保存（未审批）');
          } else {
            await post(`/purchase-orders/${r.id}/submit`);
            message.success(`金额达到大额审批标准（${Number(rule?.threshold ?? 0).toLocaleString()}），已提交厂长审批`, 5);
          }
        } else {
          await post(`/purchase-orders/${r.id}/approve`, {});
          message.success('采购订单已审批，可发送给供应商');
        }
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
            <Button type="primary" icon={big && !bigBoss ? <SendOutlined /> : <AuditOutlined />} loading={busy === 'approve'} disabled={!!busy && busy !== 'approve'} onClick={() => save(true)}>
              {big && !bigBoss ? '保存并提交厂长审批' : '保存并审批'}
            </Button>
          </>
        }
      />
      {signHolder}
      {big && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            rule?.missing_rate
              ? `缺少 ${currency} 今日汇率，无法折算本位币，按大额采购单处理：须厂长审批`
              : `本单金额折合 ${rule?.base_currency} ${Number(rule?.base_amount ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}，达到大额审批标准 ${Number(rule?.threshold ?? 0).toLocaleString()}：${bigBoss ? '审批时需电子签名' : '保存后提交厂长审批，批准后才能发给供应商'}`
          }
        />
      )}
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
                  <QualifiedSupplierSelect autoFocus={!po} onPick={(s) => s && form.setFieldsValue({ currency: s.currency || 'CNY' })} />
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
          extra={
            <Typography.Text type="secondary">
              设置了采购单位的物料（如 LED 按卷）默认按整卷/整包下单，系统自动换算为库存单位；
              <Link to="/purchase/materials">设置采购单位</Link>
            </Typography.Text>
          }
        >
          <OrderLinesEditor
            value={lines}
            onChange={(rows) => setLines(wholePacks(rows))}
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
/**
 * 电脑端采购收货：每行默认带出建议库位（默认库位 → 防潮柜 → 上次收货库位…）；提交前逐行做库位校验，
 * 湿敏物料放非防潮库位等“需确认”的放置弹窗确认后带 confirm_placement 提交；收货后可直接打印批次标签。
 */
function ReceiveModal({ po, open, onClose, onDone }: { po: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const { modal } = App.useApp();
  const nav = useNavigate();
  const [rows, setRows] = useState<Rec[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const base = (po.lines as Rec[])
      .filter((l) => remainOf(l) > 0)
      .map((l) => ({ _key: String(l.id), po_line_id: l.id, line: l, qty: remainOf(l) }));
    setRows(base);
    // 建议库位（与 PDA 收货同一规则）
    get('/wms/receive-context', { po: po.no }, true)
      .then((ctx: Rec) => {
        const sug = new Map<number, Rec>(((ctx?.lines || []) as Rec[]).map((x) => [x.po_line_id, x]));
        setRows((old) =>
          old.map((r) => {
            const s = sug.get(r.po_line_id)?.suggest_location;
            return r.location_id || !s ? r : { ...r, location_id: s.id, suggested: s };
          }),
        );
      })
      .catch(() => undefined);
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

  const send = async (head: Rec, use: Rec[], confirm: boolean) => {
    setSaving(true);
    try {
      const rc = await post(`/purchase-orders/${po.id}/receive`, {
        delivery_note: head.delivery_note || null,
        remark: head.remark || null,
        confirm_placement: confirm,
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
      onDone();
      modal.confirm({
        title: `已收货 ${rc.no}`,
        content: quarantine ? '物料处于“待检”状态，已自动生成 IQC 检验单。现在打印批次标签贴到料盘/外箱上？' : '免检物料已直接入库为合格。现在打印批次标签？',
        okText: '打印批次标签',
        cancelText: '稍后',
        onOk: () => {
          window.open(`/wms/print/labels?receipt=${rc.id}`, '_blank');
        },
      });
    } finally {
      setSaving(false);
    }
  };

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
    // 提交前逐行校验库位：错误直接拦下；湿敏放非防潮柜等警告需确认
    setSaving(true);
    let checks: { r: Rec; c: Rec }[] = [];
    try {
      checks = await Promise.all(use.map(async (r) => ({ r, c: await post('/wms/placement-check', { material_id: r.line.material_id, location_id: r.location_id }, true).catch(() => ({ errors: [], warnings: [] })) })));
    } finally {
      setSaving(false);
    }
    const errors = checks.flatMap(({ r, c }) => (c.errors || []).map((e: string) => `${r.line.material_code}：${e}`));
    if (errors.length) {
      modal.error({ title: '收货库位不符合放置规则', content: <ul style={{ paddingLeft: 18, margin: 0 }}>{errors.map((t) => <li key={t}>{t}</li>)}</ul>, okText: '返回修改' });
      return;
    }
    const warns = checks.flatMap(({ r, c }) => (c.warnings || []).map((w: string) => `${r.line.material_code}：${w}`));
    if (warns.length) {
      modal.confirm({
        title: '请确认库位',
        content: <ul style={{ paddingLeft: 18, margin: 0 }}>{warns.map((t) => <li key={t}>{t}</li>)}</ul>,
        okText: '确认放入（已知风险）',
        cancelText: '返回修改库位',
        autoFocusButton: 'cancel',
        onOk: () => send(head, use, true),
      });
      return;
    }
    await send(head, use, false);
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
      title: '收货库位', key: 'loc', width: 250,
      render: (_, r) => (
        <div>
          <LocationSelect style={{ width: 240 }} value={r.location_id} onChange={(v) => patch(r._key, { location_id: v })} status={Number(r.qty) > 0 && !r.location_id ? 'error' : undefined} />
          {r.suggested && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              建议 {r.suggested.code}{r.suggested.reason ? `（${r.suggested.reason}）` : ''}
            </Typography.Text>
          )}
        </div>
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
        message="库位已按物料默认库位/防潮柜等规则带出（与 PDA 收货一致），提交前会校验：湿敏物料放非防潮库位需要确认，自有料不能进客供料仓。收货按库存单位登记，需检验的物料收货后为“待检”。"
        action={
          <Button size="small" icon={<MobileOutlined />} onClick={() => nav(`/wms/pda/receive?po=${encodeURIComponent(po.no)}`)}>
            PDA 扫码收货
          </Button>
        }
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

// ---------------- 审批后变更（交期 / 回复交期 / 单价 / 数量） ----------------
const REASONS = ['供应商回复交期', '供应商推迟交货', '价格调整', '数量调整', '需求变更'];

function ChangeModal({ po, open, onClose, onDone }: { po: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [head, setHead] = useState<string | null>(po.expected_date ?? null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setHead(po.expected_date ?? null);
    setReason('');
    setRows(
      (po.lines as Rec[]).map((l) => {
        const f = factorOf(l);
        return {
          ...l, _f: f, n_qty: f ? l.purchase_qty : l.qty, n_price: f ? l.purchase_price : l.unit_price,
          n_expected: l.expected_date ?? null, n_promised: l.promised_date ?? null,
        };
      }),
    );
  }, [open, po]);
  const patch = (id: number, p: Rec) => setRows((old) => old.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const body = () => {
    const lines = rows
      .map((r) => {
        const x: Rec = { id: r.id };
        if ((r.n_expected ?? null) !== (r.expected_date ?? null)) x.expected_date = r.n_expected;
        if ((r.n_promised ?? null) !== (r.promised_date ?? null)) x.promised_date = r.n_promised;
        const q0 = r._f ? r.purchase_qty : r.qty;
        const p0 = r._f ? r.purchase_price : r.unit_price;
        if (Number(r.n_qty) !== Number(q0)) x[r._f ? 'purchase_qty' : 'qty'] = r.n_qty;
        if (Number(r.n_price) !== Number(p0)) x[r._f ? 'purchase_price' : 'unit_price'] = r.n_price;
        return x;
      })
      .filter((x) => Object.keys(x).length > 1);
    return { reason: reason.trim(), lines, ...((head ?? null) !== (po.expected_date ?? null) ? { expected_date: head } : {}) };
  };
  const submit = async () => {
    const b = body();
    if (!b.lines.length && b.expected_date === undefined) {
      message.warning('没有修改任何内容');
      return;
    }
    if (b.reason.length < 2) {
      message.error('请填写变更原因（可点下方常用原因）');
      return;
    }
    setSaving(true);
    try {
      const d = await post(`/purchase-orders/${po.id}/change`, b);
      Modal.success({
        title: d.change.reapproval ? '采购订单已变更，已提交厂长重新审批' : '采购订单已变更',
        content: (
          <div>
            <div>原因：{d.change.reason}</div>
            <ul style={{ paddingLeft: 18, margin: '8px 0 0' }}>{(d.change.items as string[]).map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        ),
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };
  const date = (v: string | null, on: (v: string | null) => void, placeholder?: string) => (
    <DatePicker style={{ width: 140 }} placeholder={placeholder} value={v ? dayjs(v) : null} onChange={(d) => on(d ? d.format('YYYY-MM-DD') : null)} />
  );
  const cols: TableColumnsType<Rec> = [
    { title: '行', dataIndex: 'line_no', width: 50 },
    { title: '物料', key: 'm', width: 220, render: (_, r) => <div><span className="mono">{r.material_code}</span><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.material_name}</div></div> },
    { title: '已收 / 订购', key: 'recv', render: (_, r) => `${fmtQty(r.received_qty || 0)} / ${fmtQty(r.qty)} ${r.uom}` },
    {
      title: '数量', key: 'q', width: 150,
      render: (_, r) => (
        <div>
          <InputNumber
            min={r._f ? Math.ceil(((r.received_qty || 0) / r._f) - 1e-9) || 1 : r.received_qty || 0.0001}
            precision={r._f ? 0 : undefined}
            style={{ width: 120 }}
            value={r.n_qty}
            onChange={(v) => patch(r.id, { n_qty: v })}
            addonAfter={undefined}
          />
          <div style={{ fontSize: 12, color: '#8c8c8c' }}>{r._f ? `${r.purchase_uom}（= ${fmtQty((Number(r.n_qty) || 0) * r._f)} ${r.uom}）` : r.uom}</div>
        </div>
      ),
    },
    {
      title: '单价', key: 'p', width: 150,
      render: (_, r) => (
        <div>
          <InputNumber min={0} style={{ width: 130 }} value={r.n_price} onChange={(v) => patch(r.id, { n_price: v })} />
          <div style={{ fontSize: 12, color: '#8c8c8c' }}>每{r._f ? r.purchase_uom : r.uom}{r.received_qty > 0 && Number(r.n_price) !== Number(r._f ? r.purchase_price : r.unit_price) ? '，已收部分应付不变' : ''}</div>
        </div>
      ),
    },
    { title: '预计到货', key: 'e', width: 150, render: (_, r) => date(r.n_expected, (v) => patch(r.id, { n_expected: v })) },
    { title: '供应商回复交期', key: 'pr', width: 150, render: (_, r) => date(r.n_promised, (v) => patch(r.id, { n_promised: v }), '未回复') },
  ];
  return (
    <Modal
      open={open}
      title={`变更采购订单 - ${po.no}`}
      width={1180}
      okText="确认变更"
      onOk={submit}
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="已审批订单可改交期、供应商回复交期、单价、数量（不少于已收数量），无需重新审批；系统记录变更人、时间、原因及前后值（详情页“变更记录”可查）。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <span>表头预计到货：</span>
        {date(head, setHead)}
      </Space>
      <Table rowKey="id" size="small" columns={cols} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} />
      <div style={{ marginTop: 12 }}>
        <Input.TextArea rows={2} placeholder="变更原因（必填），如：供应商回复因模具维修推迟到 11/25" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} showCount />
        <Space wrap style={{ marginTop: 6 }}>
          <Typography.Text type="secondary">常用原因：</Typography.Text>
          {REASONS.map((r) => <Tag key={r} style={{ cursor: 'pointer' }} onClick={() => setReason(r)}>{r}</Tag>)}
        </Space>
      </div>
    </Modal>
  );
}

function ChangeHistory({ poId, version }: { poId: number; version: number }) {
  const [items, setItems] = useState<Rec[] | null>(null);
  useEffect(() => {
    get(`/purchase-orders/${poId}/changes`, undefined, true).then(setItems).catch(() => setItems([]));
  }, [poId, version]);
  if (!items || !items.length) return null;
  return (
    <Card size="small" title={<Space><HistoryOutlined />变更记录（{items.length} 次）</Space>} className="no-print">
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={items}
        columns={[
          { title: '时间', dataIndex: 'ts', width: 150, render: fmtDateTime },
          { title: '变更人', dataIndex: 'full_name', width: 100, render: (v, r) => v || r.username },
          { title: '原因', dataIndex: 'reason', width: 220 },
          { title: '变更内容', dataIndex: 'items', render: (v: string[]) => <div>{v.map((t) => <div key={t}>{t}</div>)}</div> },
        ]}
      />
    </Card>
  );
}

// ---------------- 采购订单打印（发给供应商：我方抬头、交货地址、按采购单位、无内部字段） ----------------
function PurchaseOrderPrint({ po, supplier }: { po: Rec; supplier: Rec | null }) {
  const company = useCompany();
  const cell = { border: '1px solid #000', padding: '3px 6px', fontSize: 11 } as const;
  const num = { ...cell, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  return (
    <div className="print-only">
      <PrintHeader
        title={`${company?.name ? `${company.name} ` : ''}采购订单 PURCHASE ORDER`}
        no={po.no}
        extra={<div>下单日期：{fmtDate(po.order_date)}　币别：{po.currency}</div>}
      />
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
        <tbody>
          <tr>
            <td style={{ ...cell, width: '50%', verticalAlign: 'top' }}>
              <b>供应商</b>：{po.supplier_name}<br />
              联系人：{[supplier?.contact, supplier?.phone, supplier?.email].filter(Boolean).join(' / ') || '-'}<br />
              地址：{supplier?.address || '-'}
            </td>
            <td style={{ ...cell, verticalAlign: 'top' }}>
              <b>采购方</b>：{company?.name || '-'}{company?.phone ? `　电话：${company.phone}` : ''}<br />
              交货地址：{company?.address || '-'}<br />
              付款条件：{supplier?.payment_terms_days != null ? `月结 ${supplier.payment_terms_days} 天` : '-'}{company?.tax_no ? `　税号：${company.tax_no}` : ''}
            </td>
          </tr>
        </tbody>
      </table>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['行', '物料编码', '品名 / 规格', '数量', '单位', '单价', '金额', '交期', '备注'].map((h) => (
              <th key={h} style={{ ...cell, background: '#f0f0f0', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(po.lines as Rec[]).map((l) => {
            const pu = !!l.purchase_uom;
            return (
              <tr key={l.id}>
                <td style={cell}>{l.line_no}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{l.material_code}</td>
                <td style={cell}>{l.material_name}{l.material_spec ? ` / ${l.material_spec}` : ''}</td>
                <td style={num}>{fmtQty(pu ? l.purchase_qty : l.qty)}{pu && <div style={{ fontSize: 9 }}>（{fmtQty(l.qty)} {l.uom}）</div>}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{pu ? l.purchase_uom : l.uom}</td>
                <td style={num}>{fmtPrice(pu ? l.purchase_price : l.unit_price, po.currency)}</td>
                <td style={num}>{fmtMoney(l.amount, po.currency)}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{fmtDate(l.promised_date || l.expected_date || po.expected_date)}</td>
                <td style={cell}>{l.remark || ''}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...cell, textAlign: 'right' }} colSpan={6}><b>合计（含税）</b></td>
            <td style={num}><b>{fmtMoney(po.total_amount, po.currency)}</b></td>
            <td style={cell} colSpan={2} />
          </tr>
        </tbody>
      </table>
      {po.remark && <p style={{ fontSize: 11, margin: '6px 0 0' }}>备注：{po.remark}</p>}
      <div style={{ fontSize: 11, marginTop: 8, lineHeight: 1.8 }}>
        <div>交货要求：1. 送货单请注明本采购单号、物料编码与批号，随货附出厂检验报告/COA；2. 湿敏/静电敏感物料请真空防潮、防静电包装；3. 交期如有变化请提前书面告知采购。</div>
        <div>来料须经本公司 IQC 检验合格后入库；不合格品按质量协议退换。</div>
      </div>
      <style>{'@media print { .po-sign > .print-only { display: flex !important; } }'}</style>
      <div className="po-sign"><PrintSignatures roles={['采购', '审核', '供应商确认（签字盖章）']} /></div>
    </div>
  );
}

// ---------------- 查看（审批后） ----------------
function PoView({ po, reload }: { po: Rec; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  /** 厂长批准 / 退回大额采购单（电子签名；退回需填原因） */
  const decide = async (approve: boolean) => {
    try {
      if (approve) {
        await sign({ meaning: '大额采购单审批', submit: (signature) => post(`/purchase-orders/${po.id}/approve`, { signature }) });
        message.success(`${po.no} 已批准，采购可发给供应商`);
      } else {
        await sign({
          meaning: '大额采购单退回', reasonRequired: true, reasonLabel: '退回原因', reasonPlaceholder: '如：单价偏高，请再议价',
          submit: (signature) => post(`/purchase-orders/${po.id}/reject`, { reason: signature.reason, signature }),
        });
        message.success(`${po.no} 已退回采购修改`);
      }
      await reload();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };
  const [busy, setBusy] = useState<string>();
  const [receiving, setReceiving] = useState(false);
  const [changing, setChanging] = useState(false);
  const [version, setVersion] = useState(0);
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

  const [supplier, setSupplier] = useState<Rec | null>(null);
  useEffect(() => {
    get(`/suppliers/${po.supplier_id}`, undefined, true).then(setSupplier).catch(() => undefined);
  }, [po.supplier_id]);

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
        return <DueDate value={d} overdue={receivable && !l.promised_date && isPast(d) && remainOf(l) > 0} hint="已过预计到货日期，尚未到齐" />;
      },
    },
    {
      title: '供应商回复交期', dataIndex: 'promised_date',
      render: (v, l) => (v ? <DueDate value={v} overdue={receivable && isPast(v) && remainOf(l) > 0} hint="已过供应商回复交期，尚未到齐" /> : '-'),
    },
    {
      title: '未交', key: 'open', align: 'right',
      render: (_, l) => (['CLOSED', 'CANCELLED'].includes(st) ? '-' : remainOf(l) > 0 ? <b>{fmtQty(remainOf(l))}</b> : <Tag color="green">已到齐</Tag>),
    },
    { title: '到货进度', key: 'recv', className: 'no-print', render: (_, l) => <QtyProgress done={l.received_qty || 0} total={l.qty} /> },
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
      <div className="no-print">
      <PageHeader
        title={<Space>采购订单 {po.no}<StatusTag dict="po_status" value={st} /></Space>}
        sub={`${po.supplier_name ?? ''}${po.source ? ` · 来源 ${po.source}` : ''}`}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/purchase/orders')}>返回列表</Button>
            {st !== 'SUBMITTED' && <PrintButton landscape title={`采购订单 ${po.no}`} />}
            {st === 'SUBMITTED' && can('po_big_approve') && (
              <>
                <Button icon={<RollbackOutlined />} onClick={() => decide(false)}>退回</Button>
                <Button type="primary" icon={<CheckOutlined />} onClick={() => decide(true)}>批准</Button>
              </>
            )}
            {st === 'SUBMITTED' && !can('po_big_approve') && <Tag color="orange" style={{ alignSelf: 'center' }}>已提交厂长审批，等待批准</Tag>}
            {st === 'SUBMITTED' && can('purchase') && (
              <Popconfirm title="撤回并取消该采购订单？" okText="取消订单" cancelText="不取消" onConfirm={() => act('cancel', `/purchase-orders/${po.id}/cancel`, '订单已取消')}>
                <Button danger loading={busy === 'cancel'}>取消订单</Button>
              </Popconfirm>
            )}
            {receivable && can('purchase') && <Button icon={<EditOutlined />} onClick={() => setChanging(true)}>变更</Button>}
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
      </div>
      {signHolder}
      {st === 'SUBMITTED' && po.approval && (
        <Alert
          className="no-print"
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`大额采购单：金额折合 ${po.approval.base_currency} ${Number(po.approval.base_amount ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}（≥ ${Number(po.approval.threshold).toLocaleString()}），须厂长电子签名批准`}
        />
      )}
      <PurchaseOrderPrint po={po} supplier={supplier} />
      <div className="no-print">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small" className="no-print"><PoSteps po={po} /></Card>
        <Card size="small" title="订单信息">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: 'supplier', label: '供应商', children: po.supplier_name },
              ...(supplier ? [{ key: 'contact', label: '联系人', children: [supplier.contact, supplier.phone, supplier.email].filter(Boolean).join(' / ') || '-' }] : []),
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
          <Table
            rowKey="id"
            size="middle"
            columns={lineCols}
            dataSource={po.lines}
            pagination={false}
            scroll={{ x: 'max-content' }}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={7} align="right"><b>合计</b></Table.Summary.Cell>
                <Table.Summary.Cell index={7} align="right"><b>{fmtMoney(po.total_amount, po.currency)}</b></Table.Summary.Cell>
                <Table.Summary.Cell index={8} colSpan={5} />
              </Table.Summary.Row>
            )}
          />
        </Card>
        <ChangeHistory poId={po.id} version={version} />
        <Card size="small" className="no-print" title={`收货记录（${(po.receipts || []).length} 次）`}>
          {receiptRows.length ? (
            <Table rowKey="id" size="middle" columns={receiptCols} dataSource={receiptRows} pagination={false} scroll={{ x: 'max-content' }} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={receivable ? '尚未收货，到货后点击右上角【收货】' : '无收货记录'} />
          )}
        </Card>
      </Space>
      </div>
      {receivable && (
        <ChangeModal
          po={po}
          open={changing}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            setVersion((v) => v + 1);
            reload();
          }}
        />
      )}
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
