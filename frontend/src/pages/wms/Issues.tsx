import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag, Typography, message, type InputRef, type TableColumnsType } from 'antd';
import { CheckOutlined, MobileOutlined, PrinterOutlined, ReloadOutlined, RollbackOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import RemoteSelect, { LocationSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import ScanInput, { type ScanInputHandle } from '../../components/ScanInput';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

const isReturn = (r?: Rec | null) => r?.issue_type === 'RETURN';
const docName = (r?: Rec | null) => (isReturn(r) ? '退料单' : '领料单');
const picked = (l: Rec) => l.picked_qty !== null && l.picked_qty !== undefined;

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '待过账' },
  { value: 'CONFIRMED', label: '已过账' },
  { value: 'CANCELLED', label: '已作废' },
  { value: 'REVERSED', label: '已冲销' },
];

/** 单据动作：待过账 → 拣料 / 过账 / 作废；已过账 → 冲销（电子签名 + 原因） */
function IssueActions({ row, onChanged, size = 'small', compact = false, inList = false }: { row: Rec; onChanged: (r: Rec) => void; size?: 'small' | 'middle' | 'large'; compact?: boolean; inList?: boolean }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [modal, holder] = Modal.useModal();
  const [sign, signHolder] = useESign();
  const lines: Rec[] = row.lines || [];
  const nPicked = lines.filter(picked).length;

  const doConfirm = async () => {
    const left = lines.length - nPicked;
    const partial = nPicked > 0 && left > 0;
    const unverified = !isReturn(row) && nPicked === 0;
    const ok = await modal.confirm({
      title: partial ? `部分过账（已拣 ${nPicked} 行，未拣 ${left} 行）？` : unverified ? '不核对实物，全部过账？' : '确认过账？',
      okText: partial ? '部分过账' : unverified ? '不核对，全部过账' : '过账', cancelText: '返回',
      // 未扫码核对时默认焦点在“返回”，防止扫码枪的回车误确认
      autoFocusButton: unverified ? 'cancel' : 'ok',
      content: isReturn(row)
        ? '请确认退料实物已清点并放回指定库位。过账后库存加回“合格”，并扣减工单已领数量。如有错误可“冲销”。'
        : partial
          ? '已拣行扣减库存；未拣行转入新的领料单，稍后再拣。'
          : nPicked
            ? '已全部拣齐。过账后扣减库存，批次与工单绑定用于追溯；如有错误可“冲销”。'
            : '尚未扫码拣料，将按拣料单数量全部过账（建议先用“拣料”逐行扫码核对）。过账后扣减库存，如有错误可“冲销”。',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post(`/issues/${row.id}/confirm`, { partial });
      message.success(isReturn(row) ? `退料单 ${row.no} 已过账，物料已退回合格库存` : `领料单 ${row.no} 已过账，库存已扣减${partial ? '；未拣行已转入新领料单' : ''}`);
      onChanged(r);
    } finally {
      setBusy(false);
    }
  };
  const doCancel = async () => {
    const ok = await modal.confirm({ title: `作废${docName(row)} ${row.no}？`, content: '作废后该单不能再拣料或过账（不影响库存）。', okText: '作废', cancelText: '返回', okButtonProps: { danger: true } });
    if (!ok) return;
    const r = await post(`/issues/${row.id}/cancel`);
    message.success(`${docName(row)} ${row.no} 已作废`);
    onChanged(r);
  };
  const doReverse = async () => {
    try {
      const r = await sign({
        meaning: `${docName(row)}冲销`, reasonRequired: true, reasonLabel: '冲销原因', reasonPlaceholder: '如：领错工单 / 数量录错',
        description: isReturn(row)
          ? `冲销 ${row.no}：已退回的物料从库存扣回，工单已领数量恢复。`
          : `冲销 ${row.no}：物料按原批次、原库位加回合格库存，工单已领数量扣回。已装配或已退料的批次不能冲销。`,
        submit: (signature) => post(`/issues/${row.id}/reverse`, { reason: signature.reason, signature }),
      });
      message.success(`${docName(row)} ${row.no} 已冲销`);
      onChanged(r);
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  const draft = row.status === 'DRAFT';
  // 冲销只放在明细里（列表行不放危险操作）
  if (!draft && (inList || !(row.status === 'CONFIRMED' && can('wms')))) return null;
  return (
    <Space size={4} wrap onClick={(e) => e.stopPropagation()}>
      {holder}
      {signHolder}
      {draft && !isReturn(row) && can('wms') && (
        <Button size={size} icon={<MobileOutlined />} onClick={() => nav(`/wms/pda/pick/${row.id}`)}>{compact ? '拣料' : `扫码拣料${nPicked ? `（${nPicked}/${lines.length}）` : ''}`}</Button>
      )}
      {draft && can('wms') && (
        <Button size={size} type={!isReturn(row) && !nPicked ? 'default' : 'primary'} icon={<CheckOutlined />} loading={busy} onClick={doConfirm}>
          {!isReturn(row) && !nPicked && !compact ? '不核对，全部过账' : '过账'}
        </Button>
      )}
      {draft && can('wms', 'plan') && !compact && <Button size={size} danger icon={<StopOutlined />} disabled={busy} onClick={doCancel}>作废</Button>}
      {row.status === 'CONFIRMED' && can('wms') && !compact && <Button size={size} danger icon={<UndoOutlined />} onClick={doReverse}>冲销</Button>}
    </Space>
  );
}

function IssueDrawer({ issue, onClose, onChanged }: { issue: Rec | null; onClose: () => void; onChanged: (r: Rec) => void }) {
  const narrow = useNarrow(768);
  // 按库位排序，便于仓管按路线拣料
  const lines = useMemo(
    () => [...(issue?.lines || [])].sort((a: Rec, b: Rec) => String(a.location_code).localeCompare(String(b.location_code)) || String(a.material_code).localeCompare(String(b.material_code))),
    [issue],
  );
  // 窄屏（手机）自动变卡片：库位 · 物料 · 批号 · 数量
  const columns: RColumn[] = [
    { title: '#', key: 'idx', width: 40, mobile: 'hidden', render: (_, __, i) => i + 1 },
    { title: '库位', dataIndex: 'location_code', width: 90, render: (v) => <b className="mono" style={{ fontSize: 15 }}>{v}</b> },
    {
      title: '物料', key: 'm', mobile: 'title',
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: isReturn(issue) ? '退料数' : '应拣', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    ...(isReturn(issue) ? [] : [{ title: '实拣', dataIndex: 'picked_qty', align: 'right' as const, render: (v: number | null) => (v === null || v === undefined ? <Typography.Text type="secondary">未拣</Typography.Text> : <b style={{ color: '#389e0d' }}>{fmtQty(v)}</b>) }]),
    { title: '有效期至', dataIndex: 'expiry_date', render: (v) => <ExpiryDate value={v} /> },
  ];
  const actions = issue && (
    <Space wrap>
      <Button icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/issue/${issue.id}`, '_blank')}>打印{isReturn(issue) ? '退料单' : '拣料单'}</Button>
      <IssueActions row={issue} onChanged={onChanged} size="middle" />
    </Space>
  );
  return (
    <Drawer
      open={!!issue}
      width={narrow ? '100%' : 900}
      onClose={onClose}
      title={issue && <Space wrap>{docName(issue)} <span className="mono">{issue.no}</span><StatusTag dict="doc_status" value={issue.status} /></Space>}
      extra={!narrow && actions}
      destroyOnHidden
    >
      {issue && (
        <>
          {narrow && <div style={{ marginBottom: 12 }}>{actions}</div>}
          <Descriptions size="small" column={narrow ? 1 : 2} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="生产工单"><Link to={`/mes/work-orders/${issue.wo_id}`}>{issue.wo_no}</Link></Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag dict="doc_status" value={issue.status} /></Descriptions.Item>
            <Descriptions.Item label="制单">{issue.created_by || '-'} · {fmtDateTime(issue.created_at)}</Descriptions.Item>
            <Descriptions.Item label="过账">{issue.confirmed_by ? `${issue.confirmed_by} · ${fmtDateTime(issue.confirmed_at)}` : '-'}</Descriptions.Item>
            {issue.reversed_by && <Descriptions.Item label="冲销" span={2}>{issue.reversed_by} · {fmtDateTime(issue.reversed_at)} · {issue.reverse_reason}</Descriptions.Item>}
            {issue.remark && <Descriptions.Item label="备注" span={2}>{issue.remark}</Descriptions.Item>}
          </Descriptions>
          {issue.status === 'DRAFT' && !isReturn(issue) && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="拣料清单已按库位排序（先到期先出）。建议点“扫码拣料”逐行扫库位/批号核对；实物不够时改实拣数，系统自动从下一批补足，可部分过账。" />
          )}
          {issue.status === 'DRAFT' && isReturn(issue) && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="退料：请清点实物、核对批号，放回下列库位后点击“过账”。过账后库存加回“合格”，工单已领数量相应减少。" />
          )}
          <ResponsiveTable rowKey="id" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
            共 {lines.length} 行。{isReturn(issue) ? '客供料退回原客户货主名下；退料批次只能是本工单已领用的批次。' : '客供料（紫色标记）只能用于对应客户的工单；过期批次系统不会推荐。'}
          </Typography.Paragraph>
        </>
      )}
    </Drawer>
  );
}

/** 新建生产退料单：选工单 → 列出该工单已领批次（可退数量 = 已领 − 已退 − 未过账退料）→ 扫物料/批号定位到行，填退料数量与库位 */
function ReturnModal({ open, woId: initWo, onClose, onDone }: { open: boolean; woId?: number; onClose: () => void; onDone: (r: Rec) => void }) {
  const narrow = useNarrow(768);
  const [woId, setWoId] = useState<number | undefined>(initWo);
  const [lots, setLots] = useState<Rec[]>([]);
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [loc, setLoc] = useState<Record<string, number | undefined>>({});
  const [remark, setRemark] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hit, setHit] = useState<string | null>(null);
  const inputs = useRef<Record<string, InputRef | null>>({});
  const locateRef = useRef<ScanInputHandle>(null);
  const keyOf = (l: Rec) => `${l.material_id}|${l.lot_no}|${l.owner_customer_id ?? ''}`;

  useEffect(() => {
    if (open) {
      setWoId(initWo);
      setRemark('');
      setHit(null);
    }
  }, [open, initWo]);

  useEffect(() => {
    setLots([]);
    setQty({});
    setLoc({});
    if (!open || !woId) return;
    setLoading(true);
    get<Rec[]>(`/work-orders/${woId}/returnable`)
      .then((d) => {
        setLots(d);
        setLoc(Object.fromEntries(d.map((l) => [keyOf(l), l.location_id])));
        // 选中工单后焦点直接进“扫物料 / 批号定位”框
        setTimeout(() => locateRef.current?.focus(), 120);
      })
      .finally(() => setLoading(false));
  }, [open, woId]);

  const picked = lots.filter((l) => (qty[keyOf(l)] ?? 0) > 0);

  /** 扫物料编码或批号 → 定位到该行并聚焦“本次退料” */
  const onScan = (_c: string, p: { raw: string; lot?: string }) => {
    const code = p.raw.trim().toUpperCase();
    const lot = (p.lot || p.raw).trim().toUpperCase();
    const cands = lots.filter((l) => String(l.lot_no).toUpperCase() === lot || String(l.material_code).toUpperCase() === code).filter((l) => l.returnable_qty > 0);
    if (!cands.length) return void message.error(`“${p.raw}” 不是本工单已领的批次/物料（或已无可退数量）`);
    const l = cands[0];
    if (cands.length > 1) message.info(`${l.material_code} 有 ${cands.length} 个批次，已定位到第一个；扫批号可精确定位`);
    const k = keyOf(l);
    setHit(k);
    document.querySelector(`[data-row-key="${k}"]`)?.scrollIntoView({ block: 'center' });
    setTimeout(() => inputs.current[k]?.focus(), 50);
  };

  const submit = async () => {
    if (!woId) return void message.warning('请选择生产工单');
    if (!picked.length) return void message.warning('请至少填写一行退料数量');
    const noLoc = picked.find((l) => !loc[keyOf(l)]);
    if (noLoc) return void message.warning(`请选择 ${noLoc.material_code} 的退回库位`);
    setSaving(true);
    try {
      const r = await post(`/work-orders/${woId}/returns`, {
        remark: remark || null,
        lines: picked.map((l) => ({ material_id: l.material_id, lot_no: l.lot_no, owner_customer_id: l.owner_customer_id ?? null, location_id: loc[keyOf(l)], qty: qty[keyOf(l)] })),
      });
      message.success(`退料单 ${r.no} 已生成，请清点实物后过账`);
      onDone(r);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const qtyInput = (r: Rec) => (
    <InputNumber ref={(el) => { inputs.current[keyOf(r)] = el as unknown as InputRef; }} min={0} max={r.returnable_qty} style={{ width: narrow ? '100%' : 110 }}
      size={narrow ? 'large' : 'middle'} disabled={!r.returnable_qty} value={qty[keyOf(r)] ?? null}
      placeholder={r.returnable_qty ? `≤ ${fmtQty(r.returnable_qty)}` : '已无可退'} onChange={(v) => setQty((q) => ({ ...q, [keyOf(r)]: v as number | null }))} />
  );
  const locInput = (r: Rec) => (
    <LocationSelect style={{ width: narrow ? '100%' : 190 }} value={loc[keyOf(r)]} disabled={!r.returnable_qty} onChange={(v) => setLoc((m) => ({ ...m, [keyOf(r)]: v as number | undefined }))} />
  );

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', key: 'm',
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '已领', dataIndex: 'issued_qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} /> },
    { title: '已退', dataIndex: 'returned_qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '待过账退料', dataIndex: 'pending_qty', align: 'right', render: (v) => (v ? <Typography.Text type="warning">{fmtQty(v)}</Typography.Text> : '-') },
    { title: '可退', dataIndex: 'returnable_qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    { title: '本次退料', key: 'qty', width: 120, render: (_, r) => qtyInput(r) },
    { title: '退回库位', key: 'loc', width: 200, render: (_, r) => locInput(r) },
  ];

  return (
    <Modal open={open} width={narrow ? '100%' : 1150} style={narrow ? { top: 0, maxWidth: '100vw', padding: 0 } : undefined}
      title={<span><RollbackOutlined style={{ marginRight: 8 }} />新建生产退料单</span>} okText="生成退料单" cancelText="返回"
      confirmLoading={saving} onOk={submit} onCancel={onClose} destroyOnHidden maskClosable={false} okButtonProps={{ size: narrow ? 'large' : 'middle' }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="只能退回本工单已领用的批次，数量不超过“已领 − 已退 − 未过账退料”。退料只退回合格品库位（默认原领料库位）；不良物料请开具 NCR，不走退料。" />
      <Space direction={narrow ? 'vertical' : 'horizontal'} wrap style={{ marginBottom: 12, width: '100%' }}>
        <RemoteSelect url="/work-orders" noun="工单" matchKeys={['no']} params={{ status: 'RELEASED,IN_PROGRESS,COMPLETED' }} style={{ width: narrow ? '100%' : 360 }} value={woId}
          onChange={(v) => setWoId(v as number | undefined)} placeholder="扫描或搜索工单号 / 产品"
          labelOf={(r) => `${r.no} ${r.material_code} ${r.material_name}（${r.lot_no ?? ''}）`} />
        <Input style={{ width: narrow ? '100%' : 360 }} placeholder="退料原因 / 备注（如：工单完工剩余）" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Space>
      {woId && lots.length > 0 && <ScanInput ref={locateRef} onScan={onScan} autoFocus={false} size={narrow ? 'large' : 'middle'} placeholder="扫物料编码 / 批号定位到行" style={{ marginBottom: 12 }} />}
      {loading ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div> : woId ? (
        narrow ? (
          lots.length ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              {lots.map((l) => (
                <Card key={keyOf(l)} size="small" data-row-key={keyOf(l)} style={{ borderColor: hit === keyOf(l) ? '#1677ff' : undefined }}>
                  <MaterialCell code={l.material_code} name={l.material_name} spec={l.material_spec} extra={l.owner_customer_id ? <CsTag /> : undefined} />
                  <div>批号 <b className="mono">{l.lot_no || '-'}</b> · 已领 {fmtQty(l.issued_qty)} · 可退 <b>{fmtQty(l.returnable_qty)}</b> {l.uom}</div>
                  <div style={{ marginTop: 6 }}>本次退料（{l.material_code}）</div>{qtyInput(l)}
                  <div style={{ marginTop: 6 }}>退回库位</div>{locInput(l)}
                </Card>
              ))}
            </Space>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该工单没有已过账的领料" />
        ) : (
          <Table rowKey={keyOf} size="small" columns={columns} dataSource={lots} pagination={false} scroll={{ x: 'max-content' }}
            rowClassName={(r) => (hit === keyOf(r) ? 'ant-table-row-selected' : '')}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该工单没有已过账的领料" /> }} />
        )
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择工单（已下达 / 生产中 / 已完工）" />}
      {picked.length > 0 && <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>本次退料 {picked.length} 行。</Typography.Paragraph>}
    </Modal>
  );
}

export default function Issues() {
  const [sp, setSp] = useSearchParams();
  const narrow = useNarrow();
  const woId = sp.get('wo_id');
  const { rows, loading, query, setQuery, reload, pagination, onTableChange } = usePaged('/issues', {
    q: sp.get('q') || undefined,
    wo_id: woId ? Number(woId) : undefined,
    status: sp.get('status') || undefined,
    issue_type: sp.get('issue_type') || undefined,
  });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const { can } = useAuth();
  const nav = useNavigate();

  // /wms/issues?id=123 直接打开明细（全局搜索 / 待办跳转）；?return=1 直接新建退料单（仓管九宫格“生产退料”）
  useEffect(() => {
    const id = Number(sp.get('id'));
    if (id) get(`/issues/${id}`).then(setCurrent).catch(() => undefined);
    if (sp.get('return') === '1' && can('wms')) {
      setReturnOpen(true);
      const next = new URLSearchParams(sp);
      next.delete('return');
      setSp(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  const changed = (r: Rec) => {
    setCurrent((c) => (c && c.id === r.id ? r : c));
    reload();
  };
  const closeDrawer = () => {
    setCurrent(null);
    if (sp.get('id')) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const columns: RColumn[] = [
    { title: '单号', dataIndex: 'no', width: 130, sorter: true, fixed: narrow ? undefined : 'left', mobile: 'title', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
    { title: '类型', dataIndex: 'issue_type', width: 70, render: (v) => <StatusTag dict="issue_type" value={v || 'ISSUE'} /> },
    {
      title: '生产工单', dataIndex: 'wo_no', width: 130,
      render: (v, r) => <Link to={`/mes/work-orders/${r.wo_id}`} onClick={(e) => e.stopPropagation()}>{v}</Link>,
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag dict="doc_status" value={v} /> },
    {
      title: '行数', key: 'cnt', width: 80, align: 'right',
      render: (_, r) => {
        const n = (r.lines as Rec[] | undefined)?.length ?? 0;
        const p = (r.lines as Rec[] | undefined)?.filter(picked).length ?? 0;
        return r.status === 'DRAFT' && p ? `${p}/${n} 已拣` : n;
      },
    },
    {
      title: '含客供', key: 'cs', width: 70, mobile: 'hidden',
      render: (_, r) => ((r.lines as Rec[] | undefined)?.some((l) => l.owner_customer_id) ? <CsTag /> : '-'),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 140, sorter: true, render: (v) => fmtDateTime(v) },
    { title: '制单人', dataIndex: 'created_by', width: 90, mobile: 'hidden' },
    { title: '过账人', dataIndex: 'confirmed_by', width: 90, mobile: 'hidden', render: (v) => v || '-' },
    { title: '过账时间', dataIndex: 'confirmed_at', width: 140, mobile: 'hidden', render: (v) => fmtDateTime(v) },
    // 窄屏：卡片只放“拣料”，过账/作废放在明细里（避免不看拣料单就过账）
    { title: '操作', key: '_op', fixed: narrow ? undefined : 'right', width: 230, render: (_, r) => <IssueActions row={r} onChanged={changed} size={narrow ? 'large' : 'small'} compact={narrow} inList /> },
  ];

  return (
    <>
      <PageHeader
        title="生产领料 / 退料"
        sub="领料单由生产工单生成；仓管扫码拣料、过账。工单多领或完工剩余的物料用退料单退回。点击行查看明细。"
        extra={can('wms') && (
          <Space wrap>
            <Button type="primary" icon={<MobileOutlined />} onClick={() => nav('/wms/pda/pick')}>扫码拣料</Button>
            <Button icon={<RollbackOutlined />} onClick={() => setReturnOpen(true)}>新建退料单</Button>
          </Space>
        )}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="系统已按 FEFO（先到期先出）推荐批次；拣料时实物不够可改实拣数，系统自动从下一批补足，支持部分过账。过账后批次与工单绑定用于追溯；过账错误可“冲销”（需电子签名）。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="领料/退料单号 / 工单号" defaultValue={sp.get('q') || ''} style={{ width: 240 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Select allowClear placeholder="状态" style={{ width: 130 }} defaultValue={sp.get('status') || undefined} options={STATUS_OPTIONS} onChange={(v) => setQuery({ status: v })} />
          <Select allowClear placeholder="类型" style={{ width: 110 }} defaultValue={sp.get('issue_type') || undefined} options={[{ value: 'ISSUE', label: '领料' }, { value: 'RETURN', label: '退料' }]} onChange={(v) => setQuery({ issue_type: v })} />
          {woId && (
            <Tag
              color="blue"
              closable
              onClose={() => {
                const next = new URLSearchParams(sp);
                next.delete('wo_id');
                setSp(next, { replace: true });
                setQuery({ wo_id: undefined });
              }}
            >
              仅显示工单 {rows[0]?.wo_no || `#${woId}`} 的领料单
            </Tag>
          )}
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton url="/issues" params={query} filename="领料退料单" columns={[
            { title: '单号', key: 'no' }, { title: '类型', value: (r) => dictLabel('issue_type', r.issue_type || 'ISSUE') }, { title: '生产工单', key: 'wo_no' },
            { title: '状态', value: (r) => dictLabel('doc_status', r.status) }, { title: '行数', value: (r) => r.lines?.length ?? 0 },
            { title: '创建时间', key: 'created_at', type: 'datetime' }, { title: '制单人', key: 'created_by' }, { title: '过账人', key: 'confirmed_by' },
            { title: '过账时间', key: 'confirmed_at', type: 'datetime' }, { title: '冲销原因', key: 'reverse_reason' },
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
          onRow={(r) => ({ onClick: () => setCurrent(r), style: { cursor: 'pointer' } })}
        />
      </Card>
      <IssueDrawer issue={current} onClose={closeDrawer} onChanged={changed} />
      <ReturnModal open={returnOpen} woId={woId ? Number(woId) : undefined} onClose={() => setReturnOpen(false)} onDone={(r) => { reload(); setCurrent(r); }} />
    </>
  );
}
