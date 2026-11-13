import { Alert, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Progress, Select, Space, Spin, Switch, Table, Tag, Typography, message, type InputRef, type TableColumnsType } from 'antd';
import { AuditOutlined, MobileOutlined, PlusOutlined, PrinterOutlined, ReloadOutlined, RollbackOutlined, SaveOutlined, StopOutlined, WifiOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { LocationSelect, MaterialSelect, WarehouseSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import ScanInput from '../../components/ScanInput';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { CsTag, LotLink, MaterialCell } from './common';
import { clearDraft, loadDraft, savedAgo, saveDraft, useLeaveGuard, type Draft } from './pda/kit';

const STATUS_OPTIONS = [
  { value: 'OPEN', label: '进行中' },
  { value: 'POSTED', label: '已过账' },
  { value: 'CANCELLED', label: '已作废' },
  { value: 'REVERSED', label: '已冲销' },
];

function Diff({ v }: { v?: number | null }) {
  if (v === null || v === undefined) return <span style={{ color: '#ccc' }}>未盘</span>;
  if (Math.abs(v) < 1e-9) return <span style={{ color: '#8c8c8c' }}>0</span>;
  return <b style={{ color: v > 0 ? '#389e0d' : '#cf1322' }}>{v > 0 ? '+' : ''}{fmtQty(v)}</b>;
}

const route = (ls: Rec[]) => [...ls].sort((a, b) => String(a.location_code).localeCompare(String(b.location_code))
  || String(a.material_code).localeCompare(String(b.material_code)) || String(a.lot_no).localeCompare(String(b.lot_no)) || a.id - b.id);

/** 新增盘盈行 */
function AddLineModal({ count, open, onClose, onDone }: { count: Rec; open: boolean; onClose: () => void; onDone: (r: Rec) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) form.resetFields(); }, [open, form]);
  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = await post(`/stock-counts/${count.id}/add-line`, { ...v, lot_no: v.lot_no?.trim() || null });
      message.success('已新增盘盈行');
      onDone(r);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} title="新增盘点行（账上没有的批次 / 盘盈）" onCancel={onClose} onOk={submit} okText="新增" confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="location_id" label="库位" rules={[{ required: true, message: '请选择库位' }]}>
          <LocationSelect params={{ warehouse_id: count.warehouse_id }} />
        </Form.Item>
        <Form.Item name="material_id" label="物料" rules={[{ required: true, message: '请选择物料' }]}><MaterialSelect /></Form.Item>
        <Form.Item name="lot_no" label="批号"><Input placeholder="扫描批次标签" /></Form.Item>
        <Form.Item name="counted_qty" label="实盘数量" rules={[{ required: true, message: '请输入实盘数量' }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
      </Form>
    </Modal>
  );
}

function CountDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const narrow = useNarrow(768);
  const [sign, signHolder] = useESign();
  const [modal, modalHolder] = Modal.useModal();
  const [d, setD] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<number, number | null>>({});
  const { user } = useAuth();
  const draftKind = `count-${id}`;
  const [restore, setRestore] = useState<Draft<Record<number, number | null>> | null>(null);
  // 未保存的实盘数暂存本机（刷新、锁屏后可恢复）
  useEffect(() => {
    if (!id || restore) return;
    if (Object.keys(edits).length) saveDraft(draftKind, user?.username, edits);
    else clearDraft(draftKind, user?.username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, id, restore]);
  useLeaveGuard(Object.keys(edits).length > 0);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [review, setReview] = useState(false);
  const [adding, setAdding] = useState(false);
  const inputs = useRef<Record<number, InputRef | null>>({});

  const load = (rev = review) => {
    if (!id) return;
    setLoading(true);
    get(`/stock-counts/${id}`, rev ? { review: 1 } : undefined)
      .then((r) => { setD(r); setEdits({}); })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setD(null);
    setOnlyDiff(false);
    setReview(false);
    load(false);
    const dr = id ? loadDraft<Record<number, number | null>>(`count-${id}`, user?.username) : null;
    setRestore(dr && Object.keys(dr.data || {}).length ? dr : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editable = d?.status === 'OPEN' && can('wms');
  const hidden = !!d?.book_hidden;
  const lines: Rec[] = useMemo(() => route(d?.lines || []).map((l: Rec) => {
    const c = l.id in edits ? edits[l.id] : l.counted_qty ?? null;
    const base = l.current_qty ?? l.system_qty;
    const diff = d?.status === 'OPEN'
      ? (c === null || c === undefined || base === null || base === undefined ? null : Math.round((c - base) * 10000) / 10000)
      : l.diff_qty;
    return { ...l, _counted: c, _diff: diff };
  }), [d, edits]);
  const shown = onlyDiff ? lines.filter((l) => l._diff !== 0) : lines;
  const doneCount = lines.filter((l) => l._counted !== null && l._counted !== undefined).length;
  const diffCount = lines.filter((l) => l._diff).length;
  const dirty = Object.keys(edits).length > 0;

  const save = async (silent = false) => {
    const body = Object.entries(edits).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => ({ id: Number(k), counted_qty: v }));
    if (!body.length) return d;
    const r = await put(`/stock-counts/${d!.id}/lines`, body);
    setD(r);
    setEdits({});
    if (!silent) message.success(`已保存 ${body.length} 行实盘数量`);
    return r;
  };

  const focusRow = (lineId: number) => setTimeout(() => { inputs.current[lineId]?.focus(); (inputs.current[lineId] as any)?.select?.(); }, 30);
  /** 回车：保存本行并跳到下一行输入框 */
  const nextRow = (idx: number) => {
    const nx = shown[idx + 1];
    if (nx) focusRow(nx.id);
  };

  const onScan = (_c: string, p: { raw: string; lot?: string }) => {
    const code = p.raw.trim().toUpperCase();
    const lot = (p.lot || p.raw).trim().toUpperCase();
    const hit = shown.find((l) => String(l.location_code).toUpperCase() === code && (l._counted === null || l._counted === undefined))
      ?? shown.find((l) => String(l.location_code).toUpperCase() === code)
      ?? shown.find((l) => String(l.lot_no).toUpperCase() === lot);
    if (!hit) return void message.error(`“${p.raw}” 不在本盘点单中（账上没有的批次请点“新增盘盈行”）`);
    document.querySelector(`[data-row-key="${hit.id}"]`)?.scrollIntoView({ block: 'center' });
    focusRow(hit.id);
  };

  const doPost = async () => {
    setBusy(true);
    try {
      const saved = (await save(true)) ?? d;
      const chk = await get(`/stock-counts/${saved!.id}`, { review: 1 });
      const unc = (chk.lines as Rec[]).filter((l) => l.counted_qty === null || l.counted_qty === undefined).length;
      const diffs = (chk.lines as Rec[]).filter((l) => l.diff_qty).length;
      const stale = (chk.lines as Rec[]).filter((l) => l.recount);
      if (stale.length) {
        modal.error({
          title: `有 ${stale.length} 行须重新清点`,
          content: <div>这些行录入实盘后又有收发/调拨，原录数已过时（表中红色“须重盘”）：<br />{stale.slice(0, 8).map((l) => `${l.location_code} ${l.material_code} ${l.lot_no || '-'}`).join('；')}</div>,
        });
        setD(await get(`/stock-counts/${saved!.id}`, review ? { review: 1 } : undefined));
        return;
      }
      let asBook = false;
      if (unc) {
        asBook = await modal.confirm({
          title: `还有 ${unc} 行未录入实盘`, okText: '未盘行按账面，过账', cancelText: '返回继续盘', okButtonProps: { danger: true },
          content: '确认后未盘行按当前账面处理（不调整库存），其余行按“实盘 − 当前账面”生成盘盈/盘亏调整。',
        });
        if (!asBook) return;
      } else {
        const ok = await modal.confirm({ title: '确认盘点过账？', okText: '过账', cancelText: '返回', content: `共 ${diffs} 行有差异，将按“实盘 − 当前账面”生成盘盈入库 / 盘亏出库，记入库存流水。过账后如有错误可“冲销”。` });
        if (!ok) return;
      }
      const r = await post(`/stock-counts/${saved!.id}/post`, { uncounted_as_book: asBook });
      setD(r);
      message.success(`盘点单 ${r.no} 已过账，${(r.lines as Rec[]).filter((l) => l.diff_qty).length} 行差异已生成库存调整`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const doCancel = () => {
    let reason = '';
    modal.confirm({
      title: `作废盘点单 ${d!.no}？`, okText: '作废', cancelText: '返回', okButtonProps: { danger: true },
      content: <div><p>作废后不能再录入或过账（不影响库存）。</p><Input placeholder="作废原因（可选）" onChange={(e) => { reason = e.target.value; }} /></div>,
      onOk: async () => {
        const r = await post(`/stock-counts/${d!.id}/cancel`, { reason: reason || null });
        setD(r);
        message.success('已作废');
        onChanged();
      },
    });
  };

  const doReverse = async () => {
    try {
      const r = await sign({
        meaning: '盘点单冲销', reasonRequired: true, reasonLabel: '冲销原因', reasonPlaceholder: '如：实盘录错，需重盘',
        description: `将按 ${d!.no} 的盘点调整流水逐笔反向，库存恢复到过账前（需调整入库的库存仍在库）。冲销记录不可删除。`,
        submit: (signature) => post(`/stock-counts/${d!.id}/reverse`, { reason: signature.reason, signature }),
      });
      setD(r);
      message.success(`盘点单 ${r.no} 已冲销`);
      onChanged();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  const columns: TableColumnsType<Rec> = [
    { title: '库位', dataIndex: 'location_code', width: 90, fixed: narrow ? undefined : 'left', render: (v) => <b className="mono">{v}</b> },
    {
      title: '物料', key: 'm', width: 220,
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', width: 120, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '质量状态', dataIndex: 'status', width: 100, render: (v) => <StatusTag dict="stock_status" value={v} /> },
    ...(hidden ? [] : [
      {
        title: d?.status === 'OPEN' ? '当前账面' : '录入时账面', key: 'book', width: 130, align: 'right' as const,
        render: (_: unknown, r: Rec) => (d?.status === 'OPEN' ? (
          <span title={r.moved ? `建单/录入时 ${fmtQty(r.system_qty)}，之后有收发/调拨` : undefined} style={{ color: r.moved ? '#d46b08' : undefined, fontWeight: r.moved ? 600 : undefined }}>
            {fmtQty(r.current_qty)}{r.moved ? `（原 ${fmtQty(r.system_qty)}）` : ''}
          </span>
        ) : fmtQty(r.system_qty)),
      },
    ]),
    {
      title: '实盘数（回车下一行）', key: 'counted', width: 150, align: 'right',
      render: (_, r, idx) => (editable ? (
        <InputNumber
          ref={(el) => { inputs.current[r.id] = el as unknown as InputRef; }}
          min={0}
          value={r._counted}
          placeholder="录入"
          style={{ width: 120, background: r.id in edits ? '#e6f4ff' : undefined }}
          onChange={(v) => setEdits((e) => ({ ...e, [r.id]: v === null ? null : Number(v) }))}
          onPressEnter={() => nextRow(idx)}
        />
      ) : <b>{fmtQty(r._counted)}</b>),
    },
    {
      title: '提示', key: 'flag', width: 150,
      render: (_, r) => (r.recount && !(r.id in edits)
        ? <Tag color="red">录入后有收发，须重盘</Tag>
        : r.moved && (r.counted_qty === null || r.counted_qty === undefined) ? <Tag color="orange">建单后有收发</Tag> : null),
    },
    ...(hidden ? [] : [{ title: d?.status === 'OPEN' ? '差异' : '调整量', key: 'diff', width: 90, align: 'right' as const, render: (_: unknown, r: Rec) => <Diff v={r._diff} /> }]),
  ];

  const statusExtra = d && (
    <Space wrap>
      <Button icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/count/${d.id}`, '_blank')}>打印盘点表</Button>
      {editable && <Button icon={<WifiOutlined />} onClick={() => nav('/wms/rfid/count')}>RFID 盘点（手持读写器）</Button>}
      {editable && <Button icon={<MobileOutlined />} onClick={() => nav(`/wms/pda/count/${d.id}`)}>条码盘点（兜底）</Button>}
      {editable && <Button icon={<SaveOutlined />} disabled={!dirty} onClick={() => save()}>保存实盘</Button>}
      {editable && <Button danger icon={<StopOutlined />} onClick={doCancel}>作废</Button>}
      {editable && <Button type="primary" icon={<AuditOutlined />} loading={busy} onClick={doPost}>过账</Button>}
      {d.status === 'POSTED' && can('wms') && <Button danger icon={<RollbackOutlined />} onClick={doReverse}>冲销</Button>}
    </Space>
  );

  return (
    <Drawer
      open={!!id}
      width={narrow ? '100%' : 1080}
      onClose={() => {
        if (dirty) Modal.confirm({ title: '有未保存的实盘数量', content: '关闭将丢失本次录入，确定关闭？', okText: '关闭', cancelText: '继续录入', onOk: onClose });
        else onClose();
      }}
      destroyOnHidden
      title={d && <Space wrap>盘点单 <span className="mono">{d.no}</span><StatusTag dict="doc_status" value={d.status} />{d.blind && <Tag color="purple">盲盘</Tag>}</Space>}
      extra={!narrow && statusExtra}
    >
      {signHolder}
      {modalHolder}
      <Spin spinning={loading}>
        {d && (
          <>
            {narrow && <div style={{ marginBottom: 12 }}>{statusExtra}</div>}
            <Descriptions size="small" column={narrow ? 1 : 3} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="仓库">{d.warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="范围">{d.range_codes?.length ? d.range_codes.join('、') : '整仓'}</Descriptions.Item>
              <Descriptions.Item label="创建">{d.created_by} · {fmtDateTime(d.created_at)}</Descriptions.Item>
              <Descriptions.Item label="过账">{d.posted_by ? `${d.posted_by} · ${fmtDateTime(d.posted_at)}` : '-'}</Descriptions.Item>
              {d.reversed_by && <Descriptions.Item label="冲销">{d.reversed_by} · {fmtDateTime(d.reversed_at)} · {d.reverse_reason}</Descriptions.Item>}
              {d.remark && <Descriptions.Item label="备注">{d.remark}</Descriptions.Item>}
            </Descriptions>
            {editable && restore && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                message={`有未保存的实盘数 ${Object.keys(restore.data).length} 行（暂存于 ${savedAgo(restore.saved_at)}）`}
                action={(
                  <Space>
                    <Button type="primary" onClick={() => { setEdits(restore.data); setRestore(null); message.success('已恢复，请核对后“保存实盘”'); }}>恢复</Button>
                    <Button onClick={() => { clearDraft(draftKind, user?.username); setRestore(null); }}>丢弃</Button>
                  </Space>
                )} />
            )}
            {editable && d.recount_count > 0 && (
              <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`${d.recount_count} 行录入实盘后又有收发/调拨，原录数已过时，请重新清点并录入（红色“须重盘”）。`} />
            )}
            {editable && d.moved_count > d.recount_count && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${d.moved_count - d.recount_count} 行在建单后有收发/调拨（橙色）：请按现在的实物清点${hidden ? '' : '；过账按“实盘 − 当前账面”调整'}。`} />
            )}
            {editable && (
              <Space wrap style={{ marginBottom: 12, width: '100%' }}>
                <ScanInput onScan={onScan} autoFocus={false} size="middle" placeholder="扫库位 / 批号定位到行" style={{ width: 260 }} />
                <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>新增盘盈行</Button>
                {d.blind && <Space size={6}><Switch checked={review} onChange={(v) => { setReview(v); load(v); }} /><span>复核：显示账面与差异</span></Space>}
              </Space>
            )}
            <Space wrap size={16} style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <span>盘点进度</span>
                <Progress percent={lines.length ? Math.round((doneCount / lines.length) * 100) : 0} size="small" style={{ width: 160, margin: 0 }} />
                <Typography.Text type="secondary">{doneCount} / {lines.length} 行</Typography.Text>
                {!hidden && diffCount > 0 && <Tag color="orange">{diffCount} 行有差异</Tag>}
              </Space>
              {!hidden && <Button size="small" type={onlyDiff ? 'primary' : 'default'} onClick={() => setOnlyDiff((v) => !v)}>{onlyDiff ? '显示全部' : '只看差异 / 未盘'}</Button>}
            </Space>
            {editable && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message={`明细已按库位路线排序。输入实盘数后按回车跳到下一行；可分多次保存。${hidden ? '盲盘：录入时不显示账面，复核时打开“显示账面与差异”。' : ''}过账按“实盘 − 过账时当前账面”调整。`} />
            )}
            <Table rowKey="id" size="small" columns={columns} dataSource={shown} pagination={false} scroll={{ x: 'max-content', y: narrow ? undefined : 520 }} />
            <AddLineModal count={d} open={adding} onClose={() => setAdding(false)} onDone={(r) => setD(r)} />
          </>
        )}
      </Spin>
    </Drawer>
  );
}

export default function StockCounts() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const { rows, loading, reload, pagination, query, setQuery, onTableChange } = usePaged('/stock-counts', { status: sp.get('status') || undefined });
  const [currentId, setCurrentId] = useState<number | null>(sp.get('id') ? Number(sp.get('id')) : null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const whId = Form.useWatch('warehouse_id', form);

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
      const c = await post('/stock-counts', { ...v, location_ids: v.location_ids?.length ? v.location_ids : null, blind: !!v.blind });
      message.success(`盘点单 ${c.no} 已生成，共 ${c.lines?.length ?? 0} 行账面库存`);
      setCreating(false);
      reload();
      setCurrentId(c.id);
    } finally {
      setSaving(false);
    }
  };

  const columns: RColumn[] = [
    { title: '盘点单号', dataIndex: 'no', width: 130, sorter: true, mobile: 'title', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
    { title: '仓库', dataIndex: 'warehouse_name', width: 140 },
    { title: '范围', dataIndex: 'location_ids', width: 90, render: (v, r) => <>{v ? '指定库位' : '整仓'}{r.blind ? <Tag color="purple" style={{ marginLeft: 4 }}>盲盘</Tag> : null}</> },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag dict="doc_status" value={v} /> },
    { title: '创建人', dataIndex: 'created_by', width: 90 },
    { title: '创建时间', dataIndex: 'created_at', width: 140, sorter: true, render: (v) => fmtDateTime(v) },
    { title: '过账人', dataIndex: 'posted_by', width: 90, mobile: 'hidden', render: (v) => v || '-' },
    { title: '过账时间', dataIndex: 'posted_at', width: 140, mobile: 'hidden', render: (v) => fmtDateTime(v) },
    { title: '备注', dataIndex: 'remark', ellipsis: true, mobile: 'hidden', render: (v) => v || '-' },
  ];

  return (
    <>
      <PageHeader
        title="库存盘点"
        sub="按仓库或库位范围生成账面快照 → 按库位逐行录入实盘 → 过账按“实盘 − 当前账面”生成盘盈/盘亏调整。"
        extra={can('wms') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreating(true); }}>新建盘点</Button>
        )}
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="同一库位同时只能有一张进行中的盘点单；盘点期间发生的收发会在明细中标出，过账按过账时的当前账面计算差异，不会重复调整。建错的盘点单可作废，过账错误可冲销。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="盘点单号" style={{ width: 200 }} onSearch={(q) => setQuery({ q: q.trim() || undefined })} />
          <Select allowClear placeholder="状态" style={{ width: 130 }} defaultValue={sp.get('status') || undefined} options={STATUS_OPTIONS} onChange={(v) => setQuery({ status: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          <ExportButton url="/stock-counts" params={query} filename="盘点单" columns={[
            { title: '盘点单号', key: 'no' }, { title: '仓库', key: 'warehouse_name' }, { title: '范围', value: (r) => (r.location_ids ? '指定库位' : '整仓') },
            { title: '盲盘', value: (r) => (r.blind ? '是' : '') }, { title: '状态', value: (r) => dictLabel('doc_status', r.status) },
            { title: '创建人', key: 'created_by' }, { title: '创建时间', key: 'created_at', type: 'datetime' }, { title: '过账人', key: 'posted_by' },
            { title: '过账时间', key: 'posted_at', type: 'datetime' }, { title: '备注', key: 'remark' },
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
      <Modal open={creating} title="新建盘点单" onCancel={() => setCreating(false)} onOk={create} okText="生成盘点单" confirmLoading={saving} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="warehouse_id" label="盘点仓库" rules={[{ required: true, message: '请选择仓库' }]}>
            <WarehouseSelect onChange={() => form.setFieldsValue({ location_ids: [] })} />
          </Form.Item>
          <Form.Item name="location_ids" label="库位范围（留空 = 整仓）" extra="只盘几个库位（如防潮柜循环盘点）时选择；同一库位同时只能有一张进行中的盘点单。">
            <LocationSelect mode="multiple" params={{ warehouse_id: whId }} disabled={!whId} placeholder={whId ? '可扫库位条码多选' : '请先选择仓库'} />
          </Form.Item>
          <Form.Item name="blind" label="盲盘" valuePropName="checked" extra="录入时不显示账面数，防止照抄；复核时再显示差异。">
            <Switch />
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
