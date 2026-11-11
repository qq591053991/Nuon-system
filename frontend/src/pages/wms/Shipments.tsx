import { Alert, Button, Card, Descriptions, Drawer, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { CloseOutlined, NodeIndexOutlined, PlusOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { LotLink, MaterialCell, Qty, traceSnUrl } from './common';
import ShipmentCreate from './ShipmentCreate';

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '待过账' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'CANCELLED', label: '已取消' },
];

/** 发货单动作：待过账 → 发货过账 / 取消 */
function ShipmentActions({ row, onChanged, size = 'small' }: { row: Rec; onChanged: () => void; size?: 'small' | 'middle' }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (row.status !== 'DRAFT') return null;
  const act = async (action: 'confirm' | 'cancel') => {
    setBusy(true);
    try {
      await post(`/shipments/${row.id}/${action}`);
      message.success(action === 'confirm' ? `发货单 ${row.no} 已过账：库存已扣减，序列号已出库，应收已生成` : `发货单 ${row.no} 已取消`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space size={4} onClick={(e) => e.stopPropagation()}>
      {can('wms') && (
        <Popconfirm
          title="确认发货过账？"
          description={<div style={{ maxWidth: 300 }}>请确认实物已按单拣货、核对序列号并交付承运商。过账后扣减库存、序列号状态变为“已发货”并生成应收，不可撤销。</div>}
          okText="发货过账"
          onConfirm={() => act('confirm')}
        >
          <Button size={size} type="primary" icon={<SendOutlined />} loading={busy}>发货过账</Button>
        </Popconfirm>
      )}
      {can('wms', 'sales') && (
        <Popconfirm title="确定取消该发货单？" okText="取消发货单" cancelText="不取消" onConfirm={() => act('cancel')}>
          <Button size={size} danger icon={<CloseOutlined />} disabled={busy}>取消</Button>
        </Popconfirm>
      )}
    </Space>
  );
}

function ShipmentDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (!id) return;
    setLoading(true);
    get(`/shipments/${id}`).then(setD).finally(() => setLoading(false));
  };
  useEffect(() => {
    setD(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const columns: TableColumnsType<Rec> = [
    { title: '产品', key: 'm', render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} /> },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '出货库位', dataIndex: 'location_code', render: (v) => <span className="mono">{v}</span> },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    {
      title: '序列号', key: 'sn',
      render: (_, r) => (r.serial_list?.length ? <Tag color="geekblue">{r.serial_list.length} 台</Tag> : <Typography.Text type="secondary">非序列号产品</Typography.Text>),
    },
  ];
  const total = (d?.lines as Rec[] | undefined)?.reduce((s, l) => s + (l.qty || 0), 0) ?? 0;

  return (
    <Drawer
      open={!!id}
      width={900}
      onClose={onClose}
      destroyOnHidden
      title={d && <Space>发货单 <span className="mono">{d.no}</span><StatusTag dict="doc_status" value={d.status} /></Space>}
      extra={d && <ShipmentActions row={d} size="middle" onChanged={() => { load(); onChanged(); }} />}
    >
      <Spin spinning={loading}>
        {d && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="销售订单">{d.so_id ? <Link to={`/sales/orders/${d.so_id}`}>{d.so_no}</Link> : '-'}</Descriptions.Item>
              <Descriptions.Item label="客户">{d.customer_name}</Descriptions.Item>
              <Descriptions.Item label="承运商">{d.carrier || '-'}</Descriptions.Item>
              <Descriptions.Item label="运单号"><span className="mono">{d.tracking_no || '-'}</span></Descriptions.Item>
              <Descriptions.Item label="收货地址" span={2}>{d.ship_to || '-'}</Descriptions.Item>
              <Descriptions.Item label="制单">{d.created_by || '-'} · {fmtDateTime(d.created_at)}</Descriptions.Item>
              <Descriptions.Item label="发货">{d.status === 'SHIPPED' ? `${d.shipped_by || '-'} · ${fmtDate(d.ship_date)}` : '-'}</Descriptions.Item>
              {d.remark && <Descriptions.Item label="备注" span={2}>{d.remark}</Descriptions.Item>}
            </Descriptions>
            {d.status === 'DRAFT' && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="请按下列库位、批号、序列号拣货并核对实物，确认无误后点击右上角“发货过账”。" />
            )}
            <Table
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={d.lines}
              pagination={false}
              expandable={{
                defaultExpandAllRows: true,
                rowExpandable: (r) => !!r.serial_list?.length,
                expandedRowRender: (r) => (
                  <Space size={[6, 6]} wrap>
                    {(r.serial_list as string[]).map((sn) => (
                      <Link key={sn} to={traceSnUrl(sn)}><Tag className="mono" icon={<NodeIndexOutlined />} style={{ marginInlineEnd: 0, cursor: 'pointer' }}>{sn}</Tag></Link>
                    ))}
                  </Space>
                ),
              }}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4} align="right"><b>合计</b></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right"><b>{fmtQty(total)}</b></Table.Summary.Cell>
                  <Table.Summary.Cell index={2} />
                </Table.Summary.Row>
              )}
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
              点击序列号可查看该台设备的完整追溯记录（物料批次、工序、测试数据、放行）。
            </Typography.Paragraph>
          </>
        )}
      </Spin>
    </Drawer>
  );
}

export default function Shipments() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination } = usePaged('/shipments', { q: sp.get('q') || undefined });
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [initialSoId, setInitialSoId] = useState<number | undefined>();
  const [modal, modalHolder] = Modal.useModal();

  // 从销售订单跳转：/wms/shipments?so_id=1&new=1 自动打开新建
  useEffect(() => {
    const soId = sp.get('so_id');
    if (sp.get('new') === '1' && can('wms', 'sales')) {
      setInitialSoId(soId ? Number(soId) : undefined);
      setCreating(true);
      const next = new URLSearchParams(sp);
      next.delete('new');
      next.delete('so_id');
      setSp(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  const onCreated = (sh: Rec) => {
    setCreating(false);
    reload();
    const qty = (sh.lines as Rec[]).reduce((s, l) => s + (l.qty || 0), 0);
    if (!can('wms')) {
      message.success(`发货单 ${sh.no} 已生成，等待仓库发货过账`);
      setCurrentId(sh.id);
      return;
    }
    modal.confirm({
      title: `发货单 ${sh.no} 已生成`,
      content: `共 ${fmtQty(qty)} 件，已锁定批次/序列号。实物拣货核对无误后可立即过账（扣减库存、序列号出库、生成应收）。`,
      okText: '立即过账',
      cancelText: '稍后过账',
      onOk: async () => {
        await post(`/shipments/${sh.id}/confirm`);
        message.success(`发货单 ${sh.no} 已过账`);
        reload();
        setCurrentId(sh.id);
      },
      onCancel: () => setCurrentId(sh.id),
    });
  };

  const columns: TableColumnsType<Rec> = [
    { title: '发货单号', dataIndex: 'no', width: 130, fixed: 'left', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
    {
      title: '销售订单', dataIndex: 'so_no', width: 130,
      render: (v, r) => (v ? <Link to={`/sales/orders/${r.so_id}`} onClick={(e) => e.stopPropagation()}>{v}</Link> : '-'),
    },
    { title: '客户', dataIndex: 'customer_name', width: 200, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag dict="doc_status" value={v} /> },
    {
      title: '数量', key: 'qty', width: 80, align: 'right',
      render: (_, r) => fmtQty((r.lines as Rec[] | undefined)?.reduce((s, l) => s + (l.qty || 0), 0)),
    },
    { title: '发货日期', dataIndex: 'ship_date', width: 110, render: (v) => fmtDate(v) },
    { title: '承运商', dataIndex: 'carrier', width: 100, render: (v) => v || '-' },
    { title: '运单号', dataIndex: 'tracking_no', width: 150, render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '发货人', dataIndex: 'shipped_by', width: 90, render: (v) => v || '-' },
    { title: '制单', dataIndex: 'created_by', width: 90 },
    { title: '操作', key: '_op', fixed: 'right', width: 190, render: (_, r) => <ShipmentActions row={r} onChanged={reload} /> },
  ];

  return (
    <>
      {modalHolder}
      <PageHeader
        title="发货出库"
        sub="按销售订单发货：选订单 → 扫码或自动选取已放行整机 → 生成发货单 → 发货过账。"
        extra={can('wms', 'sales') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setInitialSoId(undefined); setCreating(true); }}>新建发货单</Button>
        )}
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="只能发已 DHR 放行的合格成品，序列号逐台校验；过账后每台设备都可追溯到客户、日期与运单号。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="发货单号 / 运单号" defaultValue={sp.get('q') || ''} style={{ width: 240 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Select allowClear placeholder="状态" style={{ width: 130 }} options={STATUS_OPTIONS} onChange={(v) => setQuery({ status: v })} />
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
          onRow={(r) => ({ onClick: () => setCurrentId(r.id), style: { cursor: 'pointer' } })}
        />
      </Card>
      <ShipmentDrawer id={currentId} onClose={() => setCurrentId(null)} onChanged={reload} />
      <ShipmentCreate open={creating} initialSoId={initialSoId} onClose={() => setCreating(false)} onCreated={onCreated} />
    </>
  );
}
