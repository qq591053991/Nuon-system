import { Alert, AutoComplete, Button, Card, Descriptions, Drawer, Input, Modal, Select, Space, Spin, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { EditOutlined, NodeIndexOutlined, PlusOutlined, PrinterOutlined, ReloadOutlined, SendOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { LotLink, MaterialCell, Qty, traceSnUrl } from './common';
import ShipmentCreate from './ShipmentCreate';

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '待过账' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'CANCELLED', label: '已作废' },
  { value: 'REVERSED', label: '已冲销' },
];

/** 发货单动作：待过账 → 发货过账 / 作废；已发货 → 冲销（电子签名 + 原因） */
function ShipmentActions({ row, onChanged, size = 'small', compact = false, inList = false }: { row: Rec; onChanged: () => void; size?: 'small' | 'middle' | 'large'; compact?: boolean; inList?: boolean }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [modal, holder] = Modal.useModal();
  const [sign, signHolder] = useESign();
  const act = async (action: 'confirm' | 'cancel') => {
    const ok = await modal.confirm(action === 'confirm'
      ? { title: '确认发货过账？', okText: '发货过账', cancelText: '返回', content: '请确认实物已按单拣货、核对序列号并交付承运商。过账后扣减库存、序列号变为“已发货”并生成应收；如有错误可“冲销”。' }
      : { title: `作废发货单 ${row.no}？`, okText: '作废', cancelText: '返回', okButtonProps: { danger: true }, content: '作废后锁定的批次/序列号释放，可重新发货。' });
    if (!ok) return;
    setBusy(true);
    try {
      await post(`/shipments/${row.id}/${action}`);
      message.success(action === 'confirm' ? `发货单 ${row.no} 已过账：库存已扣减，序列号已出库，应收已生成` : `发货单 ${row.no} 已作废`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const reverse = async () => {
    try {
      await sign({
        meaning: '发货单冲销', reasonRequired: true, reasonLabel: '冲销原因', reasonPlaceholder: '如：发错客户 / 实物未出库',
        description: `冲销 ${row.no}：库存按原批次、原库位加回合格，序列号恢复“在库”，扣回订单已发数量，并生成红字应收。已登记客户退货的序列号不能冲销。`,
        submit: (signature) => post(`/shipments/${row.id}/reverse`, { reason: signature.reason, signature }),
      });
      message.success(`发货单 ${row.no} 已冲销`);
      onChanged();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };
  if (row.status === 'SHIPPED') {
    if (compact || inList || !can('wms')) return null; // 冲销只放在明细里
    return <span onClick={(e) => e.stopPropagation()}>{signHolder}<Button size={size} danger icon={<UndoOutlined />} onClick={reverse}>冲销</Button></span>;
  }
  if (row.status !== 'DRAFT') return null;
  return (
    <Space size={4} wrap onClick={(e) => e.stopPropagation()}>
      {holder}
      {can('wms') && <Button size={size} type="primary" icon={<SendOutlined />} loading={busy} onClick={() => act('confirm')}>发货过账</Button>}
      {can('wms', 'sales') && !compact && <Button size={size} danger icon={<StopOutlined />} disabled={busy} onClick={() => act('cancel')}>作废</Button>}
    </Space>
  );
}

/** 承运商 / 运单号补录（待过账或已发货均可） */
function TrackingEdit({ d, onSaved }: { d: Rec; onSaved: (r: Rec) => void }) {
  const [editing, setEditing] = useState(false);
  const [carrier, setCarrier] = useState(d.carrier || '');
  const [no, setNo] = useState(d.tracking_no || '');
  const { can } = useAuth();
  if (!editing) {
    return (
      <Space>
        <span>{d.carrier || '-'} / <span className="mono">{d.tracking_no || '-'}</span></span>
        {can('wms', 'sales') && ['DRAFT', 'SHIPPED'].includes(d.status) && <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(true)}>{d.tracking_no ? '修改' : '补录'}</Button>}
      </Space>
    );
  }
  return (
    <Space wrap>
      <AutoComplete style={{ width: 120 }} value={carrier} onChange={setCarrier} options={['顺丰速运', '京东物流', '德邦物流', '中通快运', 'DHL', 'FedEx', 'UPS', '客户自提'].map((v) => ({ value: v }))} placeholder="承运商" />
      <Input style={{ width: 180 }} autoFocus value={no} onChange={(e) => setNo(e.target.value)} placeholder="运单号（可扫码）"
        onPressEnter={async () => { onSaved(await put(`/shipments/${d.id}/tracking`, { carrier, tracking_no: no })); message.success('运单号已保存'); setEditing(false); }} />
      <Button type="primary" onClick={async () => { onSaved(await put(`/shipments/${d.id}/tracking`, { carrier, tracking_no: no })); message.success('运单号已保存'); setEditing(false); }}>保存</Button>
      <Button onClick={() => setEditing(false)}>返回</Button>
    </Space>
  );
}

function ShipmentDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const narrow = useNarrow(768);
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

  const actions = d && (
    <Space wrap>
      <Button icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/shipment/${d.id}`, '_blank')}>打印发货单/装箱单</Button>
      <ShipmentActions row={d} size="middle" onChanged={() => { load(); onChanged(); }} />
    </Space>
  );
  return (
    <Drawer
      open={!!id}
      width={narrow ? '100%' : 940}
      onClose={onClose}
      destroyOnHidden
      title={d && <Space wrap>发货单 <span className="mono">{d.no}</span><StatusTag dict="doc_status" value={d.status} /></Space>}
      extra={!narrow && actions}
    >
      <Spin spinning={loading}>
        {d && (
          <>
            {narrow && <div style={{ marginBottom: 12 }}>{actions}</div>}
            <Descriptions size="small" column={narrow ? 1 : 2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="销售订单">{d.so_id ? <Link to={`/sales/orders/${d.so_id}`}>{d.so_no}</Link> : '-'}</Descriptions.Item>
              <Descriptions.Item label="客户">{d.customer_name}</Descriptions.Item>
              <Descriptions.Item label="承运商 / 运单号" span={narrow ? 1 : 2}><TrackingEdit key={`${d.id}-${d.tracking_no}`} d={d} onSaved={(r) => { setD(r); onChanged(); }} /></Descriptions.Item>
              <Descriptions.Item label="收货地址" span={2}>{d.ship_to || '-'}</Descriptions.Item>
              <Descriptions.Item label="制单">{d.created_by || '-'} · {fmtDateTime(d.created_at)}</Descriptions.Item>
              <Descriptions.Item label="发货">{d.ship_date ? `${d.shipped_by || '-'} · ${fmtDate(d.ship_date)}` : '-'}</Descriptions.Item>
              {d.reversed_by && <Descriptions.Item label="冲销" span={narrow ? 1 : 2}>{d.reversed_by} · {fmtDateTime(d.reversed_at)} · {d.reverse_reason}</Descriptions.Item>}
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
  const narrow = useNarrow();
  const [sp, setSp] = useSearchParams();
  const { rows, loading, query, setQuery, reload, pagination, onTableChange } = usePaged('/shipments', { q: sp.get('q') || undefined, status: sp.get('status') || undefined, so_id: sp.get('so_id') && !sp.get('new') ? sp.get('so_id') : undefined });
  const [currentId, setCurrentId] = useState<number | null>(sp.get('id') ? Number(sp.get('id')) : null);
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

  const columns: RColumn[] = [
    { title: '发货单号', dataIndex: 'no', width: 130, sorter: true, fixed: narrow ? undefined : 'left', mobile: 'title', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
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
    { title: '发货日期', dataIndex: 'ship_date', width: 110, sorter: true, render: (v) => fmtDate(v) },
    { title: '承运商', dataIndex: 'carrier', width: 100, mobile: 'hidden', render: (v) => v || '-' },
    { title: '运单号', dataIndex: 'tracking_no', width: 150, render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '发货人', dataIndex: 'shipped_by', width: 90, mobile: 'hidden', render: (v) => v || '-' },
    { title: '制单', dataIndex: 'created_by', width: 90, mobile: 'hidden' },
    { title: '操作', key: '_op', fixed: narrow ? undefined : 'right', width: 190, render: (_, r) => <ShipmentActions row={r} onChanged={reload} size={narrow ? 'large' : 'small'} compact={narrow} inList /> },
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
          <Select allowClear placeholder="状态" style={{ width: 130 }} defaultValue={sp.get('status') || undefined} options={STATUS_OPTIONS} onChange={(v) => setQuery({ status: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton url="/shipments" params={query} filename="发货单" columns={[
            { title: '发货单号', key: 'no' }, { title: '销售订单', key: 'so_no' }, { title: '客户', key: 'customer_name' },
            { title: '状态', value: (r) => dictLabel('doc_status', r.status) }, { title: '数量', value: (r) => (r.lines as Rec[] | undefined)?.reduce((s, l) => s + (l.qty || 0), 0) ?? 0, type: 'number' },
            { title: '序列号', value: (r) => (r.lines as Rec[] | undefined)?.flatMap((l) => l.serial_list || []).join(' ') },
            { title: '发货日期', key: 'ship_date', type: 'date' }, { title: '承运商', key: 'carrier' }, { title: '运单号', key: 'tracking_no' },
            { title: '发货人', key: 'shipped_by' }, { title: '冲销原因', key: 'reverse_reason' },
          ]} />
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
          onRow={(r) => ({ onClick: () => setCurrentId(r.id), style: { cursor: 'pointer' } })}
        />
      </Card>
      <ShipmentDrawer id={currentId} onClose={() => setCurrentId(null)} onChanged={reload} />
      <ShipmentCreate open={creating} initialSoId={initialSoId} onClose={() => setCreating(false)} onCreated={onCreated} />
    </>
  );
}
