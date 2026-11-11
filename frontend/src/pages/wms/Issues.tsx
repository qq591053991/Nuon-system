import { Alert, Button, Card, Descriptions, Drawer, Input, Popconfirm, Select, Space, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime } from '../../utils/format';
import { CsTag, ExpiryDate, LotLink, MaterialCell, Qty } from './common';

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
      message.success(action === 'confirm' ? `领料单 ${row.no} 已过账，库存已扣减` : `领料单 ${row.no} 已取消`);
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
          description={<div style={{ maxWidth: 280 }}>请确认已按单拣料。过账后将扣减库存，批次与工单绑定用于追溯，不可撤销。</div>}
          okText="过账"
          onConfirm={() => act('confirm')}
        >
          <Button size={size} type="primary" icon={<CheckOutlined />} loading={busy}>过账</Button>
        </Popconfirm>
      )}
      {can('wms', 'plan') && (
        <Popconfirm title="确定取消该领料单？" okText="取消领料单" cancelText="不取消" onConfirm={() => act('cancel')}>
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
      title={issue && <Space>领料单 <span className="mono">{issue.no}</span><StatusTag dict="doc_status" value={issue.status} /></Space>}
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
          {issue.status === 'DRAFT' && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="拣料清单已按库位排序。请按指定批号拣料（系统已按先到期先出推荐），全部拣齐后点击右上角“过账”。" />
          )}
          <Table rowKey="id" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
            共 {lines.length} 行。客供料（紫色标记）只能用于对应客户的工单；过期批次系统不会推荐。
          </Typography.Paragraph>
        </>
      )}
    </Drawer>
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

  const changed = (r: Rec) => {
    setCurrent((c) => (c && c.id === r.id ? r : c));
    reload();
  };

  const columns: TableColumnsType<Rec> = [
    { title: '领料单号', dataIndex: 'no', width: 130, fixed: 'left', render: (v) => <a className="mono" style={{ fontWeight: 600 }}>{v}</a> },
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
      <PageHeader title="生产领料" sub="领料单由生产工单生成；仓管按单拣料、过账。点击行查看拣料清单。" />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="系统已按 FEFO（先到期先出）推荐批次，仓管按单拣料后过账；过账后批次即与工单绑定用于追溯。只能领用“合格”库存。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="领料单号 / 工单号" defaultValue={sp.get('q') || ''} style={{ width: 240 }} onSearch={(q) => setQuery({ q: q.trim() })} />
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
    </>
  );
}
