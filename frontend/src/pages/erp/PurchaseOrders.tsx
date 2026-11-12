import { Badge, Button, Card, Checkbox, DatePicker, Input, Select, Space, Tag, Tooltip, Typography } from 'antd';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { AlertOutlined, PlusOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney, fmtQty } from '../../utils/format';
import { QualifiedSupplierSelect } from './purchaseKit';
import { DueDate, isPast } from './shared';

const OPEN_STATUS = 'APPROVED,PARTIAL_RECEIVED';
const DONE = ['RECEIVED', 'CLOSED', 'CANCELLED'];

/** 行的应到日期：供应商回复交期优先 */
const dueOf = (l: Rec, po: Rec) => l.promised_date || l.expected_date || po.expected_date;
const openOf = (l: Rec) => Math.max(0, Math.round((l.qty - (l.received_qty || 0)) * 10000) / 10000);

/** 到货进度：按行统计“已到齐 x/y 行”，悬停看每行（不同物料的数量不相加） */
function LinesProgress({ po }: { po: Rec }) {
  const lines: Rec[] = po.lines || [];
  if (['CANCELLED', 'DRAFT'].includes(po.status) || !lines.length) return <span>-</span>;
  const done = lines.filter((l) => openOf(l) <= 0).length;
  const late = !DONE.includes(po.status) && lines.some((l) => openOf(l) > 0 && isPast(dueOf(l, po)));
  return (
    <Tooltip
      title={
        <div>
          {lines.map((l) => (
            <div key={l.id}>
              {l.material_code}：已收 {fmtQty(l.received_qty || 0)}/{fmtQty(l.qty)} {l.uom}
              {openOf(l) > 0 ? `，未交 ${fmtQty(openOf(l))}` : '，已到齐'}
            </div>
          ))}
        </div>
      }
    >
      <Space size={4}>
        <Badge status={done === lines.length ? 'success' : late ? 'error' : done > 0 || lines.some((l) => l.received_qty > 0) ? 'processing' : 'default'} />
        <span>已到齐 {done}/{lines.length} 行</span>
      </Space>
    </Tooltip>
  );
}

export default function PurchaseOrders() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const init = {
    q: sp.get('q') || undefined,
    status: sp.get('status') || undefined,
    supplier_id: sp.get('supplier_id') ? Number(sp.get('supplier_id')) : undefined,
    material_id: sp.get('material_id') ? Number(sp.get('material_id')) : undefined,
    overdue: sp.get('overdue') || undefined,
  };
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/purchase-orders', init);
  const [chase, setChase] = useState<Rec | null>(null);
  useEffect(() => {
    get('/purchase/chase', { page_size: 1 }, true).then((d) => setChase(d.counts)).catch(() => undefined);
  }, []);

  const columns: RColumn<Rec>[] = [
    { title: '单号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title', render: (v, r) => <Link to={`/purchase/orders/${r.id}`} className="mono">{v}</Link> },
    { title: '供应商', dataIndex: 'supplier_name', ellipsis: true, width: 220, mobile: 'subtitle' },
    { title: '下单日期', dataIndex: 'order_date', sorter: true, mobile: 'hidden', render: fmtDate },
    {
      title: '预计到货', dataIndex: 'expected_date', sorter: true,
      render: (v, r) => {
        const open = ((r.lines || []) as Rec[]).filter((l) => openOf(l) > 0);
        const promised = open.map((l) => l.promised_date).filter(Boolean).sort();
        const late = !DONE.includes(r.status) && open.some((l) => isPast(dueOf(l, r)));
        return (
          <div>
            <DueDate value={v || open.map((l) => l.expected_date).filter(Boolean).sort()[0]} overdue={late} hint="有未到齐的行已过应到日期" />
            {promised.length > 0 && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>供应商回复 {fmtDate(promised[promised.length - 1])}</Typography.Text>}
          </div>
        );
      },
    },
    { title: '金额', dataIndex: 'total_amount', align: 'right', sorter: true, render: (v, r) => fmtMoney(v, r.currency) },
    { title: '状态', dataIndex: 'status', sorter: true, render: (v) => <StatusTag dict="po_status" value={v} /> },
    { title: '到货进度', key: 'progress', mobile: 'hidden', render: (_, r) => <LinesProgress po={r} /> },
    {
      title: '物料', key: 'materials', ellipsis: true, width: 240,
      render: (_, r) => (
        <Typography.Text type="secondary" ellipsis>
          {(r.lines || []).map((l: Rec) => `${l.material_code} ${l.material_name}`).join('、') || '-'}
        </Typography.Text>
      ),
    },
    { title: '来源', dataIndex: 'source', mobile: 'hidden', render: (v) => (v ? <Tag>{v}</Tag> : '手工') },
  ];

  const exportParams = { ...query, sort: undefined, order: undefined };

  return (
    <>
      <PageHeader
        title="采购订单"
        sub="只有合格供方才能审批下单；到货收货后物料自动进入“待检”，并生成 IQC 检验单与应付账款。"
        extra={
          <>
            <Button icon={<AlertOutlined />} onClick={() => nav('/purchase/chase')} danger={!!chase?.overdue}>
              催货清单{chase ? `（逾期 ${chase.overdue} 行）` : ''}
            </Button>
            {can('purchase', 'master') && <Button icon={<SettingOutlined />} onClick={() => nav('/purchase/materials')}>物料采购属性</Button>}
            <ExportButton
              url="/purchase-orders"
              params={exportParams}
              filename={`采购订单_${dayjs().format('YYYYMMDD')}`}
              text="导出订单"
              columns={[
                { title: '单号', key: 'no' },
                { title: '供应商', key: 'supplier_name', width: 28 },
                { title: '下单日期', key: 'order_date', type: 'date' },
                { title: '预计到货', key: 'expected_date', type: 'date' },
                { title: '币别', key: 'currency' },
                { title: '金额', key: 'total_amount', type: 'money' },
                { title: '状态', value: (r) => dictLabel('po_status', r.status) },
                { title: '未到齐行数', value: (r) => (DONE.includes(r.status) || r.status === 'DRAFT' ? 0 : (r.lines || []).filter((l: Rec) => openOf(l) > 0).length), type: 'number' },
                { title: '物料', value: (r) => (r.lines || []).map((l: Rec) => `${l.material_code}×${l.qty}`).join('；'), width: 40 },
                { title: '来源', value: (r) => r.source || '手工' },
                { title: '创建人', key: 'created_by' },
                { title: '审批人', key: 'approved_by' },
              ]}
            />
            <ExportButton
              url="/purchase/lines"
              params={exportParams}
              filename={`采购订单明细_${dayjs().format('YYYYMMDD')}`}
              text="导出明细"
              columns={[
                { title: '单号', key: 'po_no' },
                { title: '下单日期', key: 'order_date', type: 'date' },
                { title: '供应商编码', key: 'supplier_code' },
                { title: '供应商', key: 'supplier_name', width: 28 },
                { title: '状态', value: (r) => dictLabel('po_status', r.po_status) },
                { title: '行号', key: 'line_no', type: 'number' },
                { title: '物料编码', key: 'material_code', width: 18 },
                { title: '物料名称', key: 'material_name', width: 20 },
                { title: '规格', key: 'material_spec', width: 24 },
                { title: '单位', key: 'uom' },
                { title: '数量', key: 'qty', type: 'number' },
                { title: '已收', key: 'received_qty', type: 'number' },
                { title: '未交', key: 'open_qty', type: 'number' },
                { title: '单价', key: 'unit_price', type: 'number' },
                { title: '金额', key: 'amount', type: 'money' },
                { title: '币别', key: 'currency' },
                { title: '采购单位', key: 'purchase_uom' },
                { title: '采购数量', key: 'purchase_qty', type: 'number' },
                { title: '采购单价', key: 'purchase_price', type: 'number' },
                { title: '预计到货', key: 'expected_date', type: 'date' },
                { title: '供应商回复交期', key: 'promised_date', type: 'date' },
                { title: '备注', key: 'remark' },
              ]}
            />
            {can('purchase') && <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/purchase/orders/new')}>新建采购订单</Button>}
          </>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder="单号 / 供应商 / 物料编码或名称"
            defaultValue={init.q || ''}
            style={{ width: 280 }}
            onSearch={(q) => setQuery({ q })}
          />
          <Select
            allowClear
            placeholder="订单状态"
            style={{ width: 170 }}
            defaultValue={init.status}
            options={[{ value: OPEN_STATUS, label: '进行中（待到货）' }, { value: 'DRAFT,SUBMITTED', label: '待审批（草稿 + 待厂长审批）' }, ...dictOptions('po_status')]}
            onChange={(v) => setQuery({ status: v })}
          />
          <QualifiedSupplierSelect style={{ width: 260 }} placeholder="按供应商筛选" defaultValue={init.supplier_id} onChange={(v) => setQuery({ supplier_id: v })} />
          <MaterialSelect style={{ width: 260 }} placeholder="按物料筛选（可扫码）" defaultValue={init.material_id} onChange={(v) => setQuery({ material_id: v })} />
          <DatePicker.RangePicker
            placeholder={['下单日期从', '至']}
            style={{ width: 250 }}
            onChange={(v) => setQuery({ date_from: v?.[0]?.format('YYYY-MM-DD'), date_to: v?.[1]?.format('YYYY-MM-DD') })}
          />
          <Checkbox defaultChecked={init.overdue === '1'} onChange={(e) => setQuery({ overdue: e.target.checked ? '1' : undefined })}>只看逾期未到</Checkbox>
          <Button icon={<ReloadOutlined />} onClick={reload} />
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
        />
      </Card>
    </>
  );
}
