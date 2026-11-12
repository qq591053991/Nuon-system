import {
  Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Tooltip, Typography, message,
  type TableColumnsType,
} from 'antd';
import { DeleteOutlined, EditOutlined, LockOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { fmtDate, fmtDateTime } from '../../utils/format';

const CURRENCIES = ['USD', 'EUR', 'HKD', 'JPY', 'GBP', 'KRW', 'AUD', 'CAD', 'SGD'].map((v) => ({ value: v, label: v }));
/** 与上一期偏差超过该比例需确认（与后端一致） */
const LIMIT = 0.1;
const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/** 汇率维护：1 外币 = 汇率 × 本位币；单据按“生效日期 ≤ 单据日期”的最近一条汇率记账 */
export default function ExchangeRates() {
  const { can } = useAuth();
  const editable = can('finance', 'master');
  const [info, setInfo] = useState<Rec | null>(null);
  const loadInfo = useCallback(() => {
    get('/finance/currencies', undefined, true).then(setInfo).catch(() => undefined);
  }, []);
  useEffect(() => loadInfo(), [loadInfo]);
  const base: string = info?.base_currency || 'CNY';
  const rates: Rec[] = info?.rates || [];
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/exchange-rates', {});
  const [editing, setEditing] = useState<Rec | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const locked = !!editing?.referenced;

  const refresh = () => {
    reload();
    loadInfo();
  };

  const open = (r: Rec | null) => {
    setEditing(r ?? {});
    form.setFieldsValue(r ? { ...r, effective_date: dayjs(r.effective_date) } : { currency: 'USD', effective_date: dayjs(), rate: undefined, remark: undefined });
  };

  /** 上一期汇率（同币别、生效日期更早的最近一条） */
  const previous = async (currency: string, date: string, selfId?: number): Promise<Rec | null> => {
    const d = await get('/exchange-rates', { currency, page_size: 100 }, true);
    return ((d.items as Rec[]) || []).filter((x) => x.id !== selfId && x.effective_date < date).sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))[0] ?? null;
  };

  const save = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const body: Rec = { ...v, effective_date: v.effective_date.format('YYYY-MM-DD'), currency: String(v.currency).toUpperCase() };
    const isNew = !editing?.id;
    if (!locked) {
      const prev = await previous(body.currency, body.effective_date, editing?.id);
      const dev = prev ? Number(body.rate) / Number(prev.rate) - 1 : 0;
      if (prev && Math.abs(dev) > LIMIT) {
        const ok = await new Promise<boolean>((resolve) =>
          Modal.confirm({
            title: '汇率与上一期偏差较大，确认保存？',
            content: (
              <div>
                {body.currency} 新汇率 <b>{body.rate}</b> 与上一期 <b>{Number(prev.rate)}</b>（{fmtDate(prev.effective_date)} 起）相差 <b style={{ color: '#cf1322' }}>{pct(dev)}</b>，超过
                {LIMIT * 100}%。请核对是否多输/少输了小数位。
              </div>
            ),
            okText: '确认无误，保存',
            cancelText: '返回修改',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          }),
        );
        if (!ok) return;
        body.confirm_deviation = true;
      }
    } else {
      // 已被引用：只能改备注
      for (const k of ['currency', 'rate', 'effective_date']) delete body[k];
    }
    setSaving(true);
    try {
      const saved = isNew ? await post('/exchange-rates', body) : await put(`/exchange-rates/${editing!.id}`, body);
      message.success(`${saved.currency} ${saved.rate}（${fmtDate(saved.effective_date)} 起）已保存`);
      setEditing(null);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: Rec) => {
    await del(`/exchange-rates/${r.id}`);
    message.success('已删除');
    refresh();
  };

  const columns: TableColumnsType<Rec> = [
    { title: '币别', dataIndex: 'currency', sorter: true, width: 80, render: (v) => <Tag>{v}</Tag> },
    { title: `汇率（1 外币 = ? ${base}）`, dataIndex: 'rate', sorter: true, render: (v, r) => <span className="mono">1 {r.currency} = {Number(v).toFixed(6)} {base}</span> },
    { title: '生效日期', dataIndex: 'effective_date', sorter: true, render: fmtDate },
    {
      title: '较上一期', dataIndex: 'change_pct', align: 'right',
      render: (v, r) =>
        v === null || v === undefined ? (
          '-'
        ) : (
          <Tooltip title={`上一期 ${r.prev_rate}（${fmtDate(r.prev_date)} 起）`}>
            <span style={{ color: Math.abs(v) > LIMIT ? '#cf1322' : undefined, fontWeight: Math.abs(v) > LIMIT ? 600 : undefined }}>{pct(v)}</span>
          </Tooltip>
        ),
    },
    {
      title: '引用情况', key: 'ref',
      render: (_, r) =>
        r.referenced ? (
          <Tooltip title="该汇率适用期内已有应收应付单据/收付款按它记账，不能再改汇率或删除（可改备注）；如有误请新增一条新汇率">
            <Tag icon={<LockOutlined />} color="purple">{r.ref_docs} 张单据 · {r.ref_payments} 笔收付款</Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">未引用</Typography.Text>
        ),
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, width: 220, render: (v) => v || '-' },
    { title: '维护人', dataIndex: 'created_by', render: (v, r) => <Tooltip title={fmtDateTime(r.updated_at)}>{v || '-'}</Tooltip> },
  ];
  if (editable) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 150,
      render: (_, r) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => open(r)}>{r.referenced ? '改备注' : '编辑'}</Button>
          {r.referenced ? (
            <Tooltip title="已被引用，不能删除">
              <Button type="link" size="small" danger disabled icon={<DeleteOutlined />}>删除</Button>
            </Tooltip>
          ) : (
            <Popconfirm title={`删除 ${r.currency} ${fmtDate(r.effective_date)} 的汇率？`} onConfirm={() => remove(r)}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    });
  }

  return (
    <>
      <PageHeader
        title="汇率"
        sub="同一币别按生效日期维护多条汇率（如每月初中间价）。应收应付按单据日期适用的汇率记账；已被单据引用的汇率不能修改或删除。"
        extra={
          <>
            <ExportButton
              url="/exchange-rates"
              params={{ ...query, sort: undefined, order: undefined }}
              filename="汇率"
              columns={[
                { title: '币别', key: 'currency' }, { title: '汇率', key: 'rate', type: 'number' }, { title: '生效日期', key: 'effective_date', type: 'date' },
                { title: '较上一期', key: 'change_pct', type: 'number' }, { title: '引用单据数', key: 'ref_docs', type: 'number' }, { title: '备注', key: 'remark', width: 30 },
                { title: '维护人', key: 'created_by' },
              ]}
            />
            {editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => open(null)}>新增汇率</Button>}
          </>
        }
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`本位币：${base}。外币单据按“生效日期 ≤ 单据日期”的最近一条汇率记账；收付款按实际汇率登记，差额自动计为汇兑差异；报表可选按记账汇率或期末汇率折算。`}
        description={
          rates.length ? (
            <Space wrap size={[8, 4]}>
              <Typography.Text type="secondary">今日适用汇率：</Typography.Text>
              {rates.map((r) => (
                <Tag key={r.currency} color="blue">1 {r.currency} = {Number(r.rate).toFixed(4)} {base}（{fmtDate(r.effective_date)} 起）</Tag>
              ))}
            </Space>
          ) : (
            <Typography.Text type="warning">尚未维护外币汇率</Typography.Text>
          )
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select allowClear placeholder="币别" style={{ width: 120 }} options={CURRENCIES} onChange={(v) => setQuery({ currency: v })} />
          <Input.Search allowClear placeholder="币别 / 备注" style={{ width: 220 }} onSearch={(q) => setQuery({ q })} />
          <Button icon={<ReloadOutlined />} onClick={refresh} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal
        open={!!editing}
        title={editing?.id ? (locked ? '修改备注（汇率已被引用，不能改汇率）' : '编辑汇率') : '新增汇率'}
        okText="保存"
        onCancel={() => setEditing(null)}
        onOk={save}
        confirmLoading={saving}
        destroyOnHidden
        forceRender
        maskClosable={false}
        width={560}
      >
        {locked && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`该汇率已被 ${editing?.ref_docs} 张单据、${editing?.ref_payments} 笔收付款引用，只能修改备注。如汇率有误，请新增一条正确汇率（新的生效日期）。`}
          />
        )}
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="currency" label="币别" rules={[{ required: true, message: '请选择币别' }]}>
                <Select options={CURRENCIES} showSearch disabled={locked} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="effective_date" label="生效日期" rules={[{ required: true, message: '请选择生效日期' }]}>
                <DatePicker style={{ width: '100%' }} disabled={locked} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="rate" label={`汇率（1 外币 = ? ${base}）`} rules={[{ required: true, message: '请填写汇率' }]} extra="保存时与上一期比较，偏差超过 10% 需再次确认">
                <InputNumber style={{ width: '100%' }} min={0.000001} precision={6} disabled={locked} autoFocus />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label="备注"><Input placeholder="如：人行中间价 / 月初记账汇率" /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
