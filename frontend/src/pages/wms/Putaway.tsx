/** 待上架清单：收货暂存区、放置不合规（货主与仓库不符 / 湿敏物料不在防潮柜）、不在默认库位的库存。一键上架到建议库位，或扫码上架。 */
import { Alert, Button, Card, Input, Modal, Space, Switch, Tag, Typography, message } from 'antd';
import { PrinterOutlined, ReloadOutlined, ScanOutlined, SwapOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { WarehouseSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

export default function Putaway() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<Rec>({ q: sp.get('q') || undefined, warehouse_id: sp.get('warehouse_id') || undefined, include_quarantine: sp.get('include_quarantine') === '1' ? 1 : undefined });
  const [busy, setBusy] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [modal, holder] = Modal.useModal();

  const load = useCallback(() => {
    setLoading(true);
    get('/wms/putaway', query).then((d) => setRows(d.items || [])).finally(() => setLoading(false));
  }, [query]);
  useEffect(load, [load]);

  const putaway = async (r: Rec) => {
    if (!r.suggest_location_id) return nav(`/wms/pda/putaway?stock_id=${r.id}`);
    setBusy(r.id);
    try {
      const chk = await post('/wms/placement-check', { material_id: r.material_id, location_id: r.suggest_location_id, owner_customer_id: r.owner_customer_id ?? null });
      let confirm = false;
      if (chk.warnings.length) {
        confirm = await modal.confirm({ title: '库位确认', content: chk.warnings.join('；'), okText: '仍放入', cancelText: '返回' });
        if (!confirm) return;
      }
      await post('/stock/transfer', { stock_id: r.id, to_location_id: r.suggest_location_id, confirm, remark: '待上架清单一键上架' });
      message.success(`${r.material_code} 批号 ${r.lot_no || '-'} 已上架到 ${r.suggest_location_code}`);
      load();
    } finally {
      setBusy(null);
    }
  };

  const columns: RColumn[] = [
    { title: '物料', key: 'm', mobile: 'title', render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag name={r.owner_customer_name} /> : undefined} /> },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    { title: '质量状态', dataIndex: 'status', render: (v) => <StatusTag dict="stock_status" value={v} /> },
    { title: '当前库位', dataIndex: 'location_code', render: (v, r) => <span><b className="mono">{v}</b> <Typography.Text type="secondary">{r.warehouse_name}</Typography.Text></span> },
    { title: '原因', dataIndex: 'putaway_reason', render: (v) => <Tag color="orange">{v}</Tag> },
    { title: '建议库位', dataIndex: 'suggest_location_code', render: (v) => (v ? <b className="mono" style={{ color: '#1677ff' }}>{v}</b> : <Typography.Text type="secondary">请扫码指定</Typography.Text>) },
    { title: '有效期', dataIndex: 'expiry_date', mobile: 'hidden', render: (v) => <ExpiryDate value={v} /> },
    { title: '收货时间', dataIndex: 'received_at', mobile: 'hidden', render: (v) => fmtDateTime(v) },
  ];
  if (can('wms')) {
    columns.push({
      title: '操作', key: '_op',
      render: (_, r) => (
        <Space wrap>
          <Button type="primary" size="large" icon={<SwapOutlined />} loading={busy === r.id} onClick={() => putaway(r)}>
            {r.suggest_location_code ? `上架到 ${r.suggest_location_code}` : '扫码上架'}
          </Button>
          {r.suggest_location_code && <Button size="large" onClick={() => nav(`/wms/pda/putaway?stock_id=${r.id}`)}>其他库位</Button>}
        </Space>
      ),
    });
  }

  return (
    <>
      {holder}
      <PageHeader
        title="待上架"
        sub="收货暂存区的物料、放错仓（自有/客供）、湿敏物料不在防潮柜、不在物料默认库位的库存。"
        extra={(
          <Space wrap>
            {can('wms') && <Button type="primary" icon={<ScanOutlined />} onClick={() => nav('/wms/pda/putaway')}>扫码上架</Button>}
            <Button icon={<PrinterOutlined />} disabled={!selected.length} onClick={() => window.open(`/wms/print/labels?stock=${selected.join(',')}`, '_blank')}>打印批次标签{selected.length ? `（${selected.length}）` : ''}</Button>
            <ExportButton rows={rows} filename="待上架清单" columns={[
              { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '批号', key: 'lot_no' },
              { title: '数量', key: 'qty', type: 'number' }, { title: '单位', key: 'uom' }, { title: '质量状态', value: (r) => dictLabel('stock_status', r.status) },
              { title: '当前库位', key: 'location_code' }, { title: '原因', key: 'putaway_reason' }, { title: '建议库位', key: 'suggest_location_code' },
            ]} />
          </Space>
        )}
      />
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="建议库位来自：物料默认库位 → 客供料仓 → 湿敏物料防潮柜 → 上次收货库位。在“基础资料 › 物料”中设置默认库位后，收货与上架都会自动带出。" />
      <Card>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder="物料 / 批号" defaultValue={query.q} style={{ width: 220 }} onSearch={(q) => setQuery((o) => ({ ...o, q: q.trim() || undefined }))} />
          <WarehouseSelect placeholder="全部仓库" style={{ width: 170 }} onChange={(v) => setQuery((o) => ({ ...o, warehouse_id: v }))} />
          <Space size={6}><Switch checked={!!query.include_quarantine} onChange={(v) => setQuery((o) => ({ ...o, include_quarantine: v ? 1 : undefined }))} /><span>含待检</span></Space>
          <Button icon={<ReloadOutlined />} onClick={load} />
          <Tag>共 {rows.length} 批</Tag>
        </Space>
        <ResponsiveTable rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 'max-content' }} rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]) }} />
      </Card>
    </>
  );
}
