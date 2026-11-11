import { Alert, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Progress, Space, Spin, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { AuditOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { WarehouseSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { CsTag, LotLink, MaterialCell } from './common';

function Diff({ v }: { v?: number | null }) {
  if (v === null || v === undefined) return <span style={{ color: '#ccc' }}>未盘</span>;
  if (Math.abs(v) < 1e-9) return <span style={{ color: '#8c8c8c' }}>0</span>;
  return <b style={{ color: v > 0 ? '#389e0d' : '#cf1322' }}>{v > 0 ? '+' : ''}{fmtQty(v)}</b>;
}

function CountDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [d, setD] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<number, number | null>>({});
  const [onlyDiff, setOnlyDiff] = useState(false);

  const load = () => {
    if (!id) return;
    setLoading(true);
    get(`/stock-counts/${id}`)
      .then((r) => {
        setD(r);
        setEdits({});
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setD(null);
    setOnlyDiff(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editable = d?.status === 'OPEN' && can('wms');
  const counted = (l: Rec): number | null => (l.id in edits ? edits[l.id] : l.counted_qty ?? null);
  const lines: Rec[] = useMemo(() => (d?.lines || []).map((l: Rec) => {
    const c = l.id in edits ? edits[l.id] : l.counted_qty ?? null;
    return { ...l, _counted: c, _diff: c === null || c === undefined ? null : Math.round((c - l.system_qty) * 10000) / 10000 };
  }), [d, edits]);
  const doneCount = lines.filter((l) => l._counted !== null && l._counted !== undefined).length;
  const diffCount = lines.filter((l) => l._diff).length;
  const dirty = Object.keys(edits).length > 0;

  const save = async (silent = false) => {
    const body = Object.entries(edits)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => ({ id: Number(k), counted_qty: v }));
    if (!body.length) return d;
    const r = await put(`/stock-counts/${d!.id}/lines`, body);
    setD(r);
    setEdits({});
    if (!silent) message.success(`已保存 ${body.length} 行实盘数量`);
    return r;
  };

  const doPost = async () => {
    if (doneCount < lines.length) {
      message.warning(`还有 ${lines.length - doneCount} 行未录入实盘数量，全部盘点后才能过账`);
      return;
    }
    setBusy(true);
    try {
      await save(true);
      const r = await post(`/stock-counts/${d!.id}/post`);
      setD(r);
      message.success(`盘点单 ${r.no} 已过账，${diffCount} 行差异已生成库存调整`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<Rec> = [
    { title: '库位', dataIndex: 'location_code', width: 90, fixed: 'left', render: (v) => <b className="mono">{v}</b> },
    {
      title: '物料', key: 'm', width: 220,
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', width: 120, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '质量状态', dataIndex: 'status', width: 110, render: (v) => <StatusTag dict="stock_status" value={v} /> },
    { title: '账面数', dataIndex: 'system_qty', width: 100, align: 'right', render: (v, r) => <span>{fmtQty(v)} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.uom}</Typography.Text></span> },
    {
      title: '实盘数', key: 'counted', width: 140, align: 'right',
      render: (_, r) => (editable ? (
        <InputNumber
          min={0}
          value={counted(r)}
          placeholder="录入"
          style={{ width: 120, background: r.id in edits ? '#e6f4ff' : undefined }}
          onChange={(v) => setEdits((e) => ({ ...e, [r.id]: v === null ? null : Number(v) }))}
        />
      ) : <b>{fmtQty(r._counted)}</b>),
    },
    { title: '差异', key: 'diff', width: 90, align: 'right', render: (_, r) => <Diff v={r._diff} /> },
  ];

  return (
    <Drawer
      open={!!id}
      width={980}
      onClose={() => {
        if (dirty) {
          Modal.confirm({ title: '有未保存的实盘数量', content: '关闭将丢失本次录入，确定关闭？', okText: '关闭', cancelText: '继续录入', onOk: onClose });
        } else onClose();
      }}
      destroyOnHidden
      title={d && <Space>盘点单 <span className="mono">{d.no}</span><StatusTag dict="doc_status" value={d.status} /></Space>}
      extra={editable && (
        <Space>
          <Button icon={<SaveOutlined />} disabled={!dirty} onClick={() => save()}>保存实盘</Button>
          <Popconfirm
            title="确认盘点过账？"
            description={(
              <div style={{ maxWidth: 320 }}>
                系统将按“实盘数 − 账面数”自动生成盘点调整（盘盈入库 / 盘亏出库），共 <b>{diffCount}</b> 行差异，
                记入库存流水，过账后不可撤销。
              </div>
            )}
            okText="过账"
            onConfirm={doPost}
          >
            <Button type="primary" icon={<AuditOutlined />} loading={busy}>过账</Button>
          </Popconfirm>
        </Space>
      )}
    >
      <Spin spinning={loading}>
        {d && (
          <>
            <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="仓库">{d.warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="创建">{d.created_by} · {fmtDateTime(d.created_at)}</Descriptions.Item>
              <Descriptions.Item label="过账">{d.posted_by ? `${d.posted_by} · ${fmtDateTime(d.posted_at)}` : '-'}</Descriptions.Item>
              {d.remark && <Descriptions.Item label="备注" span={3}>{d.remark}</Descriptions.Item>}
            </Descriptions>
            <Space wrap size={16} style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <span>盘点进度</span>
                <Progress percent={lines.length ? Math.round((doneCount / lines.length) * 100) : 0} size="small" style={{ width: 180, margin: 0 }} />
                <Typography.Text type="secondary">{doneCount} / {lines.length} 行</Typography.Text>
                {diffCount > 0 && <Tag color="orange">{diffCount} 行有差异</Tag>}
              </Space>
              <Button size="small" type={onlyDiff ? 'primary' : 'default'} onClick={() => setOnlyDiff((v) => !v)}>
                {onlyDiff ? '显示全部' : '只看差异 / 未盘'}
              </Button>
            </Space>
            {editable && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message="按库位逐行清点实物并录入“实盘数”，可分多次保存；全部录完后点击“过账”生成差异调整。" />
            )}
            <Table
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={onlyDiff ? lines.filter((l) => l._diff !== 0) : lines}
              pagination={false}
              scroll={{ x: 'max-content', y: 560 }}
            />
          </>
        )}
      </Spin>
    </Drawer>
  );
}

export default function StockCounts() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const { rows, loading, reload, pagination } = usePaged('/stock-counts');
  const [currentId, setCurrentId] = useState<number | null>(sp.get('id') ? Number(sp.get('id')) : null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const closeDrawer = () => {
    setCurrentId(null);
    if (sp.get('id')) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const create = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const c = await post('/stock-counts', v);
      message.success(`盘点单 ${c.no} 已生成，共 ${c.lines?.length ?? 0} 行账面库存`);
      setCreating(false);
      reload();
      setCurrentId(c.id);
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<Rec> = [
    { title: '盘点单号', dataIndex: 'no', width: 130, render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
    { title: '仓库', dataIndex: 'warehouse_name', width: 140 },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag dict="doc_status" value={v} /> },
    { title: '创建人', dataIndex: 'created_by', width: 90 },
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v) => fmtDateTime(v) },
    { title: '过账人', dataIndex: 'posted_by', width: 90, render: (v) => v || '-' },
    { title: '过账时间', dataIndex: 'posted_at', width: 140, render: (v) => fmtDateTime(v) },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v) => v || '-' },
  ];

  return (
    <>
      <PageHeader
        title="库存盘点"
        sub="按仓库生成账面快照 → 录入实盘数 → 过账自动生成盘盈/盘亏调整。"
        extra={can('wms') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreating(true); }}>新建盘点</Button>
        )}
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="盘点期间建议暂停该仓库的收发作业；盘点差异通过“盘点调整”记入库存流水，可追溯到盘点单与操作人。" />
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
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
      <Modal open={creating} title="新建盘点单" onCancel={() => setCreating(false)} onOk={create} okText="生成盘点单" confirmLoading={saving} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="warehouse_id" label="盘点仓库" rules={[{ required: true, message: '请选择仓库' }]} extra="系统将该仓库当前所有库存（按库位/批号/状态）生成盘点明细。">
            <WarehouseSelect />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input placeholder="如：2026 年 11 月月度盘点" />
          </Form.Item>
        </Form>
      </Modal>
      <CountDrawer id={currentId} onClose={closeDrawer} onChanged={reload} />
    </>
  );
}
