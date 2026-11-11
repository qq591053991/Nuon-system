import {
  AutoComplete, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Statistic, Table, Tabs, Typography, message,
  type TableColumnsType,
} from 'antd';
import { DollarOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtMoney, toDate } from '../../utils/format';
import { DueDate, isPast } from './shared';

type DocType = 'AR' | 'AP';
const TEXT = {
  AR: { name: '应收', partner: '客户', paid: '已收', pay: '登记收款', payDone: '收款已登记', amountLabel: '收款金额', dateLabel: '收款日期' },
  AP: { name: '应付', partner: '供应商', paid: '已付', pay: '登记付款', payDone: '付款已登记', amountLabel: '付款金额', dateLabel: '付款日期' },
};
const METHODS = ['银行转账', '电汇(T/T)', '承兑汇票', '信用证(L/C)', '支票', '现金', '其他'].map((v) => ({ value: v }));
const BUCKETS = ['未到期', '1-30天', '31-90天', '90天以上'] as const;
const amt = (v?: number) => (v ? Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span style={{ color: '#bfbfbf' }}>-</span>);

/** 来源单据链接（发货单 / 入库单） */
function RefLink({ doc }: { doc: Rec }) {
  if (!doc.ref_no) return <span>-</span>;
  const base = doc.ref_type === 'SHIPMENT' ? '/wms/shipments' : doc.ref_type === 'RECEIPT' ? '/wms/receipts' : null;
  return base ? <Link to={`${base}?q=${encodeURIComponent(doc.ref_no)}`} className="mono">{doc.ref_no}</Link> : <span className="mono">{doc.ref_no}</span>;
}

function PaymentModal({ doc, onClose, onDone }: { doc: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const t = TEXT[(doc?.doc_type as DocType) || 'AR'];
  return (
    <Modal
      open={!!doc}
      title={`${t.pay} - ${doc?.no ?? ''}`}
      okText="确认登记"
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      onOk={async () => {
        const v = await form.validateFields().catch(() => null);
        if (!v) return;
        setSaving(true);
        try {
          await post(`/finance/docs/${doc!.id}/payments`, { ...v, pay_date: toDate(v.pay_date) });
          message.success(t.payDone);
          onDone();
        } finally {
          setSaving(false);
        }
      }}
    >
      {doc && (
        <>
          <Typography.Paragraph type="secondary">
            {t.partner}：{doc.partner_name} · 单据金额 {fmtMoney(doc.amount, doc.currency)} · 未结余额 <b>{fmtMoney(doc.balance, doc.currency)}</b>
          </Typography.Paragraph>
          <Form form={form} layout="vertical" preserve={false} initialValues={{ amount: doc.balance, pay_date: dayjs(), method: '银行转账' }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="amount" label={`${t.amountLabel}（${doc.currency}）`} rules={[{ required: true, message: '请填写金额' }]}>
                  <InputNumber style={{ width: '100%' }} min={0.01} max={doc.balance} precision={2} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="pay_date" label={t.dateLabel} rules={[{ required: true, message: '请选择日期' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="method" label="结算方式"><AutoComplete options={METHODS} /></Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="reference" label="流水号/票据号"><Input /></Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="remark" label="备注"><Input /></Form.Item>
              </Col>
            </Row>
          </Form>
        </>
      )}
    </Modal>
  );
}

function FinDocs({ docType, summary, onChanged }: { docType: DocType; summary: Rec[]; onChanged: () => void }) {
  const { can } = useAuth();
  const t = TEXT[docType];
  const { rows, loading, setQuery, reload, pagination } = usePaged('/finance/docs', { doc_type: docType });
  const [paying, setPaying] = useState<Rec | null>(null);
  const total = summary.reduce((s, r) => s + (r.total || 0), 0);
  const overdue = summary.reduce((s, r) => s + (r['1-30天'] || 0) + (r['31-90天'] || 0) + (r['90天以上'] || 0), 0);

  const columns: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', fixed: 'left', render: (v) => <span className="mono">{v}</span> },
    { title: t.partner, dataIndex: 'partner_name', ellipsis: true, width: 220 },
    { title: '来源单据', key: 'ref', render: (_, r) => <RefLink doc={r} /> },
    { title: '单据日期', dataIndex: 'doc_date', render: fmtDate },
    { title: '到期日', dataIndex: 'due_date', render: (v, r) => <DueDate value={v} overdue={r.status !== 'PAID' && isPast(v)} hint="已逾期未结清" /> },
    { title: '金额', dataIndex: 'amount', align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: t.paid, dataIndex: 'paid_amount', align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: '未结余额', dataIndex: 'balance', align: 'right', render: (v, r) => <b>{fmtMoney(v, r.currency)}</b> },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="fin_status" value={v} /> },
    { title: '摘要', dataIndex: 'remark', ellipsis: true, width: 200, render: (v) => v || '-' },
  ];
  if (can('finance')) {
    columns.push({
      title: '操作', key: 'op', fixed: 'right', width: 110,
      render: (_, r) => (r.status !== 'PAID' ? <Button size="small" type="link" icon={<DollarOutlined />} onClick={() => setPaying(r)}>{t.pay}</Button> : null),
    });
  }

  const payCols = (currency: string): TableColumnsType<Rec> => [
    { title: t.dateLabel, dataIndex: 'pay_date', render: fmtDate },
    { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => fmtMoney(v, currency) },
    { title: '结算方式', dataIndex: 'method', render: (v) => v || '-' },
    { title: '流水号/票据号', dataIndex: 'reference', render: (v) => v || '-' },
    { title: '备注', dataIndex: 'remark', render: (v) => v || '-' },
    { title: '登记人', dataIndex: 'created_by', render: (v, p) => `${v ?? '-'} · ${fmtDateTime(p.created_at)}` },
  ];

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title={`${t.name}余额合计`} value={total} precision={2} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="其中已逾期" value={overdue} precision={2} valueStyle={{ color: overdue > 0 ? '#cf1322' : undefined }} /></Card></Col>
        <Col xs={24} md={12}>
          <Typography.Text type="secondary" style={{ display: 'block', paddingTop: 8 }}>
            {docType === 'AR' ? '发货过账后系统自动生成应收单，到期日 = 发货日 + 客户账期。' : '采购收货后系统自动生成应付单，到期日 = 收货日 + 供应商账期。'}
            合计金额按原币直接相加，仅供参考。
          </Typography.Text>
        </Col>
      </Row>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder="单号 / 来源单号" style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
        <Select
          allowClear
          placeholder="结算状态"
          style={{ width: 160 }}
          options={[{ value: 'OPEN,PARTIAL', label: '未结清' }, ...dictOptions('fin_status')]}
          onChange={(v) => setQuery({ status: v })}
        />
        <Button icon={<ReloadOutlined />} onClick={reload} />
      </Space>
      <Table
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        scroll={{ x: 'max-content' }}
        expandable={{
          rowExpandable: (r) => !!r.payments?.length,
          expandedRowRender: (r) => <Table rowKey="id" size="small" columns={payCols(r.currency)} dataSource={r.payments} pagination={false} />,
        }}
      />
      <PaymentModal
        doc={paying}
        onClose={() => setPaying(null)}
        onDone={() => {
          setPaying(null);
          reload();
          onChanged();
        }}
      />
    </>
  );
}

function AgingTable({ title, partner, rows }: { title: string; partner: string; rows: Rec[] }) {
  const columns: TableColumnsType<Rec> = [
    { title: partner, dataIndex: 'partner', ellipsis: true, width: 260, render: (v) => v || '-' },
    ...BUCKETS.map((b) => ({
      title: b,
      dataIndex: b,
      align: 'right' as const,
      render: (v: number) => (b !== '未到期' && v > 0 ? <span style={{ color: b === '1-30天' ? '#d48806' : '#cf1322' }}>{amt(v)}</span> : amt(v)),
    })),
    { title: '合计', dataIndex: 'total', align: 'right', render: (v) => <b>{amt(v)}</b> },
  ];
  return (
    <Card size="small" title={title}>
      <Table
        rowKey={(r) => r.partner ?? '-'}
        size="middle"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        summary={(data) =>
          data.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}><b>合计</b></Table.Summary.Cell>
              {BUCKETS.map((b, i) => (
                <Table.Summary.Cell key={b} index={i + 1} align="right"><b>{amt(data.reduce((s, r) => s + (r[b] || 0), 0))}</b></Table.Summary.Cell>
              ))}
              <Table.Summary.Cell index={5} align="right"><b>{amt(data.reduce((s, r) => s + (r.total || 0), 0))}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </Card>
  );
}

export default function Finance() {
  const [summary, setSummary] = useState<Rec>({ AR: [], AP: [] });
  const loadSummary = useCallback(() => {
    get('/finance/summary').then(setSummary);
  }, []);
  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  return (
    <>
      <PageHeader title="应收应付" sub="发货自动生成应收、采购入库自动生成应付；财务只需登记收付款，系统自动核销余额与账龄。" />
      <Card>
        <Tabs
          items={[
            { key: 'AR', label: '应收账款（AR）', children: <FinDocs docType="AR" summary={summary.AR || []} onChanged={loadSummary} /> },
            { key: 'AP', label: '应付账款（AP）', children: <FinDocs docType="AP" summary={summary.AP || []} onChanged={loadSummary} /> },
            {
              key: 'aging',
              label: '账龄分析',
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text type="secondary">按到期日计算逾期天数，统计未结清余额（原币金额直接汇总）。</Typography.Text>
                    <Button icon={<ReloadOutlined />} onClick={loadSummary}>刷新</Button>
                  </Space>
                  <AgingTable title="应收账龄（客户）" partner="客户" rows={summary.AR || []} />
                  <AgingTable title="应付账龄（供应商）" partner="供应商" rows={summary.AP || []} />
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
