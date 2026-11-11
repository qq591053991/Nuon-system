import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { ReloadOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { LocationSelect, WarehouseSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtMoney, fmtQty } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

const EXPIRING = [30, 60, 90].map((d) => ({ value: d, label: `${d} 天内到期` }));

/** 调拨弹窗 */
function TransferModal({ stock, onClose, onDone }: { stock: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (stock) {
      form.resetFields();
      form.setFieldsValue({ qty: stock.qty });
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
      await post('/stock/transfer', { stock_id: stock!.id, qty: v.qty, to_location_id: v.to_location_id, remark: v.remark });
      message.success('调拨完成');
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!stock} title="库位调拨 / 上架" onCancel={onClose} onOk={submit} okText="确认调拨" confirmLoading={saving} destroyOnHidden maskClosable={false}>
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
        <Form.Item name="to_location_id" label="目标库位" rules={[{ required: true, message: '请选择目标库位' }]}>
          <LocationSelect />
        </Form.Item>
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
  const [sp] = useSearchParams();
  const exp = sp.get('expiring_days');
  const { rows, loading, query, setQuery, reload, pagination } = usePaged('/stock', {
    q: q || undefined,
    status: sp.get('status') || undefined,
    expiring_days: exp ? Number(exp) : undefined,
  });
  const [moving, setMoving] = useState<Rec | null>(null);
  const [text, setText] = useState(q);

  // 从“库存汇总”点击进入时带入物料编码
  useEffect(() => {
    setText(q);
    if ((query.q || '') !== q) setQuery({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', key: 'material', fixed: 'left', width: 240,
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} />,
    },
    { title: '仓库', dataIndex: 'warehouse_name', width: 100 },
    { title: '库位', dataIndex: 'location_code', width: 90, render: (v) => <span className="mono">{v}</span> },
    { title: '批号', dataIndex: 'lot_no', width: 130, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '质量状态', dataIndex: 'status', width: 110, render: (v) => <StatusTag dict="stock_status" value={v} /> },
    { title: '数量', dataIndex: 'qty', width: 110, align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    {
      title: '货主', dataIndex: 'owner_customer_name', width: 160,
      render: (v) => (v ? <Space size={4}><CsTag name={v} /><Typography.Text ellipsis style={{ maxWidth: 110 }}>{v}</Typography.Text></Space> : <Typography.Text type="secondary">自有</Typography.Text>),
    },
    { title: '生产日期', dataIndex: 'mfg_date', width: 105, render: (v) => fmtDate(v) },
    { title: '有效期至', dataIndex: 'expiry_date', width: 140, render: (v) => <ExpiryDate value={v} /> },
    {
      title: '供应商 / 原厂批号', key: 'supplier', width: 180,
      render: (_, r) => (r.supplier_name || r.supplier_lot ? (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.supplier_name || '-'}</div>
          {r.supplier_lot && <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{r.supplier_lot}</Typography.Text>}
        </div>
      ) : '-'),
    },
    { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v) => fmtMoney(v) },
  ];
  if (can('wms')) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 80,
      render: (_, r) => <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => setMoving(r)}>调拨</Button>,
    });
  }

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder="物料编码 / 名称 / 批号" style={{ width: 240 }} value={text} onChange={(e) => setText(e.target.value)} onSearch={(v) => onQ(v.trim())} />
        <WarehouseSelect placeholder="全部仓库" style={{ width: 170 }} onChange={(v) => setQuery({ warehouse_id: v })} />
        <Select allowClear placeholder="质量状态" style={{ width: 140 }} defaultValue={sp.get('status') || undefined} options={dictOptions('stock_status')} onChange={(v) => setQuery({ status: v })} />
        <Select allowClear placeholder="效期预警" style={{ width: 140 }} defaultValue={exp ? Number(exp) : undefined} options={EXPIRING} onChange={(v) => setQuery({ expiring_days: v })} />
        <Button icon={<ReloadOutlined />} onClick={reload} />
      </Space>
      <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      <TransferModal stock={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />
    </>
  );
}

/** 库存汇总（按物料，分质量状态） */
function StockSummary({ onDrill }: { onDrill: (code: string) => void }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Rec>({ below_safety: false });

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

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', key: 'material', fixed: 'left', width: 260,
      render: (_, r) => (
        <MaterialCell
          code={r.material_code}
          name={r.material_name}
          spec={r.spec}
          extra={r.customer_supplied ? <CsTag /> : undefined}
        />
      ),
    },
    { title: '类别', dataIndex: 'category', width: 90, render: (v) => <StatusTag dict="material_category" value={v} /> },
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
    { title: '库存金额', dataIndex: 'amount', width: 120, align: 'right', render: (v) => fmtMoney(v) },
    {
      title: '', key: '_op', fixed: 'right', width: 90,
      render: (_, r) => <Button size="small" type="link" onClick={() => onDrill(r.material_code)}>批次明细</Button>,
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
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Space wrap size={[8, 8]}>
          <Tag>共 {rows.length} 个物料</Tag>
          <Tag color="blue">库存总金额 {fmtMoney(totals.amount)}</Tag>
          {totals.below > 0 && <Tag color="red">{totals.below} 项低于安全库存</Tag>}
          {totals.quarantine > 0 && <Tag color="gold">{totals.quarantine} 项有待检库存</Tag>}
        </Space>
      </div>
      <Table
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
