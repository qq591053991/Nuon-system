import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import RemoteSelect, { LocationSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

const isReturn = (r?: Rec | null) => r?.issue_type === 'RETURN';
const docName = (r?: Rec | null) => (isReturn(r) ? '退料单' : '领料单');

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: '待过账' },
  { value: 'CONFIRMED', label: '已过账' },
  { value: 'CANCELLED', label: '已取消' },
];

/** 领料单动作：只在“待过账”时可过账/取消 */
function IssueActions({ row, onChanged, size = 'small' }: { row: Rec; onChanged: (r: Rec) => void; size?: 'small' | 'middle' }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (row.status !== 'DRAFT') return null;
  const act = async (action: 'confirm' | 'cancel') => {
    setBusy(true);
    try {
      const r = await post(`/issues/${row.id}/${action}`);
      message.success(
        action === 'confirm'
          ? isReturn(row) ? `退料单 ${row.no} 已过账，物料已退回合格库存` : `领料单 ${row.no} 已过账，库存已扣减`
          : `${docName(row)} ${row.no} 已取消`,
      );
      onChanged(r);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space size={4} onClick={(e) => e.stopPropagation()}>
      {can('wms') && (
        <Popconfirm
          title="确认过账？"
          description={
            <div style={{ maxWidth: 280 }}>
              {isReturn(row)
                ? '请确认退料实物已清点并放回指定库位。过账后库存加回“合格”，并扣减工单已领数量，不可撤销。'
                : '请确认已按单拣料。过账后将扣减库存，批次与工单绑定用于追溯，不可撤销。'}
            </div>
          }
          okText="过账"
          onConfirm={() => act('confirm')}
        >
          <Button size={size} type="primary" icon={<CheckOutlined />} loading={busy}>过账</Button>
        </Popconfirm>
      )}
      {can('wms', 'plan') && (
        <Popconfirm title={`确定取消该${docName(row)}？`} okText={`取消${docName(row)}`} cancelText="不取消" onConfirm={() => act('cancel')}>
          <Button size={size} danger icon={<CloseOutlined />} disabled={busy}>取消</Button>
        </Popconfirm>
      )}
    </Space>
  );
}

function IssueDrawer({ issue, onClose, onChanged }: { issue: Rec | null; onClose: () => void; onChanged: (r: Rec) => void }) {
  // 按库位排序，便于仓管按路线拣料
  const lines = useMemo(
    () => [...(issue?.lines || [])].sort((a: Rec, b: Rec) => String(a.location_code).localeCompare(String(b.location_code)) || String(a.material_code).localeCompare(String(b.material_code))),
    [issue],
  );
  const columns: TableColumnsType<Rec> = [
    { title: '#', key: 'idx', width: 40, render: (_, __, i) => i + 1 },
    { title: '库位', dataIndex: 'location_code', width: 90, render: (v) => <b className="mono">{v}</b> },
    {
      title: '物料', key: 'm',
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    { title: '有效期至', dataIndex: 'expiry_date', render: (v) => <ExpiryDate value={v} /> },
  ];
  return (
    <Drawer
      open={!!issue}
      width={860}
      onClose={onClose}
      title={issue && <Space>{docName(issue)} <span className="mono">{issue.no}</span><StatusTag dict="issue_type" value={issue.issue_type} /><StatusTag dict="doc_status" value={issue.status} /></Space>}
      extra={issue && <IssueActions row={issue} onChanged={onChanged} size="middle" />}
      destroyOnHidden
    >
      {issue && (
        <>
          <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="生产工单"><Link to={`/mes/work-orders/${issue.wo_id}`}>{issue.wo_no}</Link></Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag dict="doc_status" value={issue.status} /></Descriptions.Item>
            <Descriptions.Item label="制单">{issue.created_by || '-'} · {fmtDateTime(issue.created_at)}</Descriptions.Item>
            <Descriptions.Item label="过账">{issue.confirmed_by ? `${issue.confirmed_by} · ${fmtDateTime(issue.confirmed_at)}` : '-'}</Descriptions.Item>
            {issue.remark && <Descriptions.Item label="备注" span={2}>{issue.remark}</Descriptions.Item>}
          </Descriptions>
          {issue.status === 'DRAFT' && !isReturn(issue) && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="拣料清单已按库位排序。请按指定批号拣料（系统已按先到期先出推荐），全部拣齐后点击右上角“过账”。" />
          )}
          {issue.status === 'DRAFT' && isReturn(issue) && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="退料：请清点实物、核对批号，放回下列库位后点击右上角“过账”。过账后库存加回“合格”，工单已领数量相应减少。" />
          )}
          <Table rowKey="id" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
            共 {lines.length} 行。{isReturn(issue) ? '客供料退回原客户货主名下；退料批次只能是本工单已领用的批次。' : '客供料（紫色标记）只能用于对应客户的工单；过期批次系统不会推荐。'}
          </Typography.Paragraph>
        </>
      )}
    </Drawer>
  );
}

/** 新建生产退料单：选工单 → 列出该工单已领批次（可退数量 = 已领 − 已退 − 未过账退料）→ 填退料数量与库位 */
function ReturnModal({ open, woId: initWo, onClose, onDone }: { open: boolean; woId?: number; onClose: () => void; onDone: (r: Rec) => void }) {
  const [woId, setWoId] = useState<number | undefined>(initWo);
  const [lots, setLots] = useState<Rec[]>([]);
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [loc, setLoc] = useState<Record<string, number | undefined>>({});
  const [remark, setRemark] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const keyOf = (l: Rec) => `${l.material_id}|${l.lot_no}|${l.owner_customer_id ?? ''}`;

  useEffect(() => {
    if (open) {
      setWoId(initWo);
      setRemark('');
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
      })
      .finally(() => setLoading(false));
  }, [open, woId]);

  const picked = lots.filter((l) => (qty[keyOf(l)] ?? 0) > 0);

  const submit = async () => {
    if (!woId) {
      message.warning('请选择生产工单');
      return;
    }
    if (!picked.length) {
      message.warning('请至少填写一行退料数量');
      return;
    }
    const noLoc = picked.find((l) => !loc[keyOf(l)]);
    if (noLoc) {
      message.warning(`请选择 ${noLoc.material_code} 的退回库位`);
      return;
    }
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
    {
      title: '本次退料', key: 'qty', width: 120,
      render: (_, r) => (
        <InputNumber min={0} max={r.returnable_qty} style={{ width: 110 }} disabled={!r.returnable_qty} value={qty[keyOf(r)] ?? null}
          placeholder={r.returnable_qty ? `≤ ${fmtQty(r.returnable_qty)}` : '已无可退'} onChange={(v) => setQty((q) => ({ ...q, [keyOf(r)]: v as number | null }))} />
      ),
    },
    {
      title: '退回库位', key: 'loc', width: 200,
      render: (_, r) => (
        <LocationSelect style={{ width: 190 }} value={loc[keyOf(r)]} disabled={!r.returnable_qty} onChange={(v) => setLoc((m) => ({ ...m, [keyOf(r)]: v as number | undefined }))} />
      ),
    },
  ];

  return (
    <Modal open={open} width={1150} title={<span><RollbackOutlined style={{ marginRight: 8 }} />新建生产退料单</span>} okText="生成退料单"
      confirmLoading={saving} onOk={submit} onCancel={onClose} destroyOnHidden maskClosable={false}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="只能退回本工单已领用的批次，数量不超过“已领 − 已退 − 未过账退料”。退料只退回合格品库位（默认原领料库位）；不良物料请开具 NCR，不走退料。" />
      <Space wrap style={{ marginBottom: 12 }}>
        <span>生产工单：</span>
        <RemoteSelect url="/work-orders" params={{ status: 'RELEASED,IN_PROGRESS,COMPLETED' }} style={{ width: 360 }} value={woId}
          onChange={(v) => setWoId(v as number | undefined)} placeholder="搜索工单号 / 产品"
          labelOf={(r) => `${r.no} ${r.material_code} ${r.material_name}（${r.lot_no ?? ''}）`} />
        <Input style={{ width: 360 }} placeholder="退料原因 / 备注（如：工单完工剩余）" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Space>
      {loading ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div> : woId ? (
        <Table rowKey={keyOf} size="small" columns={columns} dataSource={lots} pagination={false} scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该工单没有已过账的领料" /> }} />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择工单（已下达 / 生产中 / 已完工）" />}
      {picked.length > 0 && <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>本次退料 {picked.length} 行。</Typography.Paragraph>}
    </Modal>
  );
}

export default function Issues() {
  const [sp, setSp] = useSearchParams();
  const woId = sp.get('wo_id');
  const { rows, loading, setQuery, reload, pagination } = usePaged('/issues', {
    q: sp.get('q') || undefined,
    wo_id: woId ? Number(woId) : undefined,
  });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const { can } = useAuth();

  const changed = (r: Rec) => {
    setCurrent((c) => (c && c.id === r.id ? r : c));
    reload();
  };

  const columns: TableColumnsType<Rec> = [
    { title: '单号', dataIndex: 'no', width: 130, fixed: 'left', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
    { title: '类型', dataIndex: 'issue_type', width: 70, render: (v) => <StatusTag dict="issue_type" value={v || 'ISSUE'} /> },
    {
      title: '生产工单', dataIndex: 'wo_no', width: 130,
      render: (v, r) => <Link to={`/mes/work-orders/${r.wo_id}`} onClick={(e) => e.stopPropagation()}>{v}</Link>,
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag dict="doc_status" value={v} /> },
    { title: '行数', key: 'cnt', width: 60, align: 'right', render: (_, r) => r.lines?.length ?? 0 },
    {
      title: '含客供', key: 'cs', width: 70,
      render: (_, r) => ((r.lines as Rec[] | undefined)?.some((l) => l.owner_customer_id) ? <CsTag /> : '-'),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v) => fmtDateTime(v) },
    { title: '制单人', dataIndex: 'created_by', width: 90 },
    { title: '过账人', dataIndex: 'confirmed_by', width: 90, render: (v) => v || '-' },
    { title: '过账时间', dataIndex: 'confirmed_at', width: 140, render: (v) => fmtDateTime(v) },
    { title: '操作', key: '_op', fixed: 'right', width: 160, render: (_, r) => <IssueActions row={r} onChanged={changed} /> },
  ];

  return (
    <>
      <PageHeader
        title="生产领料 / 退料"
        sub="领料单由生产工单生成；仓管按单拣料、过账。工单多领或完工剩余的物料用退料单退回。点击行查看明细。"
        extra={can('wms') && <Button icon={<RollbackOutlined />} onClick={() => setReturnOpen(true)}>新建退料单</Button>}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="系统已按 FEFO（先到期先出）推荐批次，仓管按单拣料后过账；过账后批次即与工单绑定用于追溯。只能领用“合格”库存。退料只能退本工单已领批次、且不超过已领数量。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="领料/退料单号 / 工单号" defaultValue={sp.get('q') || ''} style={{ width: 240 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Select allowClear placeholder="状态" style={{ width: 130 }} options={STATUS_OPTIONS} onChange={(v) => setQuery({ status: v })} />
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
        </Space>
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          scroll={{ x: 'max-content' }}
          onRow={(r) => ({ onClick: () => setCurrent(r), style: { cursor: 'pointer' } })}
        />
      </Card>
      <IssueDrawer issue={current} onClose={() => setCurrent(null)} onChanged={changed} />
      <ReturnModal open={returnOpen} woId={woId ? Number(woId) : undefined} onClose={() => setReturnOpen(false)} onDone={(r) => { reload(); setCurrent(r); }} />
    </>
  );
}
