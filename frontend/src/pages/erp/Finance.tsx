import {
  Alert, AutoComplete, Button, Card, Checkbox, Col, DatePicker, Descriptions, Divider, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space,
  Statistic, Table, Tabs, Tag, Tooltip, Typography, message, type TableColumnsType, Popover,
} from 'antd';
import { DollarOutlined, ExclamationCircleOutlined, MergeCellsOutlined, ReloadOutlined, RollbackOutlined, StopOutlined, SwapOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton, { type ExportColumn } from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { CustomerSelect, SupplierSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtMoney, toDate } from '../../utils/format';
import { DueDate, isPast } from './shared';

type Kind = 'AR' | 'AP';
const TEXT = {
  AR: {
    name: '应收', partner: '客户', paid: '已收', pay: '登记收款', payDone: '收款已登记', amountLabel: '核销金额', dateLabel: '收款日期', rateLabel: '实收汇率',
    settle: '合并收款', adv: '预收款', advType: 'PR', bank: '银行到账', feeHint: '银行从货款中扣除的手续费（核销金额 = 到账 + 手续费）',
  },
  AP: {
    name: '应付', partner: '供应商', paid: '已付', pay: '登记付款', payDone: '付款已登记', amountLabel: '付款金额', dateLabel: '付款日期', rateLabel: '实付汇率',
    settle: '合并付款', adv: '预付款', advType: 'PP', bank: '银行付出', feeHint: '我方另付的银行手续费（不冲减应付）',
  },
};
const METHODS = ['银行转账', '电汇(T/T)', '承兑汇票', '信用证(L/C)', '支票', '现金', '其他'].map((v) => ({ value: v }));
const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'].map((v) => ({ value: v, label: v }));
const VOID_REASONS = ['登错客户/供应商', '金额录错', '重复登记', '银行退汇', '核销错单据'];
const BUCKET_PRESETS = [
  { value: '30,90', label: '未到期 / 1-30 / 31-90 / 90 天以上' },
  { value: '30,60,90', label: '30 / 60 / 90 天' },
  { value: '30,60,90,180', label: '30 / 60 / 90 / 180 天（金蝶常用）' },
  { value: '30,60,90,180,365', label: '30 / 60 / 90 / 180 / 365 天' },
];

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
/** 金额文本（始终返回字符串：也用在提示文案的模板字符串里，不能返回元素，否则显示“[object Object]”） */
const amt = (v?: number | null) => (v ? Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-');
/** 金额 + 币别（常用币别带符号，其余显示代码） */
const cur = (v: number | null | undefined, c: string) =>
  ['CNY', 'USD', 'EUR'].includes(c) ? fmtMoney(v, c) : `${c} ${Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rateText = (v?: number | null) => (v === null || v === undefined ? '-' : Number(v).toFixed(4).replace(/0{1,2}$/, ''));
const BLANK: Rec = {};

/** 来源单据链接（发货单 / 入库单 / 收付款单） */
function RefLink({ doc }: { doc: Rec }) {
  if (!doc.ref_no) return <span>-</span>;
  const base = doc.ref_type === 'SHIPMENT' ? '/wms/shipments' : doc.ref_type === 'RECEIPT' ? '/wms/receipts' : null;
  if (doc.ref_type === 'PAYMENT') return <Link to={`/finance?tab=PAY&q=${encodeURIComponent(doc.ref_no)}`} className="mono">{doc.ref_no}</Link>;
  return base ? <Link to={`${base}?q=${encodeURIComponent(doc.ref_no)}`} className="mono">{doc.ref_no}</Link> : <span className="mono">{doc.ref_no}</span>;
}

const IQC_COLOR: Record<string, string> = { PASSED: 'green', EXEMPT: 'default', CONCESSION: 'orange', PENDING: 'gold', REJECTED: 'red' };
function IqcTag({ iqc }: { iqc?: Rec | null }) {
  if (!iqc) return <span>-</span>;
  return (
    <Tooltip
      title={(iqc.lines as Rec[]).map((l) => (
        <div key={`${l.material_code}${l.lot_no}`}>{l.material_code} 批 {l.lot_no || '-'}：{({ PASSED: '合格', EXEMPT: '免检', CONCESSION: '让步接收', PENDING: '待检', REJECTED: '不合格' } as Rec)[l.status] ?? l.status}</div>
      ))}
    >
      <Tag color={IQC_COLOR[iqc.status]}>{iqc.text}</Tag>
    </Tooltip>
  );
}

/** 汇率默认值：今日适用汇率 */
const useRates = () => {
  const [info, setInfo] = useState<Rec>({ base_currency: 'CNY', rates: [] });
  useEffect(() => {
    get('/finance/currencies', undefined, true).then(setInfo).catch(() => undefined);
  }, []);
  const map = useMemo(() => Object.fromEntries(((info.rates || []) as Rec[]).map((r) => [r.currency, Number(r.rate)])), [info]);
  return { base: (info.base_currency as string) || 'CNY', rateOf: (c: string) => (c === (info.base_currency || 'CNY') ? 1 : map[c]) };
};

/** 收付款本位币试算（与后端 settleBase 一致） */
function settlePreview(kind: Kind, amount: number, fee: number, rate: number, bookRate: number) {
  const gross = r2(amount * rate);
  const booked = r2(amount * bookRate);
  const feeBase = r2(fee * rate);
  return kind === 'AR'
    ? { bankFc: r2(amount - fee), bank: r2(gross - feeBase), feeBase, booked, fx: r2(gross - booked) }
    : { bankFc: r2(amount + fee), bank: r2(gross + feeBase), feeBase, booked, fx: r2(booked - gross) };
}

function FxText({ v, base }: { v: number; base: string }) {
  if (!v) return <span>0.00</span>;
  return <span style={{ color: v > 0 ? '#389e0d' : '#cf1322', fontWeight: 600 }}>{v > 0 ? '汇兑收益' : '汇兑损失'} {base} {amt(Math.abs(v))}</span>;
}

// ======================= 登记收/付款（单张） =======================
/** 收付款银行账户：记住本机最近用过的账户（下拉可选），也可直接输入 */
const ACC_KEY = (k: Kind) => `nuon_fin_accounts_${k}`;
function recentAccounts(kind: Kind): string[] {
  try {
    return JSON.parse(localStorage.getItem(ACC_KEY(kind)) || '[]');
  } catch {
    return [];
  }
}
function rememberAccount(kind: Kind, acc?: string | null) {
  const a = (acc || '').trim();
  if (!a) return;
  try {
    localStorage.setItem(ACC_KEY(kind), JSON.stringify([a, ...recentAccounts(kind).filter((x) => x !== a)].slice(0, 8)));
  } catch {
    /* 本机存储不可用时忽略 */
  }
}
function BankAccountInput({ kind, ...p }: { kind: Kind; value?: string; onChange?: (v: string) => void }) {
  const opts = useMemo(() => recentAccounts(kind).map((v) => ({ value: v })), [kind]);
  return <AutoComplete {...p} options={opts} placeholder="如 中国银行 6217 …1234" allowClear />;
}

function PaymentModal({ doc, advances, base, rateOf, onClose, onDone }: { doc: Rec | null; advances: Rec[]; base: string; rateOf: (c: string) => number | undefined; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const kind: Kind = doc?.doc_type === 'AP' ? 'AP' : 'AR';
  const t = TEXT[kind];
  const amount = Number(Form.useWatch('amount', form) || 0);
  const fee = Number(Form.useWatch('fee_amount', form) || 0);
  const rate = Number(Form.useWatch('exchange_rate', form) || 0);
  const asAdvance = !!Form.useWatch('as_advance', form);
  const foreign = !!doc && doc.currency !== base;
  const bookRate = Number(doc?.exchange_rate ?? rate ?? 1) || rate || 1;
  const balance = Number(doc?.balance || 0);
  const over = r2(amount - balance);
  const applied = Math.min(amount, balance);
  const pv = settlePreview(kind, applied, fee, foreign ? rate || bookRate : 1, foreign ? bookRate : 1);
  const myAdv = advances.filter((a) => a.partner_id === doc?.partner_id && a.currency === doc?.currency && a.balance > 0);
  const iqcBad = kind === 'AP' && doc?.iqc && ['PENDING', 'REJECTED'].includes(doc.iqc.status);

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    if (over > 0 && !v.as_advance) {
      message.error(`金额超过未结余额 ${amt(balance)}（超出 ${amt(over)}）。如${t.partner}多付，请勾选“超出部分转${t.adv}”`);
      return;
    }
    const go = async () => {
      setSaving(true);
      try {
        await post(`/finance/docs/${doc!.id}/payments`, {
          ...v, pay_date: toDate(v.pay_date), exchange_rate: foreign ? v.exchange_rate : undefined, fee_amount: v.fee_amount || 0, as_advance: over > 0 && !!v.as_advance,
        });
        rememberAccount(kind, v.bank_account);
        message.success(over > 0 ? `${t.payDone}，超出部分 ${amt(over)} 已转${t.adv}` : t.payDone);
        onDone();
      } finally {
        setSaving(false);
      }
    };
    if (iqcBad) {
      Modal.confirm({
        title: `来料${doc!.iqc.status === 'REJECTED' ? '检验不合格' : '尚未检验'}，确定付款？`,
        icon: <ExclamationCircleOutlined />,
        content: `入库单 ${doc!.ref_no} 的物料：${doc!.iqc.text}。通常应在 IQC 合格后再付款；不合格品应按质量协议退换/扣款。`,
        okText: '仍要付款',
        okButtonProps: { danger: true },
        cancelText: '暂不付款',
        onOk: go,
      });
    } else await go();
  };

  const offset = async (a: Rec) => {
    setSaving(true);
    try {
      await post(`/finance/docs/${doc!.id}/apply-advance`, { advance_id: a.id });
      message.success(`已用${t.adv} ${a.no} 冲抵 ${amt(Math.min(a.balance, balance))}`);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!doc}
      title={`${t.pay} - ${doc?.no ?? ''}`}
      okText="确认登记"
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      width={680}
      style={{ top: 24 }}
    >
      {doc && (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {t.partner}：{doc.partner_name} · 单据金额 {cur(doc.amount, doc.currency)} · 未结余额 <b>{cur(doc.balance, doc.currency)}</b>
            {foreign && ` · 记账汇率 ${rateText(doc.exchange_rate)}（${fmtDate(doc.doc_date)}）`}
          </Typography.Paragraph>
          {kind === 'AP' && doc.iqc && (
            <Alert
              style={{ marginBottom: 12 }}
              type={iqcBad ? 'warning' : 'success'}
              showIcon
              message={<Space>来料检验：<IqcTag iqc={doc.iqc} />（入库单 <RefLink doc={doc} />）</Space>}
              description={iqcBad ? '来料尚未检验合格，付款时需再次确认。' : undefined}
            />
          )}
          {myAdv.length > 0 && (
            <Alert
              style={{ marginBottom: 12 }}
              type="info"
              showIcon
              message={`该${t.partner}有可用${t.adv}，可直接冲抵（不经银行）`}
              description={
                <Space wrap>
                  {myAdv.map((a) => (
                    <Button key={a.id} size="small" icon={<SwapOutlined />} loading={saving} onClick={() => offset(a)}>
                      用 {a.no}（余 {cur(a.balance, a.currency)}）冲抵
                    </Button>
                  ))}
                </Space>
              }
            />
          )}
          <Form
            form={form}
            layout="vertical"
            preserve={false}
            initialValues={{ amount: doc.balance, fee_amount: 0, pay_date: dayjs(), method: '银行转账', bank_account: recentAccounts(kind)[0], exchange_rate: foreign ? rateOf(doc.currency) ?? doc.exchange_rate : undefined }}
          >
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="amount" label={`${t.amountLabel}（${doc.currency}）`} rules={[{ required: true, message: '请填写金额' }]} extra={kind === 'AR' ? '含银行扣除的手续费' : undefined}>
                  <InputNumber style={{ width: '100%' }} min={0.01} precision={2} autoFocus />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="fee_amount" label={`手续费（${doc.currency}）`} tooltip={t.feeHint}>
                  <InputNumber style={{ width: '100%' }} min={0} precision={2} />
                </Form.Item>
              </Col>
              <Col span={8}>
                {foreign ? (
                  <Form.Item name="exchange_rate" label={`${t.rateLabel}（1 ${doc.currency} = ? ${base}）`} rules={[{ required: true, message: '请填写汇率' }]}>
                    <InputNumber style={{ width: '100%' }} min={0.000001} precision={6} />
                  </Form.Item>
                ) : (
                  <Form.Item name="pay_date" label={t.dateLabel} rules={[{ required: true, message: '请选择日期' }]}>
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                )}
              </Col>
              {foreign && (
                <Col span={8}>
                  <Form.Item name="pay_date" label={t.dateLabel} rules={[{ required: true, message: '请选择日期' }]}>
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              )}
              <Col span={8}>
                <Form.Item name="method" label="结算方式"><AutoComplete options={METHODS} /></Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="reference" label="银行流水号/票据号"><Input /></Form.Item>
              </Col>
              <Col span={foreign ? 12 : 8}>
                <Form.Item name="bank_account" label={kind === 'AR' ? '收款账户' : '付款账户'}><BankAccountInput kind={kind} /></Form.Item>
              </Col>
              <Col span={foreign ? 12 : 24}>
                <Form.Item name="remark" label="备注"><Input /></Form.Item>
              </Col>
            </Row>
            {over > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`金额超出未结余额 ${amt(over)}`}
                description={
                  <Form.Item name="as_advance" valuePropName="checked" style={{ marginBottom: 0 }}>
                    <Checkbox>超出部分 {cur(over, doc.currency)} 转为{t.adv}（以后可冲抵该{t.partner}的其他{t.name}单）</Checkbox>
                  </Form.Item>
                }
              />
            )}
            <Descriptions
              size="small"
              bordered
              column={2}
              items={[
                {
                  key: 'bank', label: `${t.bank}（原币）`,
                  children: (
                    <span>
                      {cur(r2(pv.bankFc + (over > 0 ? over : 0)), doc.currency)}
                      {over > 0 && <Typography.Text type={asAdvance ? 'secondary' : 'danger'} style={{ fontSize: 12 }}>（含超出 {amt(over)}{asAdvance ? ` 转${t.adv}` : '，请勾选转' + t.adv}）</Typography.Text>}
                    </span>
                  ),
                },
                ...(foreign
                  ? [
                      { key: 'bankb', label: `${t.bank}（${base}）`, children: amt(r2(pv.bank + (over > 0 ? over * (rate || bookRate) : 0))) },
                      { key: 'booked', label: `冲销${t.name}（记账汇率 ${rateText(bookRate)}）`, children: `${base} ${amt(pv.booked)}` },
                      { key: 'fee', label: `手续费（${base}）`, children: amt(pv.feeBase) },
                      { key: 'fx', label: '汇兑差异', span: 2, children: <FxText v={pv.fx} base={base} /> },
                    ]
                  : [{ key: 'fee', label: '手续费', children: amt(fee) }]),
              ]}
            />
          </Form>
        </>
      )}
    </Modal>
  );
}

// ======================= 合并收/付款（按到期日自动分配） =======================
function SettleModal({ kind, open, base, rateOf, onClose, onDone }: { kind: Kind; open: boolean; base: string; rateOf: (c: string) => number | undefined; onClose: () => void; onDone: () => void }) {
  const t = TEXT[kind];
  const [form] = Form.useForm();
  const [plan, setPlan] = useState<Rec | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const partner = Form.useWatch('partner_id', form);
  const currency: string = Form.useWatch('currency', form) || base;
  const received = Number(Form.useWatch('received', form) || 0);
  const fee = Number(Form.useWatch('fee_amount', form) || 0);
  const rate = Number(Form.useWatch('exchange_rate', form) || 0);
  const asAdvance = !!Form.useWatch('as_advance', form);
  const amount = kind === 'AR' ? r2(received + fee) : received;
  const timer = useRef<any>();

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setPlanErr(null);
    clearTimeout(timer.current);
    if (!partner || !(amount > 0)) return;
    timer.current = setTimeout(() => {
      post('/finance/receipts', { kind, partner_id: partner, currency, amount, dry_run: true }, true)
        .then((d) => setPlan(d))
        .catch((e) => setPlanErr(e?.response?.data?.detail || '无法生成分配方案'));
    }, 300);
  }, [open, kind, partner, currency, amount]);

  /** 选币别（或选客户带出币别）时，实收汇率默认今日汇率 */
  const pickCurrency = (c: string) => form.setFieldsValue({ currency: c, exchange_rate: c === base ? undefined : rateOf(c) });

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    if (!plan) {
      message.error(planErr || '请先选择往来单位并填写金额');
      return;
    }
    if (plan.excess > 0 && !v.as_advance) {
      message.error(`金额超出未结合计 ${amt(plan.excess)}，请勾选“超出部分转${t.adv}”或核对金额`);
      return;
    }
    setSaving(true);
    try {
      const res = await post('/finance/receipts', {
        kind, partner_id: v.partner_id, currency, amount, fee_amount: v.fee_amount || 0, exchange_rate: currency === base ? undefined : v.exchange_rate,
        pay_date: toDate(v.pay_date), method: v.method, reference: v.reference, remark: v.remark, as_advance: !!v.as_advance, bank_account: v.bank_account || null,
      });
      rememberAccount(kind, v.bank_account);
      Modal.success({
        title: `${t.settle}已登记：${res.receipt_no}`,
        width: 560,
        content: (
          <div>
            {(res.allocations as Rec[]).map((a) => <div key={a.doc_id}>{a.no}：核销 {cur(a.amount, currency)}{a.balance_after > 0 ? `，余 ${amt(a.balance_after)}` : '，已结清'}</div>)}
            {res.advance && <div>超出部分转{t.adv} {res.advance.no}：{cur(res.advance.amount, currency)}</div>}
          </div>
        ),
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const cols: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', render: (v) => <span className="mono">{v}</span> },
    { title: '来源单据', dataIndex: 'ref_no', render: (v) => v || '-' },
    { title: '单据日期', dataIndex: 'doc_date', render: fmtDate },
    { title: '到期日', dataIndex: 'due_date', render: (v) => <DueDate value={v} overdue={isPast(v)} hint="已逾期" /> },
    { title: '未结余额', dataIndex: 'balance', align: 'right', render: (v) => amt(v) },
    { title: '本次核销', dataIndex: 'amount', align: 'right', render: (v) => <b>{amt(v)}</b> },
    { title: '核销后余额', dataIndex: 'balance_after', align: 'right', render: (v) => (v > 0 ? amt(v) : <Tag color="green">结清</Tag>) },
  ];

  return (
    <Modal open={open} title={`${t.settle}（一笔款核销多张${t.name}单，按到期日先后自动分配）`} width={900} style={{ top: 24 }} okText="确认登记" onCancel={onClose} onOk={submit} confirmLoading={saving} destroyOnHidden maskClosable={false}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ pay_date: dayjs(), method: kind === 'AR' ? '电汇(T/T)' : '银行转账', fee_amount: 0, currency: base, bank_account: recentAccounts(kind)[0] }}>
        <Row gutter={16}>
          <Col span={10}>
            <Form.Item name="partner_id" label={t.partner} rules={[{ required: true, message: `请选择${t.partner}` }]}>
              {kind === 'AR' ? (
                <CustomerSelect autoFocus onPick={(r) => r && pickCurrency(r.currency || base)} />
              ) : (
                <SupplierSelect autoFocus onPick={(r) => r && pickCurrency(r.currency || base)} />
              )}
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="currency" label="币别"><Select options={CURRENCIES} onChange={pickCurrency} /></Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="received" label={kind === 'AR' ? `银行到账（${currency}）` : `付款金额（${currency}）`} rules={[{ required: true, message: '请填写金额' }]}>
              <InputNumber style={{ width: '100%' }} min={0.01} precision={2} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="fee_amount" label="手续费" tooltip={t.feeHint}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col span={6} style={currency !== base ? undefined : { display: 'none' }}>
            <Form.Item name="exchange_rate" label={`${t.rateLabel}（1 ${currency} = ? ${base}）`} rules={[{ required: currency !== base, message: '请填写汇率' }]}>
              <InputNumber style={{ width: '100%' }} min={0.000001} precision={6} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="pay_date" label={t.dateLabel} rules={[{ required: true, message: '请选择日期' }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="method" label="结算方式"><AutoComplete options={METHODS} /></Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="reference" label="银行流水号"><Input /></Form.Item>
          </Col>
          <Col span={currency !== base ? 12 : 6}>
            <Form.Item name="bank_account" label={kind === 'AR' ? '收款账户' : '付款账户'}><BankAccountInput kind={kind} /></Form.Item>
          </Col>
          <Col span={currency !== base ? 12 : 24}>
            <Form.Item name="remark" label="备注"><Input /></Form.Item>
          </Col>
        </Row>
        <Divider style={{ margin: '4px 0 12px' }} orientation="left" plain>
          核销合计 {cur(amount, currency)}{kind === 'AR' && fee > 0 ? `（到账 ${amt(received)} + 手续费 ${amt(fee)}）` : ''}
          {currency !== base && rate > 0 ? ` · 折合 ${base} ${amt(r2(amount * rate))}` : ''}
        </Divider>
        {planErr && <Alert type="error" showIcon message={planErr} style={{ marginBottom: 12 }} />}
        {plan ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              该{t.partner} {currency} 未结合计 {amt(plan.open_total)}，本次核销 {amt(plan.applied)}，共 {plan.allocations.length} 张单据：
            </Typography.Paragraph>
            <Table rowKey="doc_id" size="small" columns={cols} dataSource={plan.allocations} pagination={false} scroll={{ x: 'max-content', y: 240 }} />
            {plan.excess > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={`超出未结合计 ${cur(plan.excess, currency)}`}
                description={
                  <Form.Item name="as_advance" valuePropName="checked" style={{ marginBottom: 0 }}>
                    <Checkbox>超出部分转为{t.adv}{asAdvance ? '（登记后可在单据上“冲抵”）' : ''}</Checkbox>
                  </Form.Item>
                }
              />
            )}
          </>
        ) : (
          !planErr && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`选择${t.partner}并填写金额后，自动显示分配方案`} />
        )}
      </Form>
    </Modal>
  );
}

// ======================= 作废收付款 =======================
function VoidModal({ payment, onClose, onDone }: { payment: Rec | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setReason(''), [payment]);
  return (
    <Modal
      open={!!payment}
      title={`作废${payment?.kind === 'AP' ? '付款' : '收款'}记录`}
      okText="确认作废"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        if (reason.trim().length < 2) {
          message.error('请填写作废原因');
          return;
        }
        setSaving(true);
        try {
          const r = await post(`/finance/payments/${payment!.id}/void`, { reason: reason.trim() });
          message.success(`已作废 ${r.voided} 条核销记录${r.advances_voided?.length ? `，并作废 ${r.advances_voided.join('、')}` : ''}；单据余额已恢复`);
          onDone();
        } finally {
          setSaving(false);
        }
      }}
    >
      {payment && (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${payment.receipt_no ? `收付款单 ${payment.receipt_no} 下的全部核销记录将一并作废（一笔银行流水为一个整体）` : '该笔记录将作废'}，单据已收/付金额回滚；记录保留并标记“已作废”，审计追踪可查。`}
          />
          <Descriptions
            size="small"
            column={2}
            items={[
              { key: 'd', label: '日期', children: fmtDate(payment.pay_date) },
              { key: 'a', label: '金额', children: amt(payment.amount) },
              { key: 'm', label: '结算方式', children: payment.method || '-' },
              { key: 'r', label: '流水号', children: payment.reference || '-' },
            ]}
          />
          <Input.TextArea rows={2} autoFocus placeholder="作废原因（必填）" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} showCount style={{ marginTop: 8 }} />
          <Space wrap style={{ marginTop: 6 }}>
            {VOID_REASONS.map((r) => <Tag key={r} style={{ cursor: 'pointer' }} onClick={() => setReason(r)}>{r}</Tag>)}
          </Space>
        </>
      )}
    </Modal>
  );
}

const payStatus = (p: Rec) =>
  p.status === 'VOID' ? (
    <Tooltip title={`${p.voided_by ?? ''} ${fmtDateTime(p.voided_at)} 作废：${p.void_reason ?? ''}`}><Tag color="default" icon={<StopOutlined />}>已作废</Tag></Tooltip>
  ) : (
    <Tag color="green">有效</Tag>
  );

// ======================= 应收 / 应付单据 =======================
function docExportColumns(kind: Kind): ExportColumn[] {
  const t = TEXT[kind];
  return [
    { title: '单号', key: 'no' },
    { title: '单据日期', key: 'doc_date', type: 'date' },
    { title: '到期日', key: 'due_date', type: 'date' },
    ...(kind === 'AR' ? [{ title: '发票号', key: 'invoice_no' }, { title: '开票日期', key: 'invoice_date', type: 'date' as const }] : []),
    { title: `${t.partner}编码`, key: 'partner_code' },
    { title: `${t.partner}名称`, key: 'partner_name', width: 30 },
    { title: '币别', key: 'currency' },
    { title: '记账汇率', key: 'exchange_rate', type: 'number' },
    { title: '原币金额', key: 'amount', type: 'money' },
    { title: `${t.paid}（原币）`, key: 'paid_amount', type: 'money' },
    { title: '未结余额（原币）', key: 'balance', type: 'money' },
    { title: '本位币金额', key: 'base_amount', type: 'money' },
    { title: '本位币余额', key: 'base_balance', type: 'money' },
    { title: '状态', value: (r) => ({ OPEN: '未结', PARTIAL: '部分结算', PAID: '已结清' } as Rec)[r.status] ?? r.status },
    { title: '来源单据', key: 'ref_no' },
    { title: '摘要', key: 'remark', width: 36 },
    ...(kind === 'AP' ? [{ title: '来料检验', value: (r: Rec) => r.iqc?.text ?? '' }] : []),
  ];
}

/** 应收单发票号 / 开票日期（财务登记，金蝶凭证摘要带发票号） */
function InvoiceCell({ doc, editable, onDone }: { doc: Rec; editable: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [no, setNo] = useState<string>(doc.invoice_no ?? '');
  const [date, setDate] = useState<string | null>(doc.invoice_date ?? null);
  const save = async () => {
    await put(`/finance/docs/${doc.id}/invoice`, { invoice_no: no || null, invoice_date: date });
    message.success(no ? `已登记发票 ${no}` : '已清除发票号');
    setOpen(false);
    onDone();
  };
  const text = doc.invoice_no ? (
    <span>
      <span className="mono">{doc.invoice_no}</span>
      {doc.invoice_date && <Typography.Text type="secondary" style={{ fontSize: 12 }}> {fmtDate(doc.invoice_date).slice(5)}</Typography.Text>}
    </span>
  ) : (
    <Typography.Text type="secondary">未开票</Typography.Text>
  );
  if (!editable || doc.status === 'VOID') return text;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setNo(doc.invoice_no ?? '');
          setDate(doc.invoice_date ?? dayjs().format('YYYY-MM-DD'));
        }
      }}
      trigger="click"
      title="登记发票"
      content={
        <Space direction="vertical">
          <Input autoFocus placeholder="发票号码" value={no} onChange={(e) => setNo(e.target.value)} onPressEnter={save} />
          <DatePicker value={date ? dayjs(date) : null} onChange={(d) => setDate(d ? d.format('YYYY-MM-DD') : null)} placeholder="开票日期" style={{ width: '100%' }} />
          <Button type="primary" size="small" onClick={save}>保存</Button>
        </Space>
      }
    >
      <Typography.Link>{doc.invoice_no ? text : '登记发票'}</Typography.Link>
    </Popover>
  );
}

function FinDocs({ kind, totals, base, rateOf, onChanged }: { kind: Kind; totals: Rec; base: string; rateOf: (c: string) => number | undefined; onChanged: () => void }) {
  const { can } = useAuth();
  const t = TEXT[kind];
  const [sp] = useSearchParams();
  const mine = (sp.get('tab') || 'AR') === kind;
  const init = {
    doc_type: kind,
    q: (mine && sp.get('q')) || undefined,
    status: (mine && sp.get('status')) || undefined,
    overdue: (mine && sp.get('overdue')) || undefined,
    due_within: (mine && sp.get('due_within')) || undefined,
    partner_id: mine && sp.get('partner_id') ? Number(sp.get('partner_id')) : undefined,
  };
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/finance/docs', init);
  const [paying, setPaying] = useState<Rec | null>(null);
  const [voiding, setVoiding] = useState<Rec | null>(null);
  const [settling, setSettling] = useState(false);
  const [advances, setAdvances] = useState<Rec[]>([]);
  const loadAdv = useCallback(() => {
    get('/finance/docs', { doc_type: t.advType, status: 'OPEN,PARTIAL', page_size: 500 }, true).then((d) => setAdvances(d.items)).catch(() => undefined);
  }, [t.advType]);
  useEffect(() => loadAdv(), [loadAdv]);
  const advTotal = useMemo(() => {
    const m: Record<string, number> = {};
    advances.forEach((a) => (m[a.currency] = r2((m[a.currency] || 0) + a.balance)));
    return m;
  }, [advances]);
  const total = totals.total || 0;
  const overdueAmt = Object.entries(totals).filter(([k]) => /天/.test(k)).reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const byCur: Rec[] = totals.by_currency || [];
  const missing: string[] = totals.missing_rates || [];
  const changed = () => {
    reload();
    loadAdv();
    onChanged();
  };

  // 1366 宽度下财务最关心的“金额 / 未结余额 / 状态 / 到期日”排在前面；记账汇率、本位币等放后面。手机上变卡片。
  const columns: RColumn<Rec>[] = [
    { title: '单号', dataIndex: 'no', fixed: 'left', sorter: true, width: 130, mobile: 'title', render: (v) => <span className="mono">{v}</span> },
    {
      title: t.partner, dataIndex: 'partner_name', ellipsis: true, width: 180, mobile: 'subtitle',
      render: (v, r) => <Tooltip title={`${r.partner_code ?? ''} ${v ?? ''}`}><span>{v}</span></Tooltip>,
    },
    { title: '金额', dataIndex: 'amount', align: 'right', sorter: true, width: 120, render: (v, r) => cur(v, r.currency) },
    { title: '未结余额', dataIndex: 'balance', align: 'right', width: 120, render: (v, r) => <b>{cur(v, r.currency)}</b> },
    { title: '状态', dataIndex: 'status', sorter: true, width: 90, render: (v) => <StatusTag dict="fin_status" value={v} /> },
    { title: '到期日', dataIndex: 'due_date', sorter: true, width: 105, render: (v, r) => <DueDate value={v} overdue={r.status !== 'PAID' && isPast(v)} hint="已逾期未结清" /> },
    ...(kind === 'AR'
      ? [{
          title: '发票号', dataIndex: 'invoice_no', width: 140, mobile: 'hidden' as const,
          render: (_v: string | null, r: Rec) => <InvoiceCell doc={r} editable={can('finance')} onDone={reload} />,
        }]
      : []),
    ...(kind === 'AP' ? [{ title: '来料检验', key: 'iqc', width: 110, render: (_: unknown, r: Rec) => <IqcTag iqc={r.iqc} /> }] : []),
    { title: '来源单据', key: 'ref', mobile: 'hidden', render: (_, r) => <RefLink doc={r} /> },
    { title: '单据日期', dataIndex: 'doc_date', sorter: true, mobile: 'hidden', render: fmtDate },
    { title: '币别', dataIndex: 'currency', sorter: true, mobile: 'hidden', render: (v) => <Tag>{v}</Tag> },
    {
      title: '记账汇率', dataIndex: 'exchange_rate', align: 'right', mobile: 'hidden',
      render: (v, r) => (r.currency === base ? '-' : v === null ? <Typography.Text type="warning">缺汇率</Typography.Text> : rateText(v)),
    },
    { title: `本位币（${base}）`, dataIndex: 'base_amount', align: 'right', sorter: true, mobile: 'hidden', render: (v) => amt(v) },
    { title: t.paid, dataIndex: 'paid_amount', align: 'right', sorter: true, mobile: 'hidden', render: (v, r) => cur(v, r.currency) },
    { title: '摘要', dataIndex: 'remark', ellipsis: true, width: 200, mobile: 'hidden', render: (v) => v || '-' },
  ];
  if (can('finance')) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 90,
      render: (_, r) => (r.status !== 'PAID' && r.doc_type === kind ? <Button size="small" type="link" icon={<DollarOutlined />} onClick={() => setPaying(r)}>{t.pay}</Button> : null),
    });
  }

  const payCols = (currency: string): TableColumnsType<Rec> => [
    { title: '收付款单号', dataIndex: 'receipt_no', render: (v) => <span className="mono">{v || '-'}</span> },
    { title: t.dateLabel, dataIndex: 'pay_date', render: fmtDate },
    { title: '核销金额', dataIndex: 'amount', align: 'right', render: (v) => cur(v, currency) },
    { title: '手续费', dataIndex: 'fee_amount', align: 'right', render: (v) => amt(v) },
    ...(currency !== base
      ? [
          { title: '实际汇率', dataIndex: 'exchange_rate', align: 'right' as const, render: (v: number) => rateText(v) },
          { title: `本位币（${base}）`, dataIndex: 'base_amount', align: 'right' as const, render: (v: number) => amt(v) },
          { title: '汇兑差异', dataIndex: 'fx_diff', align: 'right' as const, render: (v: number) => (v ? <span style={{ color: v > 0 ? '#389e0d' : '#cf1322' }}>{v > 0 ? '+' : ''}{amt(v)}</span> : '0') },
        ]
      : []),
    { title: '结算方式', dataIndex: 'method', render: (v) => v || '-' },
    { title: '流水号/票据号', dataIndex: 'reference', render: (v) => v || '-' },
    { title: '账户', dataIndex: 'bank_account', render: (v) => v || '-' },
    { title: '状态', dataIndex: 'status', render: (_, p) => payStatus(p) },
    { title: '登记人', dataIndex: 'created_by', render: (v, p) => `${v ?? '-'} · ${fmtDateTime(p.created_at)}` },
    ...(can('finance')
      ? [{ title: '', key: '_op', render: (_: unknown, p: Rec) => (p.status !== 'VOID' ? <Button size="small" type="link" danger icon={<RollbackOutlined />} onClick={() => setVoiding({ ...p, kind })}>作废</Button> : null) }]
      : []),
  ];

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title={`${t.name}余额合计（折合 ${base}）`} value={total} precision={2} /></Card></Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => setQuery({ overdue: '1', status: undefined })}>
            <Statistic title={`其中已逾期（折合 ${base}）· 点击筛选`} value={overdueAmt} precision={2} valueStyle={{ color: overdueAmt > 0 ? '#cf1322' : undefined }} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Space wrap size={[8, 4]}>
            {byCur.length > 0 && <Typography.Text type="secondary">按币别未结：</Typography.Text>}
            {byCur.map((r) => <Tag key={`bal-${r.currency}`}>{cur(r.amount, r.currency)}</Tag>)}
            {Object.keys(advTotal).length > 0 && <Typography.Text type="secondary">{t.adv}余额：</Typography.Text>}
            {Object.entries(advTotal).map(([c, v]) => <Tag key={`adv-${c}`} color="purple">{cur(v, c)}</Tag>)}
          </Space>
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
            {kind === 'AR' ? '发货过账自动生成应收，到期日 = 发货日 + 客户账期。' : '采购收货自动生成应付，到期日 = 收货日 + 供应商账期。'}
            外币单据按单据日期汇率记账（记账汇率、本位币）；收付款记录实际汇率、手续费，系统自动算汇兑差异。
          </Typography.Paragraph>
          {missing.length > 0 && <Alert type="warning" showIcon style={{ marginTop: 8 }} message={`缺少 ${missing.join('、')} 汇率，这些币别未计入本位币合计。请在“基础资料 → 汇率”中维护。`} />}
        </Col>
      </Row>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 110 }}
          value={query.doc_type}
          options={[{ value: kind, label: `${t.name}单` }, { value: t.advType, label: t.adv }]}
          onChange={(v) => setQuery({ doc_type: v })}
        />
        <Input.Search allowClear placeholder={`单号 / 来源单号 / ${t.partner} / 订单号`} defaultValue={init.q || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
        {kind === 'AR' ? (
          <CustomerSelect style={{ width: 220 }} placeholder="客户" defaultValue={init.partner_id} onChange={(v) => setQuery({ partner_id: v })} />
        ) : (
          <SupplierSelect style={{ width: 220 }} placeholder="供应商" defaultValue={init.partner_id} onChange={(v) => setQuery({ partner_id: v })} />
        )}
        <DatePicker picker="month" placeholder="期间（单据月份）" style={{ width: 150 }} onChange={(v) => setQuery({ period: v ? v.format('YYYY-MM') : undefined })} />
        <Select allowClear placeholder="币别" style={{ width: 100 }} options={CURRENCIES} onChange={(v) => setQuery({ currency: v })} />
        <Select
          allowClear
          placeholder="结算状态"
          style={{ width: 130 }}
          defaultValue={init.status}
          options={[{ value: 'OPEN,PARTIAL', label: '未结清' }, ...dictOptions('fin_status')]}
          onChange={(v) => setQuery({ status: v })}
        />
        <Checkbox checked={query.overdue === '1'} onChange={(e) => setQuery({ overdue: e.target.checked ? '1' : undefined })}>只看逾期</Checkbox>
        {query.due_within !== undefined && (
          <Tag closable color="orange" onClose={() => setQuery({ due_within: undefined })}>{query.due_within} 天内到期（含逾期）</Tag>
        )}
        <Button icon={<ReloadOutlined />} onClick={changed} />
        <ExportButton url="/finance/docs" params={{ ...query, sort: undefined, order: undefined }} filename={`${t.name}明细_${dayjs().format('YYYYMMDD')}`} columns={docExportColumns(kind)} />
        {can('finance') && <Button icon={<MergeCellsOutlined />} onClick={() => setSettling(true)}>{t.settle}</Button>}
      </Space>
      <ResponsiveTable
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        onChange={onTableChange}
        scroll={{ x: 'max-content' }}
        expandable={{
          columnWidth: 28,
          rowExpandable: (r) => !!r.payments?.length,
          expandedRowRender: (r) => <Table rowKey="id" size="small" columns={payCols(r.currency)} dataSource={r.payments} pagination={false} scroll={{ x: 'max-content' }} />,
        }}
      />
      <PaymentModal
        doc={paying}
        advances={advances}
        base={base}
        rateOf={rateOf}
        onClose={() => setPaying(null)}
        onDone={() => {
          setPaying(null);
          changed();
        }}
      />
      <SettleModal
        kind={kind}
        open={settling}
        base={base}
        rateOf={rateOf}
        onClose={() => setSettling(false)}
        onDone={() => {
          setSettling(false);
          changed();
        }}
      />
      <VoidModal
        payment={voiding}
        onClose={() => setVoiding(null)}
        onDone={() => {
          setVoiding(null);
          changed();
        }}
      />
    </>
  );
}

// ======================= 收付款流水 =======================
const PAY_EXPORT: ExportColumn[] = [
  { title: '收付款单号', key: 'receipt_no' },
  { title: '日期', key: 'pay_date', type: 'date' },
  { title: '类型', value: (r) => (r.kind === 'AP' ? '付款' : '收款') },
  { title: '往来单位编码', key: 'partner_code' },
  { title: '往来单位', key: 'partner_name', width: 30 },
  { title: '核销单据', key: 'doc_no' },
  { title: '币别', key: 'currency' },
  { title: '核销金额（原币）', key: 'amount', type: 'money' },
  { title: '手续费（原币）', key: 'fee_amount', type: 'money' },
  { title: '银行到账（原币）', key: 'bank_amount', type: 'money' },
  { title: '转预收/预付单', key: 'advance_no' },
  { title: '转预收/预付金额', key: 'advance_amount', type: 'money' },
  { title: '银行账户', key: 'bank_account' },
  { title: '实际汇率', key: 'exchange_rate', type: 'number' },
  { title: '本位币', key: 'base_amount', type: 'money' },
  { title: '记账汇率', key: 'booking_rate', type: 'number' },
  { title: '汇兑差异', key: 'fx_diff', type: 'money' },
  { title: '结算方式', key: 'method' },
  { title: '流水号/票据号', key: 'reference' },
  { title: '状态', value: (r) => (r.status === 'VOID' ? '已作废' : '有效') },
  { title: '作废原因', key: 'void_reason' },
  { title: '登记人', key: 'created_by' },
];

function PaymentsLedger({ base, onChanged }: { base: string; onChanged: () => void }) {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const mine = sp.get('tab') === 'PAY';
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/finance/payments', { q: (mine && sp.get('q')) || undefined });
  const [voiding, setVoiding] = useState<Rec | null>(null);
  const kind: string | undefined = query.kind;
  const columns: TableColumnsType<Rec> = [
    { title: '收付款单号', dataIndex: 'receipt_no', sorter: true, fixed: 'left', render: (v) => <span className="mono">{v || '-'}</span> },
    { title: '日期', dataIndex: 'pay_date', sorter: true, render: fmtDate },
    { title: '状态', dataIndex: 'status', sorter: true, render: (_, p) => payStatus(p) },
    {
      title: '类型', key: 'kind',
      render: (_, r) => (['预收冲抵', '预付冲抵', '冲抵应收', '冲抵应付'].includes(r.method) ? <Tag color="purple">{r.method}</Tag> : <Tag color={r.kind === 'AP' ? 'orange' : 'blue'}>{r.kind === 'AP' ? '付款' : '收款'}</Tag>),
    },
    { title: '往来单位', dataIndex: 'partner_name', ellipsis: true, width: 200 },
    { title: '核销单据', dataIndex: 'doc_no', render: (v, r) => <Link to={`/finance?tab=${r.kind === 'AP' ? 'AP' : 'AR'}&q=${encodeURIComponent(v)}`} className="mono">{v}</Link> },
    { title: '币别', dataIndex: 'currency', render: (v) => <Tag>{v}</Tag> },
    { title: '核销金额', dataIndex: 'amount', sorter: true, align: 'right', render: (v, r) => cur(v, r.currency) },
    { title: '手续费', dataIndex: 'fee_amount', align: 'right', render: (v) => amt(v) },
    {
      title: <Tooltip title="银行实际到账/付出金额：收款 = 核销 − 手续费，付款 = 核销 + 手续费；含超额转入预收/预付的部分。冲抵不经银行">银行到账</Tooltip>,
      dataIndex: 'bank_amount', align: 'right',
      render: (v, r) => (
        <div>
          <b>{v ? cur(v, r.currency) : '-'}</b>
          {r.advance_no && <div><Tag color="blue" style={{ marginInlineEnd: 0 }}>含转{r.kind === 'AP' ? '预付' : '预收'} {r.advance_no} {amt(r.advance_amount)}</Tag></div>}
        </div>
      ),
    },
    { title: '实际汇率', dataIndex: 'exchange_rate', align: 'right', render: (v, r) => (r.currency === base ? '-' : rateText(v)) },
    { title: `本位币（${base}）`, dataIndex: 'base_amount', sorter: true, align: 'right', render: (v) => amt(v) },
    {
      title: '汇兑差异', dataIndex: 'fx_diff', sorter: true, align: 'right',
      render: (v) => (v ? <span style={{ color: v > 0 ? '#389e0d' : '#cf1322' }}>{v > 0 ? '+' : ''}{amt(v)}</span> : '-'),
    },
    { title: '结算方式', dataIndex: 'method', render: (v) => v || '-' },
    { title: '流水号', dataIndex: 'reference', render: (v) => v || '-' },
    { title: '银行账户', dataIndex: 'bank_account', render: (v) => v || '-' },
    { title: '登记人', dataIndex: 'created_by' },
  ];
  if (can('finance')) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 80,
      render: (_, p) => (p.status !== 'VOID' ? <Button size="small" type="link" danger icon={<RollbackOutlined />} onClick={() => setVoiding(p)}>作废</Button> : null),
    });
  }
  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          value={kind ?? ''}
          options={[{ value: '', label: '全部' }, { value: 'AR', label: '收款' }, { value: 'AP', label: '付款' }]}
          onChange={(v) => setQuery({ kind: v || undefined, partner_id: undefined })}
        />
        {kind === 'AR' && <CustomerSelect style={{ width: 220 }} placeholder="客户" onChange={(v) => setQuery({ partner_id: v })} />}
        {kind === 'AP' && <SupplierSelect style={{ width: 220 }} placeholder="供应商" onChange={(v) => setQuery({ partner_id: v })} />}
        <DatePicker picker="month" placeholder="期间（月份）" style={{ width: 150 }} onChange={(v) => setQuery({ period: v ? v.format('YYYY-MM') : undefined })} />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 110 }}
          options={[{ value: 'VALID', label: '有效' }, { value: 'VOID', label: '已作废' }]}
          onChange={(v) => setQuery({ status: v })}
        />
        <Input.Search allowClear placeholder="收付款单号 / 流水号 / 单据号 / 往来单位" defaultValue={(mine && sp.get('q')) || ''} style={{ width: 300 }} onSearch={(q) => setQuery({ q })} />
        <Button icon={<ReloadOutlined />} onClick={reload} />
        <ExportButton url="/finance/payments" params={{ ...query, sort: undefined, order: undefined }} filename={`收付款流水_${dayjs().format('YYYYMMDD')}`} columns={PAY_EXPORT} />
      </Space>
      <Table
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        onChange={onTableChange}
        scroll={{ x: 'max-content' }}
        onRow={(r) => ({ style: r.status === 'VOID' ? { color: '#8c8c8c', textDecoration: 'line-through' } : undefined })}
      />
      <VoidModal
        payment={voiding}
        onClose={() => setVoiding(null)}
        onDone={() => {
          setVoiding(null);
          reload();
          onChanged();
        }}
      />
    </>
  );
}

// ======================= 账龄分析 =======================
function AgingTable({ kind, data }: { kind: Kind; data: Rec }) {
  const t = TEXT[kind];
  const base: string = data.base_currency || 'CNY';
  const labels: string[] = data.buckets || [];
  const rows: Rec[] = data[kind] || [];
  const totals: Rec = data.totals?.[kind] || BLANK;
  const subs: Rec[] = data.subtotals?.[kind] || [];
  const missing: string[] = totals.missing_rates || [];
  const columns: TableColumnsType<Rec> = [
    { title: t.partner, dataIndex: 'partner', ellipsis: true, width: 240, render: (v, r) => <Tooltip title={r.partner_code}>{v || '-'}</Tooltip> },
    { title: '币别', dataIndex: 'currency', width: 70, render: (v) => <Tag>{v}</Tag> },
    ...labels.map((b, i) => ({
      title: b, dataIndex: b, align: 'right' as const,
      render: (v: number) => (i > 0 && v > 0 ? <span style={{ color: i === 1 ? '#d48806' : '#cf1322' }}>{amt(v)}</span> : amt(v)),
    })),
    { title: '合计（原币）', dataIndex: 'total', align: 'right', render: (v, r) => <b>{cur(v, r.currency)}</b> },
    {
      title: `折合 ${base}`, dataIndex: 'total_base', align: 'right',
      render: (v, r) => (v === null || v === undefined ? <Typography.Text type="warning">缺 {r.currency} 汇率</Typography.Text> : amt(v)),
    },
  ];
  const docCols: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', render: (v) => <Link to={`/finance?tab=${kind}&q=${encodeURIComponent(v)}`} className="mono">{v}</Link> },
    { title: '来源单据', dataIndex: 'ref_no', render: (_, d) => <RefLink doc={d} /> },
    { title: '单据日期', dataIndex: 'doc_date', render: fmtDate },
    { title: '到期日', dataIndex: 'due_date', render: fmtDate },
    { title: '逾期天数', dataIndex: 'overdue_days', align: 'right', render: (v) => (v > 0 ? <span style={{ color: '#cf1322' }}>{v} 天</span> : '-') },
    { title: '区间', dataIndex: 'bucket' },
    { title: '单据金额', dataIndex: 'amount', align: 'right', render: (v) => amt(v) },
    { title: '截止日余额', dataIndex: 'balance', align: 'right', render: (v) => <b>{amt(v)}</b> },
    { title: '折算汇率', dataIndex: 'rate', align: 'right', render: (v) => rateText(v) },
    { title: `折合 ${base}`, dataIndex: 'base_balance', align: 'right', render: (v) => amt(v) },
  ];
  const n = labels.length;
  return (
    <Card size="small" title={`${t.name}账龄（${t.partner}）`}>
      <Table
        rowKey={(r) => `${r.partner ?? '-'}|${r.currency}`}
        size="middle"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{
          expandedRowRender: (r) => <Table rowKey="id" size="small" columns={docCols} dataSource={r.docs} pagination={false} scroll={{ x: 'max-content' }} />,
          rowExpandable: (r) => !!r.docs?.length,
        }}
        summary={(data) =>
          data.length ? (
            <>
              {subs.map((s) => (
                <Table.Summary.Row key={s.currency} style={{ background: '#fafafa' }}>
                  <Table.Summary.Cell index={0} colSpan={2}>{s.currency} 小计（{s.rows} 个{t.partner}）</Table.Summary.Cell>
                  <Table.Summary.Cell index={2} />
                  {labels.map((b, i) => <Table.Summary.Cell key={b} index={i + 3} align="right">{amt(s[b])}</Table.Summary.Cell>)}
                  <Table.Summary.Cell index={n + 3} align="right"><b>{cur(s.total, s.currency)}</b></Table.Summary.Cell>
                  <Table.Summary.Cell index={n + 4} align="right">{s.total_base === null ? '-' : amt(s.total_base)}</Table.Summary.Cell>
                </Table.Summary.Row>
              ))}
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3}>
                  <b>合计（折合 {base}）</b>
                  {missing.length > 0 && <Typography.Text type="warning" style={{ fontSize: 12, marginLeft: 8 }}>不含 {missing.join('、')}</Typography.Text>}
                </Table.Summary.Cell>
                {labels.map((b, i) => <Table.Summary.Cell key={b} index={i + 3} align="right"><b>{amt(totals[b])}</b></Table.Summary.Cell>)}
                <Table.Summary.Cell index={n + 3} align="right">-</Table.Summary.Cell>
                <Table.Summary.Cell index={n + 4} align="right"><b>{amt(totals.total)}</b></Table.Summary.Cell>
              </Table.Summary.Row>
            </>
          ) : null
        }
      />
    </Card>
  );
}

function AgingPanel({ version }: { version: number }) {
  const [asOf, setAsOf] = useState<Dayjs>(dayjs());
  const [basis, setBasis] = useState<'closing' | 'booking'>('closing');
  const [buckets, setBuckets] = useState('30,60,90,180');
  const [data, setData] = useState<Rec>({ AR: [], AP: [], totals: {}, buckets: [] });
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    get('/finance/summary', { as_of: asOf.format('YYYY-MM-DD'), basis, buckets, detail: 1 })
      .then(setData)
      .finally(() => setLoading(false));
  }, [asOf, basis, buckets]);
  useEffect(() => load(), [load, version]);
  const base: string = data.base_currency || 'CNY';
  const labels: string[] = data.buckets || [];
  const flat = (kind: Kind) => [
    ...((data[kind] || []) as Rec[]).map((r) => ({ ...r, kind: TEXT[kind].name, line: '明细' })),
    ...((data.subtotals?.[kind] || []) as Rec[]).map((s) => ({ ...s, kind: TEXT[kind].name, partner: `${s.currency} 小计`, line: '币别小计' })),
    { ...(data.totals?.[kind] || {}), kind: TEXT[kind].name, partner: `合计（折合 ${base}）`, currency: base, total_base: data.totals?.[kind]?.total, line: '合计' },
  ];
  const exportCols: ExportColumn[] = [
    { title: '类型', key: 'kind' }, { title: '行类型', key: 'line' }, { title: '往来单位编码', key: 'partner_code' }, { title: '往来单位', key: 'partner', width: 30 },
    { title: '币别', key: 'currency' }, ...labels.map((b) => ({ title: b, key: b, type: 'money' as const })), { title: '合计（原币）', key: 'total', type: 'money' },
    { title: `折合 ${base}`, key: 'total_base', type: 'money' },
  ];
  const docRows = (['AR', 'AP'] as Kind[]).flatMap((k) =>
    ((data[k] || []) as Rec[]).flatMap((r) => (r.docs || []).map((d: Rec) => ({ ...d, kind: TEXT[k].name, partner: r.partner, partner_code: r.partner_code, currency: r.currency }))),
  );
  const title = `账龄分析（截止 ${asOf.format('YYYY-MM-DD')}，${basis === 'booking' ? '记账汇率' : '期末汇率'}）`;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <span>截止日</span>
        <DatePicker value={asOf} allowClear={false} onChange={(v) => v && setAsOf(v)} />
        <Segmented
          value={basis}
          onChange={(v) => setBasis(v as 'closing' | 'booking')}
          options={[{ value: 'closing', label: '按期末汇率折算' }, { value: 'booking', label: '按记账汇率折算' }]}
        />
        <Select style={{ width: 280 }} value={buckets} options={BUCKET_PRESETS} onChange={setBuckets} />
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
        <ExportButton rows={[...flat('AR'), ...flat('AP')]} columns={exportCols} filename={`账龄汇总_${asOf.format('YYYYMMDD')}`} title={title} text="导出汇总" />
        <ExportButton
          rows={docRows}
          filename={`账龄明细_${asOf.format('YYYYMMDD')}`}
          title={title}
          text="导出明细"
          columns={[
            { title: '类型', key: 'kind' }, { title: '往来单位编码', key: 'partner_code' }, { title: '往来单位', key: 'partner', width: 30 }, { title: '单号', key: 'no' },
            { title: '来源单据', key: 'ref_no' }, { title: '单据日期', key: 'doc_date', type: 'date' }, { title: '到期日', key: 'due_date', type: 'date' },
            { title: '逾期天数', key: 'overdue_days', type: 'number' }, { title: '区间', key: 'bucket' }, { title: '币别', key: 'currency' },
            { title: '单据金额', key: 'amount', type: 'money' }, { title: '截止日余额', key: 'balance', type: 'money' }, { title: '折算汇率', key: 'rate', type: 'number' },
            { title: `折合 ${base}`, key: 'base_balance', type: 'money' },
          ]}
        />
      </Space>
      <Typography.Text type="secondary">
        按到期日计算截止日的逾期天数，统计截止日的未结余额（截止日之后的收付款不计入）。每行为往来单位 + 币别的原币金额；
        {basis === 'booking' ? '本位币按各单据入账时的记账汇率折算（与总账应收应付科目余额一致）。' : `本位币按截止日适用汇率折算（期末汇率，${data.rate_date ?? ''}）。`}
        点行首“+”展开明细单据。
      </Typography.Text>
      <AgingTable kind="AR" data={data} />
      <AgingTable kind="AP" data={data} />
    </Space>
  );
}

// ======================= 月结导出（金蝶凭证） =======================
const VOUCHER_COLS: ExportColumn[] = [
  { title: '日期', key: 'date', type: 'date' },
  { title: '会计年度', key: 'year', type: 'number' },
  { title: '会计期间', key: 'period', type: 'number' },
  { title: '凭证字', key: 'word' },
  { title: '凭证号', key: 'voucher_no', type: 'number' },
  { title: '分录号', key: 'entry_no', type: 'number' },
  { title: '摘要', key: 'summary', width: 50 },
  { title: '科目代码', key: 'account_code' },
  { title: '科目名称', key: 'account_name', width: 20 },
  { title: '核算维度类型', key: 'aux_type' },
  { title: '往来单位编码', key: 'partner_code' },
  { title: '往来单位名称', key: 'partner_name', width: 30 },
  { title: '币别', key: 'currency' },
  { title: '汇率', key: 'rate', type: 'number' },
  { title: '原币金额', key: 'amount_fc', type: 'money' },
  { title: '借方金额', key: 'debit', type: 'money' },
  { title: '贷方金额', key: 'credit', type: 'money' },
  { title: '结算方式', key: 'method' },
  { title: '结算号', key: 'reference' },
  { title: '业务单号', key: 'biz_no' },
  { title: '制单人', key: 'maker' },
];

function MonthEnd() {
  const [month, setMonth] = useState<Dayjs>(() => (dayjs().date() <= 5 ? dayjs().subtract(1, 'month') : dayjs()));
  const period = month.format('YYYY-MM');
  const [v, setV] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const preview = useCallback(() => {
    setLoading(true);
    get('/finance/voucher', { period })
      .then(setV)
      .finally(() => setLoading(false));
  }, [period]);
  useEffect(() => preview(), [preview]);
  const balanced = v && v.debit_total === v.credit_total;
  const cols: TableColumnsType<Rec> = [
    { title: '日期', dataIndex: 'date', width: 100 },
    { title: '凭证号', dataIndex: 'voucher_no', width: 70, render: (n, r) => `${r.word}-${n}` },
    { title: '摘要', dataIndex: 'summary', ellipsis: true, width: 280 },
    { title: '科目', key: 'acct', render: (_, r) => `${r.account_code} ${r.account_name}` },
    { title: '往来单位', dataIndex: 'partner_name', ellipsis: true, width: 160, render: (x) => x || '-' },
    { title: '币别', dataIndex: 'currency', width: 60 },
    { title: '汇率', dataIndex: 'rate', align: 'right', width: 80, render: (x) => rateText(x) },
    { title: '原币', dataIndex: 'amount_fc', align: 'right', render: (x) => amt(x) },
    { title: '借方', dataIndex: 'debit', align: 'right', render: (x) => amt(x) },
    { title: '贷方', dataIndex: 'credit', align: 'right', render: (x) => amt(x) },
  ];
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="月底给金蝶：① 选会计期间 → ② 点“导出金蝶凭证” → ③ 保存后在金蝶【总账 → 凭证引入】中选择该 Excel。应收应付明细、收付款流水也可在此一键导出。"
      />
      <Space wrap>
        <span>会计期间</span>
        <DatePicker picker="month" value={month} allowClear={false} onChange={(m) => m && setMonth(m)} />
        <ExportButton url="/finance/voucher" params={{ period }} filename={`金蝶凭证_${period}`} columns={VOUCHER_COLS} text="导出金蝶凭证" />
        <ExportButton url="/finance/docs" params={{ doc_type: 'AR', period }} filename={`应收明细_${period}`} columns={docExportColumns('AR')} text="应收明细" />
        <ExportButton url="/finance/docs" params={{ doc_type: 'AP', period }} filename={`应付明细_${period}`} columns={docExportColumns('AP')} text="应付明细" />
        <ExportButton url="/finance/payments" params={{ period }} filename={`收付款流水_${period}`} columns={PAY_EXPORT} text="收付款流水" />
        <Button icon={<ReloadOutlined />} onClick={preview} loading={loading}>刷新预览</Button>
      </Space>
      {v && (
        <>
          <Row gutter={16}>
            <Col xs={12} md={6}><Card size="small"><Statistic title="凭证张数" value={v.vouchers} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="分录行数" value={v.total} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="借方合计" value={v.debit_total} precision={2} /></Card></Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="贷方合计" value={v.credit_total} precision={2} suffix={balanced ? <Tag color="green">借贷平衡</Tag> : <Tag color="red">不平衡</Tag>} />
              </Card>
            </Col>
          </Row>
          {(v.warnings as string[]).length > 0 && <Alert type="warning" showIcon message="以下单据缺汇率，本位币为空" description={(v.warnings as string[]).map((w) => <div key={w}>{w}</div>)} />}
          <Card size="small" title={`凭证预览（${period}，共 ${v.total} 行）`}>
            <Table rowKey={(r) => `${r.voucher_no}-${r.entry_no}`} size="small" columns={cols} dataSource={v.items} pagination={{ pageSize: 20, showTotal: (n) => `共 ${n} 行` }} scroll={{ x: 'max-content' }} />
          </Card>
          <Card size="small" title="科目映射（引入前请与贵司金蝶科目表核对）">
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              应收：借 应收账款 / 贷 主营业务收入；应付：借 原材料 / 贷 应付账款；收款：借 银行存款、手续费 / 贷 应收账款（按记账汇率）、预收账款，差额记汇兑损益（收益贷方、损失借方）；付款反之。
              应收/应付已按客户/供应商税率拆分增值税（销项 2221.01.05 / 进项 2221.01.01；未设税率时人民币按 13%、外币出口客户按 0%，可在客户/供应商主数据维护）；制单人为导出人；本期作废的以前期间收付款生成红字冲销凭证。科目可由管理员用环境变量 KINGDEE_ACCOUNTS 调整。
            </Typography.Paragraph>
            <Space wrap>
              {(v.accounts as Rec[]).map((a) => <Tag key={a.key}>{a.code} {a.name}{a.aux ? `（核算：${a.aux}）` : ''}</Tag>)}
            </Space>
          </Card>
        </>
      )}
    </Space>
  );
}

export default function Finance() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'AR';
  const { base, rateOf } = useRates();
  const [summary, setSummary] = useState<Rec>({ AR: [], AP: [], totals: {} });
  const [version, setVersion] = useState(0);
  const totals: Rec = summary.totals || BLANK;
  const loadSummary = useCallback(() => {
    get('/finance/summary').then(setSummary);
    setVersion((x) => x + 1);
  }, []);
  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  return (
    <>
      <PageHeader title="应收应付" sub="发货自动生成应收、采购入库自动生成应付；财务登记收付款（可合并、可作废），系统自动核销余额、算汇兑差异与账龄，月底一键导出金蝶凭证。" />
      <Card>
        <Tabs
          activeKey={tab}
          onChange={(k) => setSp({ tab: k }, { replace: true })}
          destroyOnHidden
          items={[
            { key: 'AR', label: '应收账款', children: <FinDocs kind="AR" totals={totals.AR || BLANK} base={base} rateOf={rateOf} onChanged={loadSummary} /> },
            { key: 'AP', label: '应付账款', children: <FinDocs kind="AP" totals={totals.AP || BLANK} base={base} rateOf={rateOf} onChanged={loadSummary} /> },
            { key: 'PAY', label: '收付款流水', children: <PaymentsLedger base={base} onChanged={loadSummary} /> },
            { key: 'AGING', label: '账龄分析', children: <AgingPanel version={version} /> },
            { key: 'EXPORT', label: '月结导出（金蝶）', children: <MonthEnd /> },
          ]}
        />
      </Card>
    </>
  );
}
