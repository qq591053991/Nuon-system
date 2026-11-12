/**
 * 退供应商单：来料 NCR 处置为“退货”时自动生成（待出库），库存保持“不合格”隔离；
 * 仓管核对实物后【出库确认】才扣减库存；供应商拒收等由 QA【取消】（电子签名），NCR 退回重新评审。
 * 质量、仓管、采购都可查看（采购据此与供应商协调退货/补货）。
 */
import { Alert, Button, Card, Descriptions, Drawer, Form, Input, Modal, Segmented, Space, Spin, Tag, Typography, message } from 'antd';
import { ExportOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { PrintButton, PrintHeader, PrintSignatures } from '../../components/Print';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { useUrlFilters } from './qshared';

const STATUS_TABS = [
  { value: 'PENDING', label: '待出库' },
  { value: 'SHIPPED', label: '已出库' },
  { value: 'CANCELLED', label: '已取消' },
  { value: '', label: '全部' },
];
const stop = (e: MouseEvent) => e.stopPropagation();

/** 出库确认（仓管）：核对实物数量与库位后确认，扣减不合格库存 */
function ShipModal({ r, onClose, onDone }: { r: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!r} title={`出库确认 - ${r?.no ?? ''}`} okText="确认出库（扣减库存）" confirmLoading={busy} onCancel={onClose} destroyOnHidden
      afterOpenChange={(o) => o && form.resetFields()}
      onOk={async () => {
        const v = await form.validateFields();
        setBusy(true);
        try {
          await post(`/supplier-returns/${r!.id}/ship`, v);
          message.success(`${r!.no} 已出库：不合格库存已扣减 ${fmtQty(r!.qty)} ${r!.uom ?? ''}，请通知 QA 关闭 ${r!.ncr_no ?? 'NCR'}`);
          onDone();
          onClose();
        } finally {
          setBusy(false);
        }
      }}>
      {r && (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }} items={[
            { key: 'm', label: '物料', children: `${r.material_code} ${r.material_name}` },
            { key: 'l', label: '批号', children: <span className="mono">{r.lot_no || '-'}</span> },
            { key: 'q', label: '退货数量', children: <b>{fmtQty(r.qty)} {r.uom}</b> },
            { key: 's', label: '退往', children: r.supplier_name || r.owner_customer_name || '-' },
            { key: 'loc', label: '实物所在库位', children: r.locations?.length ? r.locations.map((x: Rec) => `${x.location_code} ${fmtQty(x.qty)}`).join('；') : <Typography.Text type="danger">无不合格库存</Typography.Text> },
          ]} />
          {(r.stock_qty ?? 0) < r.qty && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`不合格库存只有 ${fmtQty(r.stock_qty)}，少于退货数量，请联系 QA 核对`} />}
        </>
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="carrier" label="承运商 / 运单号"><Input placeholder="如：顺丰 SF1234567890（可选）" /></Form.Item>
        <Form.Item name="remark" label="出库备注"><Input placeholder="可选" /></Form.Item>
      </Form>
    </Modal>
  );
}

/** 退货单详情（可打印） */
function ReturnDrawer({ r, onClose }: { r: Rec | null; onClose: () => void }) {
  if (!r) return <Drawer open={false} onClose={onClose} />;
  return (
    <Drawer open width={680} onClose={onClose} title={<Space>{r.no}<StatusTag dict="supplier_return_status" value={r.status} /></Space>}
      extra={<PrintButton title={`退供应商单 ${r.no}`} />}>
      <PrintHeader title="退供应商单" no={r.no} />
      <Descriptions size="small" column={2} bordered items={[
        { key: 's', label: '供应商', span: 2, children: r.supplier_name || (r.owner_customer_name ? `${r.owner_customer_name}（客供料，退回客户）` : '-') },
        { key: 'c', label: '联系人', children: r.supplier_contact || '-' },
        { key: 'p', label: '电话', children: r.supplier_phone || '-' },
        { key: 'a', label: '地址', span: 2, children: r.supplier_address || '-' },
        { key: 'm', label: '物料', span: 2, children: `${r.material_code} ${r.material_name}${r.material_spec ? ` | ${r.material_spec}` : ''}` },
        { key: 'l', label: '批号', children: <span className="mono">{r.lot_no || '-'}</span> },
        { key: 'q', label: '数量', children: <b>{fmtQty(r.qty)} {r.uom}</b> },
        { key: 'n', label: '不合格品报告', children: r.ncr_no ? <Link to={`/quality/ncrs?id=${r.ncr_id}`}>{r.ncr_no}</Link> : '-' },
        { key: 'i', label: '检验单', children: r.inspection_no ? <Link to={`/quality/inspections/${r.inspection_id}`}>{r.inspection_no}</Link> : '-' },
        { key: 'd', label: '不合格描述', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{r.ncr_description || '-'}</span> },
        { key: 'loc', label: '当前库位', span: 2, children: r.status === 'PENDING' ? (r.locations?.map((x: Rec) => `${x.location_code}：${fmtQty(x.qty)}`).join('；') || '-') : '-' },
        { key: 'cb', label: '开单', children: `${r.created_by ?? ''} ${fmtDateTime(r.created_at)}` },
        { key: 'sb', label: '出库', children: r.shipped_by ? `${r.shipped_by} ${fmtDateTime(r.shipped_at)}` : '-' },
        { key: 'rm', label: '备注', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{r.remark || '-'}</span> },
      ]} />
      <div className="print-only"><PrintSignatures roles={['QA 判定', '仓库出库', '供应商签收']} /></div>
    </Drawer>
  );
}

export default function SupplierReturns() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const url = useUrlFilters(['status', 'q', 'supplier_id']);
  const initStatus = url.status ?? (url.q ? '' : 'PENDING');
  const [status, setStatus] = useState(initStatus);
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/supplier-returns', { ...url, status: initStatus || undefined });
  const [shipFor, setShipFor] = useState<Rec | null>(null);
  const [current, setCurrent] = useState<Rec | null>(null);
  const [loadingOne, setLoadingOne] = useState(false);
  const [sign, signHolder] = useESign();

  const open = useCallback(async (id: number) => {
    setLoadingOne(true);
    try {
      setCurrent(await get(`/supplier-returns/${id}`));
    } finally {
      setLoadingOne(false);
    }
  }, []);
  const idParam = Number(sp.get('id')) || null;
  useEffect(() => {
    if (idParam) open(idParam);
  }, [idParam, open]);
  const closeDrawer = () => {
    setCurrent(null);
    if (idParam) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const cancel = async (r: Rec) => {
    try {
      await sign({
        meaning: '退供应商单取消',
        description: `${r.no} 作废，${r.ncr_no ?? 'NCR'} 退回“待处置”重新评审（库存仍为不合格隔离）。请填写取消原因。`,
        reasonRequired: true, reasonLabel: '取消原因', reasonPlaceholder: '如：供应商拒收，改为报废',
        submit: (signature) => post(`/supplier-returns/${r.id}/cancel`, { reason: signature.reason, signature }, true),
      });
      message.success(`${r.no} 已取消，${r.ncr_no ?? 'NCR'} 已退回待处置`);
      reload();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  const columns: any[] = [
    { title: '退货单号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title', render: (v: string) => <Typography.Link className="mono">{v}</Typography.Link> },
    { title: '状态', dataIndex: 'status', sorter: true, mobile: 'subtitle', render: (v: string) => <StatusTag dict="supplier_return_status" value={v} /> },
    { title: '物料', dataIndex: 'material_name', render: (v: string, r: Rec) => <div><div>{v}</div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}</Typography.Text></div> },
    { title: '批号', dataIndex: 'lot_no', sorter: true, render: (v: string, r: Rec) => (v ? <Link className="mono" onClick={stop} to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> : '-') },
    { title: '数量', dataIndex: 'qty', align: 'right', sorter: true, render: (v: number, r: Rec) => <b style={{ whiteSpace: 'nowrap' }}>{fmtQty(v)} {r.uom}</b> },
    { title: '退往', dataIndex: 'supplier_name', render: (v: string, r: Rec) => v || (r.owner_customer_name ? <Tag color="purple">{r.owner_customer_name}</Tag> : '-') },
    { title: '实物库位', key: 'loc', render: (_: any, r: Rec) => (r.status === 'PENDING' ? (r.locations?.map((x: Rec) => `${x.location_code}（${fmtQty(x.qty)}）`).join('、') || <Typography.Text type="danger">无库存</Typography.Text>) : '-') },
    { title: 'NCR', dataIndex: 'ncr_no', render: (v: string, r: Rec) => (v ? <Link onClick={stop} to={`/quality/ncrs?id=${r.ncr_id}`}>{v}</Link> : '-') },
    { title: '开单', dataIndex: 'created_at', sorter: true, render: (v: string, r: Rec) => <span style={{ whiteSpace: 'nowrap' }}>{r.created_by} {fmtDateTime(v)}</span> },
    { title: '出库', dataIndex: 'shipped_at', sorter: true, render: (v: string, r: Rec) => (r.shipped_by ? <span style={{ whiteSpace: 'nowrap' }}>{r.shipped_by} {fmtDateTime(v)}</span> : '-') },
    {
      title: '操作', key: '_op', fixed: 'right',
      render: (_: any, r: Rec) => r.status === 'PENDING' && (
        <Space size={4}>
          {can('wms') && <Button size="small" type="primary" icon={<ExportOutlined />} onClick={async (e) => { stop(e); setShipFor(await get(`/supplier-returns/${r.id}`)); }}>出库确认</Button>}
          {can('qa') && <Button size="small" danger icon={<StopOutlined />} onClick={(e) => { stop(e); cancel(r); }}>取消</Button>}
        </Space>
      ),
    },
  ];

  return (
    <>
      {signHolder}
      <PageHeader
        title="退供应商"
        sub="来料不合格经 QA 评审判定“退货”后自动生成；仓管核对实物后出库确认，系统才扣减“不合格”库存。采购据此与供应商协调退货、补货。"
        extra={<ExportButton url="/supplier-returns" params={query} filename="退供应商单" columns={[
          { title: '退货单号', key: 'no' }, { title: '状态', value: (r) => dictLabel('supplier_return_status', r.status) },
          { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '批号', key: 'lot_no' },
          { title: '数量', key: 'qty', type: 'number' }, { title: '单位', key: 'uom' }, { title: '供应商', value: (r) => r.supplier_name || r.owner_customer_name },
          { title: 'NCR', key: 'ncr_no' }, { title: '开单人', key: 'created_by' }, { title: '开单时间', key: 'created_at', type: 'datetime' },
          { title: '出库人', key: 'shipped_by' }, { title: '出库时间', key: 'shipped_at', type: 'datetime' }, { title: '备注', key: 'remark' },
        ]} />}
      />
      {can('wms') && status === 'PENDING' && rows.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`有 ${rows.length} 张退供应商单待出库：请按“实物库位”取货、核对数量后点【出库确认】。`} />
      )}
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: v || undefined }); }} />
          <Input.Search allowClear placeholder="单号 / 批号 / 物料 / NCR" defaultValue={url.q} style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <ResponsiveTable<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange}
          scroll={{ x: 'max-content' }} onRow={(r) => ({ onClick: () => open(r.id), style: { cursor: 'pointer' } })} />
      </Card>
      <ShipModal r={shipFor} onClose={() => setShipFor(null)} onDone={reload} />
      {loadingOne && !current ? <Drawer open onClose={() => setLoadingOne(false)}><Spin /></Drawer> : <ReturnDrawer r={current} onClose={closeDrawer} />}
    </>
  );
}
