import { Alert, Button, Card, Descriptions, Input, InputNumber, Popover, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { CalculatorOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { SupplierSelect } from '../../components/RemoteSelect';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { DateRangeFilter, useUrlFilters } from './qshared';

const AQL_VALUES = [0.065, 0.1, 0.15, 0.25, 0.4, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5];
/** GB/T 2828.1 检验水平：只决定样本量大小（判别力），与“正常/加严/放宽”严格度无关 */
const LEVELS = [
  { value: 'I', label: '一般 I（样本量少）' }, { value: 'II', label: '一般 II（默认，标准）' }, { value: 'III', label: '一般 III（样本量多）' },
  { value: 'S-1', label: '特殊 S-1（样本量很小）' }, { value: 'S-2', label: '特殊 S-2' }, { value: 'S-3', label: '特殊 S-3' }, { value: 'S-4', label: '特殊 S-4' },
];
/** 严格度（转移规则）：本系统按正常检验抽样；加严/放宽由 QA 按 GB/T 2828.1 第 9 章转移规则判定后另行执行 */
const SEVERITIES = [
  { value: 'NORMAL', label: '正常检验' },
  { value: 'TIGHTENED', label: '加严检验（按表 II-B，另行执行）', disabled: true },
  { value: 'REDUCED', label: '放宽检验（按表 II-C，另行执行）', disabled: true },
];

const STATUS_TABS = [
  { value: 'PENDING', label: '待检验' },
  { value: '', label: '全部' },
  { value: 'PASSED', label: '合格' },
  { value: 'REJECTED', label: '不合格' },
  { value: 'CONCESSION', label: '让步接收' },
];

/** AQL 抽样计算器（GB/T 2828.1 正常检验一次抽样）：改批量、AQL 或检验水平即自动重算 */
export function AqlCalculator({ initialLot = 1000, initialAql = 1.0 }: { initialLot?: number; initialAql?: number }) {
  const [lot, setLot] = useState<number | null>(initialLot);
  const [aql, setAql] = useState(initialAql);
  const [level, setLevel] = useState('II');
  const [plan, setPlan] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!lot) {
      setPlan(null);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      get('/quality/aql', { lot_qty: lot, aql, level }, true)
        .then((p) => live && setPlan(p))
        .catch(() => live && setPlan(null))
        .finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lot, aql, level]);
  return (
    <div style={{ width: 420 }}>
      <Space wrap>
        <InputNumber min={1} value={lot} onChange={setLot} placeholder="批量" prefix="批量" style={{ width: 160 }} autoFocus />
        <Select value={aql} onChange={setAql} style={{ width: 110 }} options={AQL_VALUES.map((v) => ({ value: v, label: `AQL ${v}` }))} />
        <Tooltip title="检验水平只决定样本量大小（判别力）：I 样本量少、II 标准（默认）、III 样本量多；特殊水平用于破坏性或昂贵的检验">
          <Select value={level} onChange={setLevel} style={{ width: 190 }} options={LEVELS} popupMatchSelectWidth={false} />
        </Tooltip>
        <Tooltip title="严格度（正常 / 加严 / 放宽）由 GB/T 2828.1 第 9 章转移规则决定，与检验水平无关。本系统按正常检验计算；需加严或放宽时由 QA 判定后另行执行。">
          <Select value="NORMAL" style={{ width: 150 }} options={SEVERITIES} popupMatchSelectWidth={false} />
        </Tooltip>
      </Space>
      <Spin spinning={loading} size="small">
        {plan ? (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginTop: 12 }} items={[
              { key: 'l', label: '样本量字码', children: <b>{plan.code_letter}</b> },
              { key: 'n', label: '样本量 n', children: <b>{plan.sample_size}</b> },
              { key: 'ac', label: '接收数 Ac', children: <b style={{ color: '#389e0d' }}>{plan.accept_num}</b> },
              { key: 're', label: '拒收数 Re', children: <b style={{ color: '#cf1322' }}>{plan.reject_num}</b> },
            ]} />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              批量 {plan.lot_qty}、AQL {plan.aql}、检验水平 {plan.level}、正常检验：
              {plan.full_inspection ? '样本量 ≥ 批量，需全数检验。' : `随机抽取 ${plan.sample_size} 件，不良数 ≤ ${plan.accept_num} 接收，≥ ${plan.reject_num} 拒收。`}
              {plan.plan_letter !== plan.code_letter && `（按箭头规则采用字码 ${plan.plan_letter} 的方案）`}
            </Typography.Paragraph>
          </>
        ) : <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>输入批量即自动计算</Typography.Paragraph>}
      </Spin>
    </div>
  );
}

export default function Inspections() {
  const { can } = useAuth();
  const nav = useNavigate();
  const url = useUrlFilters(['status', 'type', 'insp_type', 'q', 'supplier_id', 'date_from', 'date_to'], { type: 'insp_type' });
  // 带 ?q= 跳转（如 DHR 中点击检验单号）时显示全部状态；带 ?status= 时按参数
  const initStatus = url.status ?? (url.q ? '' : 'PENDING');
  const [status, setStatus] = useState(initStatus);
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/inspections', { ...url, status: initStatus || undefined });

  const columns: any[] = [
    { title: '检验单号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title', render: (v: string, r: Rec) => <Link to={`/quality/inspections/${r.id}`}>{v}</Link> },
    { title: '状态', dataIndex: 'status', sorter: true, mobile: 'subtitle', render: (v: string) => <StatusTag dict="insp_status" value={v} /> },
    {
      title: '物料', dataIndex: 'material_name',
      render: (v: string, r: Rec) => (
        <div style={{ minWidth: 140 }}>
          <div>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}{r.material_spec ? ` | ${r.material_spec}` : ''}</Typography.Text>
        </div>
      ),
    },
    {
      title: '批号', dataIndex: 'lot_no', sorter: true,
      render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> : '-'),
    },
    { title: '供应商', dataIndex: 'supplier_name', render: (v: string, r: Rec) => v || (r.owner_customer_id ? '客供料' : '-') },
    { title: '批量', dataIndex: 'lot_qty', align: 'right', sorter: true, render: (v: number, r: Rec) => <span style={{ whiteSpace: 'nowrap' }}>{fmtQty(v)} {r.uom ?? ''}</span> },
    {
      title: <span style={{ whiteSpace: 'nowrap' }}>抽样 n / Ac / Re</span>, key: 'plan',
      render: (_: any, r: Rec) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <b>{r.sample_size ?? '-'}</b> / <span style={{ color: '#389e0d' }}>{r.accept_num ?? '-'}</span> / <span style={{ color: '#cf1322' }}>{r.reject_num ?? '-'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.aql != null ? ` · AQL ${r.aql}` : ''}</Typography.Text>
        </span>
      ),
    },
    { title: '不良数', dataIndex: 'defect_qty', align: 'right', sorter: true, render: (v: number, r: Rec) => (r.status === 'PENDING' ? '-' : <span style={{ color: v > 0 ? '#cf1322' : undefined }}>{v}</span>) },
    { title: '检验员', dataIndex: 'inspector', render: (v: string) => v || '-' },
    { title: '检验时间', dataIndex: 'inspected_at', sorter: true, render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(v)}</span> },
    { title: '到货时间', dataIndex: 'created_at', sorter: true, render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(v)}</span> },
    {
      title: '操作', key: '_op', fixed: 'right',
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
          <Space wrap>
            <ExportButton url="/inspections" params={query} filename="来料检验" columns={[
              { title: '检验单号', key: 'no' }, { title: '状态', value: (r) => dictLabel('insp_status', r.status) },
              { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '规格', key: 'material_spec' },
              { title: '批号', key: 'lot_no' }, { title: '供应商', value: (r) => r.supplier_name || (r.owner_customer_id ? '客供料' : '') },
              { title: '批量', key: 'lot_qty', type: 'number' }, { title: '单位', key: 'uom' }, { title: 'AQL', key: 'aql', type: 'number' },
              { title: '样本量', key: 'sample_size', type: 'number' }, { title: 'Ac', key: 'accept_num', type: 'number' }, { title: 'Re', key: 'reject_num', type: 'number' },
              { title: '不良数', value: (r) => (r.status === 'PENDING' ? null : r.defect_qty), type: 'number' },
              { title: '检验员', key: 'inspector' }, { title: '检验时间', key: 'inspected_at', type: 'datetime' }, { title: '到货时间', key: 'created_at', type: 'datetime' },
              { title: '检验结论备注', key: 'result_remark' },
            ]} />
            <Popover trigger="click" placement="bottomRight" title="AQL 抽样计算器（GB/T 2828.1 正常检验一次抽样）" content={<AqlCalculator />} destroyOnHidden>
              <Button icon={<CalculatorOutlined />}>AQL 计算器</Button>
            </Popover>
          </Space>
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
          <Input.Search allowClear placeholder="检验单号 / 批号 / 物料" defaultValue={url.q} style={{ width: 220 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="检验类型" style={{ width: 120 }} defaultValue={url.insp_type} options={dictOptions('insp_type')} onChange={(v) => setQuery({ insp_type: v })} />
          <SupplierSelect allowClear placeholder="供应商" style={{ width: 200 }} onChange={(v) => setQuery({ supplier_id: v })} />
          <DateRangeFilter placeholder={['到货起', '到货止']} from={url.date_from} to={url.date_to} onChange={(v) => setQuery(v)} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        {status === 'PENDING' && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="待检物料不能被领用。检验员按抽样方案逐项检验（定量项录入实测值自动判定）并电子签名判定后，库存自动转为“合格”或“不合格”（不合格自动开具 NCR）。" />
        )}
        <ResponsiveTable<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
