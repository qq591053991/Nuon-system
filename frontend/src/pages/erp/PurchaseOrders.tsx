import { Button, Card, Input, Select, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { SupplierSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney } from '../../utils/format';
import { DueDate, QtyProgress, isPast, sumBy } from './shared';

const OPEN_STATUS = 'APPROVED,PARTIAL_RECEIVED';
const DONE = ['RECEIVED', 'CLOSED', 'CANCELLED'];

export default function PurchaseOrders() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination } = usePaged('/purchase-orders', {
    q: sp.get('q') || undefined,
    status: sp.get('status') || undefined,
  });

  const columns: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', fixed: 'left', render: (v, r) => <Link to={`/purchase/orders/${r.id}`} className="mono">{v}</Link> },
    { title: '供应商', dataIndex: 'supplier_name', ellipsis: true, width: 220 },
    { title: '下单日期', dataIndex: 'order_date', render: fmtDate },
    {
      title: '预计到货', dataIndex: 'expected_date',
      render: (v, r) => <DueDate value={v} overdue={isPast(v) && !DONE.includes(r.status)} hint="已过预计到货日期，尚未到齐" />,
    },
    { title: '金额', dataIndex: 'total_amount', align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="po_status" value={v} /> },
    {
      title: '到货进度', key: 'progress',
      render: (_, r) => (r.status === 'CANCELLED' ? '-' : <QtyProgress done={sumBy(r.lines, 'received_qty')} total={sumBy(r.lines, 'qty')} />),
    },
    {
      title: '物料', key: 'materials', ellipsis: true, width: 220,
      render: (_, r) => (
        <Typography.Text type="secondary" ellipsis>
          {(r.lines || []).map((l: Rec) => l.material_name).join('、') || '-'}
        </Typography.Text>
      ),
    },
    { title: '来源', dataIndex: 'source', render: (v) => (v ? <Tag>{v}</Tag> : '手工') },
  ];

  return (
    <>
      <PageHeader
        title="采购订单"
        sub="只有合格供方才能审批下单；到货收货后物料自动进入“待检”，并生成 IQC 检验单与应付账款。"
        extra={can('purchase') && <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/purchase/orders/new')}>新建采购订单</Button>}
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="单号 / 供应商名称" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          <Select
            allowClear
            placeholder="订单状态"
            style={{ width: 180 }}
            defaultValue={sp.get('status') || undefined}
            options={[{ value: OPEN_STATUS, label: '进行中（待到货）' }, ...dictOptions('po_status')]}
            onChange={(v) => setQuery({ status: v })}
          />
          <SupplierSelect style={{ width: 240 }} placeholder="按供应商筛选" onChange={(v) => setQuery({ supplier_id: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
