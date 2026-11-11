import { Alert, Button, Card, Descriptions, Input, InputNumber, Popover, Segmented, Select, Space, Table, Typography } from 'antd';
import { CalculatorOutlined, ReloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';

const AQL_VALUES = [0.065, 0.1, 0.15, 0.25, 0.4, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5];

const STATUS_TABS = [
  { value: 'PENDING', label: '待检验' },
  { value: '', label: '全部' },
  { value: 'PASSED', label: '合格' },
  { value: 'REJECTED', label: '不合格' },
  { value: 'CONCESSION', label: '让步接收' },
];

/** AQL 抽样计算器（GB/T 2828.1 一般检验水平 II，正常检验一次抽样） */
function AqlCalculator() {
  const [lot, setLot] = useState<number | null>(1000);
  const [aql, setAql] = useState(1.0);
  const [plan, setPlan] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const calc = async () => {
    if (!lot) return;
    setLoading(true);
    try {
      setPlan(await get('/quality/aql', { lot_qty: lot, aql }));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div style={{ width: 320 }}>
      <Space wrap>
        <InputNumber min={1} value={lot} onChange={setLot} placeholder="批量" prefix="批量" style={{ width: 170 }} onPressEnter={calc} />
        <Select value={aql} onChange={setAql} style={{ width: 120 }} options={AQL_VALUES.map((v) => ({ value: v, label: `AQL ${v}` }))} />
        <Button type="primary" loading={loading} onClick={calc}>计算</Button>
      </Space>
      {plan && (
        <Descriptions size="small" column={2} bordered style={{ marginTop: 12 }} items={[
          { key: 'l', label: '样本量字码', children: <b>{plan.code_letter}</b> },
          { key: 'n', label: '样本量 n', children: <b>{plan.sample_size}</b> },
          { key: 'ac', label: '接收数 Ac', children: <b style={{ color: '#389e0d' }}>{plan.accept_num}</b> },
          { key: 're', label: '拒收数 Re', children: <b style={{ color: '#cf1322' }}>{plan.reject_num}</b> },
        ]} />
      )}
      {plan && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          {plan.full_inspection ? '样本量 ≥ 批量，需全数检验。' : `随机抽取 ${plan.sample_size} 件：不良数 ≤ ${plan.accept_num} 接收，≥ ${plan.reject_num} 拒收。`}
          {plan.plan_letter !== plan.code_letter && `（按箭头规则采用字码 ${plan.plan_letter} 的方案）`}
        </Typography.Paragraph>
      )}
    </div>
  );
}

export default function Inspections() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const q0 = sp.get('q') || '';
  // 带 ?q= 跳转（如 DHR 中点击检验单号）时显示全部状态
  const [status, setStatus] = useState(q0 ? '' : 'PENDING');
  const { rows, loading, setQuery, reload, pagination } = usePaged('/inspections', q0 ? { q: q0 } : { status: 'PENDING' });

  const columns: any[] = [
    { title: '检验单号', dataIndex: 'no', fixed: 'left', render: (v: string, r: Rec) => <Link to={`/quality/inspections/${r.id}`}>{v}</Link> },
    { title: '类型', dataIndex: 'insp_type', render: (v: string) => <StatusTag dict="insp_type" value={v} /> },
    {
      title: '物料', dataIndex: 'material_name',
      render: (v: string, r: Rec) => (
        <div>
          <div>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}{r.material_spec ? ` | ${r.material_spec}` : ''}</Typography.Text>
        </div>
      ),
    },
    {
      title: '批号', dataIndex: 'lot_no',
      render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> : '-'),
    },
    { title: '供应商', dataIndex: 'supplier_name', render: (v: string, r: Rec) => v || (r.owner_customer_id ? '客供料' : '-') },
    { title: '批量', dataIndex: 'lot_qty', align: 'right', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom ?? ''}` },
    {
      title: '抽样（n / Ac / Re）', key: 'plan',
      render: (_: any, r: Rec) => (
        <span>
          <b>{r.sample_size ?? '-'}</b> / <span style={{ color: '#389e0d' }}>{r.accept_num ?? '-'}</span> / <span style={{ color: '#cf1322' }}>{r.reject_num ?? '-'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.aql != null ? `  AQL ${r.aql}` : ''}</Typography.Text>
        </span>
      ),
    },
    { title: '不良数', dataIndex: 'defect_qty', align: 'right', render: (v: number, r: Rec) => (r.status === 'PENDING' ? '-' : v) },
    { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag dict="insp_status" value={v} /> },
    { title: '检验员', dataIndex: 'inspector', render: (v: string) => v || '-' },
    { title: '检验时间', dataIndex: 'inspected_at', render: (v: string) => fmtDateTime(v) },
    { title: '到货时间', dataIndex: 'created_at', render: (v: string) => fmtDateTime(v) },
    {
      title: '操作', key: 'op', fixed: 'right',
      render: (_: any, r: Rec) =>
        r.status === 'PENDING' && can('qc') ? (
          <Button size="small" type="primary" onClick={() => nav(`/quality/inspections/${r.id}`)}>去检验</Button>
        ) : (
          <Button size="small" onClick={() => nav(`/quality/inspections/${r.id}`)}>查看</Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="来料检验 IQC"
        sub="收货后物料自动进入“待检”状态并生成检验单（系统按 GB/T 2828.1 自动计算抽样方案）；判定合格后才能被生产领用。"
        extra={
          <Popover trigger="click" placement="bottomRight" title="AQL 抽样计算器（一般检验水平 II）" content={<AqlCalculator />}>
            <Button icon={<CalculatorOutlined />}>AQL 计算器</Button>
          </Popover>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented
            value={status}
            options={STATUS_TABS}
            onChange={(v) => {
              setStatus(v as string);
              setQuery({ status: v || undefined });
            }}
          />
          <Input.Search allowClear placeholder="检验单号 / 批号 / 物料" defaultValue={q0} style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="检验类型" style={{ width: 130 }} options={dictOptions('insp_type')} onChange={(v) => setQuery({ insp_type: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        {status === 'PENDING' && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="待检物料不能被领用。检验员按抽样方案抽样检验并电子签名判定后，库存自动转为“合格”或“不合格”（不合格自动开具 NCR）。" />
        )}
        <Table<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
