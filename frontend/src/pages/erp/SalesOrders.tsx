import { Button, Card, Input, Select, Space, Table, Typography, type TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { CustomerSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney } from '../../utils/format';
import { DueDate, QtyProgress, isPast, sumBy } from './shared';

const OPEN_STATUS = 'CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED';
const DONE = ['SHIPPED', 'CLOSED', 'CANCELLED'];

export default function SalesOrders() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination } = usePaged('/sales-orders', {
    q: sp.get('q') || undefined,
    status: sp.get('status') || undefined,
  });

  const columns: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', fixed: 'left', render: (v, r) => <Link to={`/sales/orders/${r.id}`} className="mono">{v}</Link> },
    { title: '客户', dataIndex: 'customer_name', ellipsis: true, width: 220 },
    { title: '客户PO', dataIndex: 'customer_po', render: (v) => v || '-' },
    { title: '下单日期', dataIndex: 'order_date', render: fmtDate },
    {
      title: '交期', dataIndex: 'delivery_date',
      render: (v, r) => <DueDate value={v} overdue={isPast(v) && !DONE.includes(r.status)} hint="交期已过，订单尚未发完" />,
    },
    { title: '金额', dataIndex: 'total_amount', align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="so_status" value={v} /> },
    {
      title: '发货进度', key: 'progress',
      render: (_, r) => (r.status === 'CANCELLED' ? '-' : <QtyProgress done={sumBy(r.lines, 'shipped_qty')} total={sumBy(r.lines, 'qty')} />),
    },
    {
      title: '产品', key: 'products', ellipsis: true, width: 220,
      render: (_, r) => (
        <Typography.Text type="secondary" ellipsis>
          {(r.lines || []).map((l: Rec) => l.material_name).join('、') || '-'}
        </Typography.Text>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="销售订单"
        sub="订单确认后可一键生成生产工单；成品经 QA 放行后才能发货，发货后自动生成应收。"
        extra={can('sales') && <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/sales/orders/new')}>新建订单</Button>}
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder="单号 / 客户PO / 客户名称"
            defaultValue={sp.get('q') || ''}
            style={{ width: 260 }}
            onSearch={(q) => setQuery({ q })}
          />
          <Select
            allowClear
            placeholder="订单状态"
            style={{ width: 180 }}
            defaultValue={sp.get('status') || undefined}
            options={[{ value: OPEN_STATUS, label: '进行中（未发完）' }, ...dictOptions('so_status')]}
            onChange={(v) => setQuery({ status: v })}
          />
          <CustomerSelect style={{ width: 240 }} placeholder="按客户筛选" onChange={(v) => setQuery({ customer_id: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
