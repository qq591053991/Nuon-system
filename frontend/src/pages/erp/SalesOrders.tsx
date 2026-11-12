import { Button, Card, DatePicker, Input, Select, Space, Tooltip, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { CustomerSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney, toDate } from '../../utils/format';
import { QtyProgress, SoDelivery, SoStatusTag, isPast, sumBy } from './shared';

const OPEN_STATUS = 'CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED';
const DONE = ['SHIPPED', 'CLOSED', 'CANCELLED'];

export default function SalesOrders() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/sales-orders', {
    q: sp.get('q') || undefined,
    status: sp.get('status') || undefined,
    customer_id: sp.get('customer_id') || undefined,
  });

  /** 产品去重：同一产品多行（如正常件 + 备品）只列一次，显示合计数量 */
  const products = (r: Rec) => {
    const m = new Map<string, { name: string; qty: number }>();
    for (const l of (r.lines || []) as Rec[]) {
      const k = l.material_code;
      const o = m.get(k) ?? { name: l.material_name, qty: 0 };
      o.qty += Number(l.qty) || 0;
      m.set(k, o);
    }
    return [...m.values()].map((x) => `${x.name} ×${x.qty}`).join('、');
  };
  // 1366 宽度下：单号、客户、交期、金额、状态、进度、产品都在首屏；手机上变卡片（单号为标题，客户为副标题）
  const columns: RColumn<Rec>[] = [
    { title: '单号', dataIndex: 'no', fixed: 'left', sorter: true, width: 130, mobile: 'title', render: (v, r) => <Link to={`/sales/orders/${r.id}`} className="mono">{v}</Link> },
    { title: '客户', dataIndex: 'customer_name', ellipsis: true, width: 180, mobile: 'subtitle' },
    { title: '客户PO', dataIndex: 'customer_po', width: 130, ellipsis: true, render: (v) => v || '-' },
    { title: '下单日期', dataIndex: 'order_date', sorter: true, width: 100, mobile: 'hidden', render: fmtDate },
    {
      title: <Tooltip title="各行交期中最早的一个">交期</Tooltip>, dataIndex: 'delivery_date', sorter: true, width: 130,
      render: (_, r) => <SoDelivery so={r} overdue={isPast(r.earliest_delivery ?? r.delivery_date) && !DONE.includes(r.status)} />,
    },
    { title: '金额', dataIndex: 'total_amount', align: 'right', sorter: true, width: 120, render: (v, r) => fmtMoney(v, r.currency) },
    { title: '状态', dataIndex: 'status', sorter: true, width: 90, render: (_, r) => <SoStatusTag so={r} /> },
    {
      title: '发货进度', key: 'progress', width: 150, mobile: 'hidden',
      render: (_, r) => (r.status === 'CANCELLED' ? '-' : <QtyProgress done={sumBy(r.lines, 'shipped_qty')} total={sumBy(r.lines, 'qty')} width={130} />),
    },
    {
      title: '产品', key: 'products', ellipsis: { showTitle: false }, width: 200,
      render: (_, r) => {
        const t = products(r);
        return <Tooltip title={t}><Typography.Text type="secondary" ellipsis style={{ maxWidth: 190 }}>{t || '-'}</Typography.Text></Tooltip>;
      },
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
            placeholder="单号 / 客户PO / 客户 / 产品编码"
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
          <DatePicker.RangePicker
            placeholder={['下单日期从', '到']}
            presets={[
              { label: '本月', value: [dayjs().startOf('month'), dayjs().endOf('month')] },
              { label: '上月', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
              { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] },
              { label: '今年', value: [dayjs().startOf('year'), dayjs()] },
            ]}
            style={{ width: 260 }}
            onChange={(v) => setQuery({ date_from: toDate(v?.[0]), date_to: toDate(v?.[1]) })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton
            url="/sales-orders"
            params={query}
            filename="销售订单"
            columns={[
              { title: '单号', key: 'no' },
              { title: '客户', key: 'customer_name' },
              { title: '客户PO', key: 'customer_po' },
              { title: '下单日期', key: 'order_date', type: 'date' },
              { title: '交期', key: 'delivery_date', type: 'date' },
              { title: '币别', key: 'currency' },
              { title: '金额', key: 'total_amount', type: 'money' },
              { title: '状态', value: (r) => dictLabel('so_status', r.status) },
              { title: '订购数量', value: (r) => sumBy(r.lines, 'qty'), type: 'number' },
              { title: '已发数量', value: (r) => sumBy(r.lines, 'shipped_qty'), type: 'number' },
              { title: '产品', value: (r) => (r.lines || []).map((l: Rec) => `${l.material_code}×${l.qty}`).join('、'), width: 40 },
            ]}
          />
        </Space>
        <ResponsiveTable rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
