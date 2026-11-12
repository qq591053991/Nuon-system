import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import { PrinterOutlined, ReloadOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { LocationSelect, WarehouseSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney, fmtQty } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

const EXPIRING = [30, 60, 90].map((d) => ({ value: d, label: `${d} 天内到期` }));

/** 调拨弹窗 */
function TransferModal({ stock, onClose, onDone }: { stock: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [modal, holder] = Modal.useModal();
  const locRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stock) {
      form.resetFields();
      form.setFieldsValue({ qty: stock.qty });
      // 打开即聚焦“目标库位”（可直接扫库位条码）
      setTimeout(() => locRef.current?.querySelector('input')?.focus(), 150);
      get('/wms/suggest-location', { material_id: stock.material_id }, true)
        .then((sug) => { if (sug && sug.id !== stock.location_id && !form.getFieldValue('to_location_id')) form.setFieldsValue({ to_location_id: sug.id }); })
        .catch(() => undefined);
    }
  }, [stock, form]);

  const submit = async () => {
    const v = await form.validateFields();
    if (v.to_location_id === stock!.location_id) {
      message.warning('目标库位与当前库位相同');
      return;
    }
    setSaving(true);
    try {
      const chk = await post('/wms/placement-check', { material_id: stock!.material_id, location_id: v.to_location_id, owner_customer_id: stock!.owner_customer_id ?? null });
      if (!chk.ok) {
        message.error(chk.errors.join('；'));
        return;
      }
      let confirm = false;
      if (chk.warnings.length) {
        confirm = await modal.confirm({ title: '库位确认', content: chk.warnings.join('；'), okText: '仍放入', cancelText: '返回', autoFocusButton: 'ok' });
        if (!confirm) return;
      }
      await post('/stock/transfer', { stock_id: stock!.id, qty: v.qty >= stock!.qty ? null : v.qty, to_location_id: v.to_location_id, remark: v.remark, confirm });
      message.success(`调拨完成：${stock!.location_code} → ${chk.location?.code}`);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!stock} title="库位调拨 / 上架" onCancel={onClose} onOk={submit} okText="确认调拨" confirmLoading={saving} destroyOnHidden maskClosable={false}>
      {holder}
      {stock && (
        <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
          <Descriptions.Item label="物料" span={2}>{stock.material_code} {stock.material_name}</Descriptions.Item>
          <Descriptions.Item label="批号"><span className="mono">{stock.lot_no || '-'}</span></Descriptions.Item>
          <Descriptions.Item label="质量状态"><StatusTag dict="stock_status" value={stock.status} /></Descriptions.Item>
          <Descriptions.Item label="当前库位">{stock.location_code}（{stock.warehouse_name}）</Descriptions.Item>
          <Descriptions.Item label="可调数量"><Qty qty={stock.qty} uom={stock.uom} strong /></Descriptions.Item>
        </Descriptions>
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="qty" label="调拨数量" rules={[{ required: true, message: '请输入数量' }]}>
          <InputNumber style={{ width: '100%' }} min={0.0001} max={stock?.qty} suffix={stock?.uom} />
        </Form.Item>
        <div ref={locRef}>
          <Form.Item name="to_location_id" label="目标库位（可直接扫库位条码）" rules={[{ required: true, message: '请选择目标库位' }]}>
            <LocationSelect />
          </Form.Item>
        </div>
        <Form.Item name="remark" label="备注">
          <Input placeholder="如：IQC 合格上架、移至线边仓" />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>调拨只改变存放位置，批号、质量状态、货主保持不变，并记录库存流水。</Typography.Text>
    </Modal>
  );
}

/** 库存明细（按物料+库位+批次+质量状态+货主） */
function StockDetail({ q, onQ }: { q: string; onQ: (q: string) => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const narrow = useNarrow();
  const [sp] = useSearchParams();
  const exp = sp.get('expiring_days');
  const { rows, loading, query, setQuery, reload, pagination } = usePaged('/stock', {
    q: q || undefined,
    status: sp.get('status') || undefined,
    expiring_days: exp ? Number(exp) : undefined,
    material_id: sp.get('material_id') || undefined,
    lot_no: sp.get('lot_no') || undefined,
    location_id: sp.get('location_id') || undefined,
    warehouse_id: sp.get('warehouse_id') || undefined,
  });
  const [moving, setMoving] = useState<Rec | null>(null);
  const [text, setText] = useState(q);
  const [selected, setSelected] = useState<number[]>([]);
  const showCost = can('finance', 'purchase');

  // 从“库存汇总”点击进入时带入物料编码
  useEffect(() => {
    setText(q);
    if ((query.q || '') !== q) setQuery({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const columns: RColumn[] = [
    {
      title: '物料', key: 'material', fixed: narrow ? undefined : 'left', width: 240, mobile: 'title',
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} />,
    },
    { title: '库位', dataIndex: 'location_code', width: 90, render: (v, r) => <span><b className="mono" style={{ fontSize: narrow ? 17 : undefined }}>{v}</b>{narrow ? <Typography.Text type="secondary"> {r.warehouse_name}</Typography.Text> : null}</span> },
    { title: '批号', dataIndex: 'lot_no', width: 130, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '数量', dataIndex: 'qty', width: 110, align: 'right', render: (v, r) => <span style={{ fontSize: narrow ? 17 : undefined }}><Qty qty={v} uom={r.uom} strong /></span> },
    { title: '质量状态', dataIndex: 'status', width: 110, render: (v) => <StatusTag dict="stock_status" value={v} /> },
    { title: '仓库', dataIndex: 'warehouse_name', width: 100, mobile: 'hidden' },
    {
      title: '货主', dataIndex: 'owner_customer_name', width: 160, mobile: 'hidden',
      render: (v) => (v ? <Space size={4}><CsTag name={v} /><Typography.Text ellipsis style={{ maxWidth: 110 }}>{v}</Typography.Text></Space> : <Typography.Text type="secondary">自有</Typography.Text>),
    },
    { title: '生产日期', dataIndex: 'mfg_date', width: 105, mobile: 'hidden', render: (v) => fmtDate(v) },
    { title: '有效期至', dataIndex: 'expiry_date', width: 140, render: (v) => <ExpiryDate value={v} /> },
    {
      title: '供应商 / 原厂批号', key: 'supplier', width: 180, mobile: 'hidden',
      render: (_, r) => (r.supplier_name || r.supplier_lot ? (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.supplier_name || '-'}</div>
          {r.supplier_lot && <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{r.supplier_lot}</Typography.Text>}
        </div>
      ) : '-'),
    },
  ];
  if (showCost) columns.push({ title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v) => fmtMoney(v) });
  if (can('wms')) {
    columns.push({
      title: '操作', key: '_op', fixed: narrow ? undefined : 'right', width: 80,
      render: (_, r) => (narrow
        ? <Button size="large" icon={<SwapOutlined />} onClick={() => nav(`/wms/pda/putaway?stock_id=${r.id}`)}>调拨 / 上架</Button>
        : <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => setMoving(r)}>调拨</Button>),
    });
  }
  const exportCols = [
    { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '规格', key: 'material_spec' },
    { title: '仓库', key: 'warehouse_name' }, { title: '库位', key: 'location_code' }, { title: '批号', key: 'lot_no' },
    { title: '质量状态', value: (r: Rec) => dictLabel('stock_status', r.status) }, { title: '数量', key: 'qty', type: 'number' as const }, { title: '单位', key: 'uom' },
    { title: '货主', value: (r: Rec) => r.owner_customer_name || '自有' }, { title: '生产日期', key: 'mfg_date', type: 'date' as const },
    { title: '有效期至', key: 'expiry_date', type: 'date' as const }, { title: '供应商', key: 'supplier_name' }, { title: '原厂批号', key: 'supplier_lot' },
    ...(showCost ? [{ title: '金额', key: 'amount', type: 'money' as const }] : []),
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder="物料编码 / 名称 / 批号（可扫码）" style={{ width: narrow ? '100%' : 240 }} value={text} onChange={(e) => setText(e.target.value)} onSearch={(v) => onQ(v.trim())} />
        <WarehouseSelect placeholder="全部仓库" style={{ width: narrow ? 128 : 170 }} onChange={(v) => setQuery({ warehouse_id: v })} />
        <Select allowClear placeholder="质量状态" style={{ width: narrow ? 128 : 140 }} defaultValue={sp.get('status') || undefined} options={dictOptions('stock_status')} onChange={(v) => setQuery({ status: v })} />
        <Select allowClear placeholder="临期预警" style={{ width: narrow ? 128 : 140 }} defaultValue={exp ? Number(exp) : undefined} options={EXPIRING} onChange={(v) => setQuery({ expiring_days: v })} />
        {(query.material_id || query.lot_no || query.location_id) && (
          <Tag closable color="blue" onClose={() => setQuery({ material_id: undefined, lot_no: undefined, location_id: undefined })}>
            已按{query.lot_no ? `批号 ${query.lot_no}` : query.location_id ? '库位' : '物料'}筛选
          </Tag>
        )}
        <Button icon={<ReloadOutlined />} onClick={reload} />
        {!narrow && <ExportButton url="/stock" params={query} filename="库存明细" columns={exportCols} />}
        {!narrow && <Button icon={<PrinterOutlined />} disabled={!selected.length} onClick={() => window.open(`/wms/print/labels?stock=${selected.join(',')}`, '_blank')}>
          批次标签{selected.length ? `（${selected.length}）` : ''}
        </Button>}
      </Space>
      <ResponsiveTable rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }}
        rowSelection={narrow ? undefined : { selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]) }} />
      <TransferModal stock={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />
    </>
  );
}

/** 库存汇总（按物料，分质量状态） */
function StockSummary({ onDrill }: { onDrill: (code: string) => void }) {
  const { can } = useAuth();
  const showCost = can('finance', 'purchase');
  const narrow = useNarrow();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [sp] = useSearchParams();
  // 工作台“低于安全库存”待办跳转带 ?below_safety=1
  const [filter, setFilter] = useState<Rec>({ below_safety: ['1', 'true'].includes(sp.get('below_safety') || '') });

  const load = useCallback(() => {
    setLoading(true);
    const params: Rec = {};
    Object.entries(filter).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params[k] = v;
    });
    get<Rec[]>('/stock/summary', params)
      .then(setRows)
      .finally(() => setLoading(false));
  }, [filter]);
  useEffect(load, [load]);

  const totals = useMemo(() => ({
    amount: rows.reduce((s, r) => s + (r.amount || 0), 0),
    below: rows.filter((r) => r.below_safety).length,
    quarantine: rows.filter((r) => r.quarantine > 0).length,
  }), [rows]);

  const num = (v: number, color?: string) => (v ? <span style={{ color, fontWeight: 600 }}>{fmtQty(v)}</span> : <span style={{ color: '#ccc' }}>0</span>);

  const columns: RColumn[] = [
    {
      title: '物料', key: 'material', fixed: narrow ? undefined : 'left', width: 260, mobile: 'title',
      render: (_, r) => (
        <MaterialCell
          code={r.material_code}
          name={r.material_name}
          spec={r.spec}
          extra={r.customer_supplied ? <CsTag /> : undefined}
        />
      ),
    },
    { title: '类别', dataIndex: 'category', width: 90, mobile: 'hidden', render: (v) => <StatusTag dict="material_category" value={v} /> },
    { title: '单位', dataIndex: 'uom', width: 60 },
    {
      title: '合格', dataIndex: 'available', width: 110, align: 'right',
      render: (v, r) => (r.below_safety ? (
        <Tooltip title={`低于安全库存 ${fmtQty(r.safety_stock)}`}>
          <span style={{ color: '#cf1322', fontWeight: 600 }}><WarningOutlined style={{ marginRight: 4 }} />{fmtQty(v)}</span>
        </Tooltip>
      ) : num(v, '#389e0d')),
    },
    { title: '待检', dataIndex: 'quarantine', width: 100, align: 'right', render: (v) => num(v, '#d48806') },
    { title: '不合格', dataIndex: 'rejected', width: 100, align: 'right', render: (v) => num(v, '#cf1322') },
    { title: '冻结', dataIndex: 'hold', width: 100, align: 'right', render: (v) => num(v, '#722ed1') },
    {
      title: '安全库存', dataIndex: 'safety_stock', width: 100, align: 'right',
      render: (v, r) => <span style={{ color: r.below_safety ? '#cf1322' : undefined }}>{v ? fmtQty(v) : '-'}</span>,
    },
    ...(showCost ? [{ title: '库存金额', dataIndex: 'amount', width: 120, align: 'right' as const, render: (v: number) => fmtMoney(v) }] : []),
    {
      title: '', key: '_op', fixed: narrow ? undefined : 'right', width: 90,
      render: (_, r) => <Button size={narrow ? 'large' : 'small'} type="link" onClick={() => onDrill(r.material_code)}>批次明细</Button>,
    },
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="物料编码 / 名称" style={{ width: 220 }} onSearch={(q) => setFilter((f) => ({ ...f, q }))} />
        <Select allowClear placeholder="物料类别" style={{ width: 140 }} options={dictOptions('material_category')} onChange={(v) => setFilter((f) => ({ ...f, category: v }))} />
        <Space size={6}>
          <Switch checked={!!filter.below_safety} onChange={(v) => setFilter((f) => ({ ...f, below_safety: v }))} />
          <span>只看低于安全库存</span>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={load} />
        <ExportButton rows={rows} filename="库存汇总" columns={[
          { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '规格', key: 'spec' },
          { title: '类别', value: (r) => dictLabel('material_category', r.category) }, { title: '单位', key: 'uom' },
          { title: '合格', key: 'available', type: 'number' }, { title: '待检', key: 'quarantine', type: 'number' }, { title: '不合格', key: 'rejected', type: 'number' },
          { title: '冻结', key: 'hold', type: 'number' }, { title: '安全库存', key: 'safety_stock', type: 'number' },
          { title: '低于安全库存', value: (r) => (r.below_safety ? '是' : '') },
          ...(showCost ? [{ title: '库存金额', key: 'amount', type: 'money' as const }] : []),
        ]} />
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Space wrap size={[8, 8]}>
          <Tag>共 {rows.length} 个物料</Tag>
          {showCost && <Tag color="blue">库存总金额 {fmtMoney(totals.amount)}</Tag>}
          {totals.below > 0 && <Tag color="red">{totals.below} 项低于安全库存</Tag>}
          {totals.quarantine > 0 && <Tag color="gold">{totals.quarantine} 项有待检库存</Tag>}
        </Space>
      </div>
      <ResponsiveTable
        rowKey="material_id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />
    </>
  );
}

export default function Stock() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') === 'summary' ? 'summary' : 'detail');
  const [q, setQ] = useState(sp.get('q') || '');

  return (
    <>
      <PageHeader title="库存查询" sub="库存按 物料 + 库位 + 批号 + 质量状态 + 货主 分别记账，批号可点击查看追溯。" />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="只有“合格”库存可被领料/发货；待检库存需 IQC 判定。客供料（紫色“客供”标记）只能用于对应客户的订单。"
      />
      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'detail', label: '库存明细', children: <StockDetail q={q} onQ={setQ} /> },
            {
              key: 'summary',
              label: '库存汇总',
              children: <StockSummary onDrill={(code) => { setQ(code); setTab('detail'); }} />,
            },
          ]}
        />
      </Card>
    </>
  );
}
