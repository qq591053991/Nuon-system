import { Alert, Button, Card, DatePicker, Input, Modal, Result, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { LockOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { toDate } from '../../utils/format';
import { ENTITY_OPTIONS, FIELD_NAMES, STATUS_DICT, entityName, entityUrl } from './entities';

const fmtTs = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-');

function parseChanges(s?: string | null): Rec | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const fieldLabel = (f: string) => FIELD_NAMES[f] || f;

/** 枚举字段 → 字典（状态字段按对象另行判断，见 STATUS_DICT） */
const FIELD_DICT: Record<string, string> = {
  dhr_status: 'dhr_status', disposition: 'disposition', receipt_type: 'receipt_type', move_type: 'move_type', doc_type: 'fin_type',
  insp_type: 'insp_type', severity: 'severity', result: 'result', action: 'mrp_action', category: 'material_category',
  warehouse_type: 'warehouse_type', location_type: 'location_type', equipment_type: 'equipment_type', op_type: 'op_type',
};

/** 字段值显示：空值、布尔、状态码中文化 */
function Val({ v, field, entity }: { v: any; field: string; entity: string }) {
  if (v === null || v === undefined || v === '') return <Typography.Text type="secondary" italic>空</Typography.Text>;
  if (typeof v === 'boolean') return <span>{v ? '是' : '否'}</span>;
  if (typeof v === 'object') return <span className="mono">{JSON.stringify(v)}</span>;
  const dict = field === 'status' ? STATUS_DICT[entity] : FIELD_DICT[field];
  if (dict) {
    const label = dictLabel(dict, String(v));
    return <Tooltip title={String(v)}><span>{label}</span></Tooltip>;
  }
  const s = String(v);
  return <span style={{ wordBreak: 'break-all' }}>{s.length > 80 ? `${s.slice(0, 80)}…` : s}</span>;
}

/** 列表中的紧凑差异 */
function CompactDiff({ row }: { row: Rec }) {
  const ch = parseChanges(row.changes);
  if (!ch) return <Typography.Text type="secondary">{row.changes || '-'}</Typography.Text>;
  const keys = Object.keys(ch);
  if (!keys.length) return <Typography.Text type="secondary">-</Typography.Text>;
  if (row.action === 'UPDATE') {
    const shown = keys.slice(0, 3);
    return (
      <Space direction="vertical" size={0} style={{ maxWidth: 520 }}>
        {shown.map((k) => {
          const [o, n] = Array.isArray(ch[k]) ? ch[k] : [undefined, ch[k]];
          return (
            <span key={k} style={{ fontSize: 13 }}>
              <Typography.Text type="secondary">{fieldLabel(k)}：</Typography.Text>
              <span style={{ color: '#cf1322', textDecoration: 'line-through' }}><Val v={o} field={k} entity={row.entity} /></span>
              <span style={{ color: '#bfbfbf', margin: '0 6px' }}>→</span>
              <span style={{ color: '#389e0d', fontWeight: 600 }}><Val v={n} field={k} entity={row.entity} /></span>
            </span>
          );
        })}
        {keys.length > 3 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>等 {keys.length} 个字段，展开查看</Typography.Text>}
      </Space>
    );
  }
  // CREATE / DELETE：优先展示能识别记录的字段
  const prefer = ['no', 'code', 'sn', 'name', 'username', 'lot_no', 'status', 'qty'];
  const pick = [...prefer.filter((k) => k in ch), ...keys.filter((k) => !prefer.includes(k))].slice(0, 3);
  return (
    <span style={{ fontSize: 13 }}>
      {pick.map((k, i) => (
        <span key={k}>
          {i > 0 && <Typography.Text type="secondary">；</Typography.Text>}
          <Typography.Text type="secondary">{fieldLabel(k)}=</Typography.Text>
          <Val v={ch[k]} field={k} entity={row.entity} />
        </span>
      ))}
      {keys.length > 3 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（共 {keys.length} 个字段）</Typography.Text>}
    </span>
  );
}

/** 展开行：完整差异表 */
function FullDiff({ row }: { row: Rec }) {
  const ch = parseChanges(row.changes);
  if (!ch) return <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{row.changes || '（无变更内容）'}</pre>;
  const isUpdate = row.action === 'UPDATE';
  const data = Object.keys(ch).map((k) => {
    const v = ch[k];
    return isUpdate && Array.isArray(v) ? { field: k, old: v[0], new: v[1] } : { field: k, old: undefined, new: v };
  });
  const columns: TableColumnsType<Rec> = [
    {
      title: '字段', dataIndex: 'field', width: 200,
      render: (f) => <span>{fieldLabel(f)}{FIELD_NAMES[f] && <Typography.Text type="secondary" className="mono" style={{ fontSize: 12, marginLeft: 6 }}>{f}</Typography.Text>}</span>,
    },
    ...(isUpdate
      ? [
          { title: '修改前', dataIndex: 'old', render: (v: any, r: Rec) => <span style={{ color: '#cf1322' }}><Val v={v} field={r.field} entity={row.entity} /></span> },
          { title: '修改后', dataIndex: 'new', render: (v: any, r: Rec) => <span style={{ color: '#389e0d', fontWeight: 600 }}><Val v={v} field={r.field} entity={row.entity} /></span> },
        ]
      : [{ title: row.action === 'DELETE' ? '删除前的值' : '值', dataIndex: 'new', render: (v: any, r: Rec) => <Val v={v} field={r.field} entity={row.entity} /> }]),
  ];
  return <Table rowKey="field" size="small" columns={columns} dataSource={data} pagination={false} style={{ maxWidth: 900 }} />;
}

interface VerifyResult {
  ok: boolean;
  sealed_total: number;
  sealed_now: number;
  problems: { id: number; seal_no: number; problem: string }[];
  verified_at: string;
}

/** 完整性校验：后端先把新记录接入哈希链（封存），再复算整条链，发现被篡改、删除或插入的记录 */
function IntegrityCheck() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<VerifyResult | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setRes(await get<VerifyResult>('/system/audit-verify'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button icon={<SafetyCertificateOutlined />} loading={busy} onClick={run}>完整性校验</Button>
      <Modal open={!!res} title="审计追踪完整性校验" width={720} footer={<Button type="primary" onClick={() => setRes(null)}>关闭</Button>} onCancel={() => setRes(null)}>
        {res && (res.ok ? (
          <Result
            status="success"
            title="审计追踪完整，未发现篡改"
            subTitle={`已校验 ${res.sealed_total} 条已封存记录的哈希链（本次新封存 ${res.sealed_now} 条），校验时间 ${fmtTs(res.verified_at)}。`}
          />
        ) : (
          <>
            <Result
              status="error"
              title={`发现 ${res.problems.length} 条异常记录`}
              subTitle={`共 ${res.sealed_total} 条已封存记录，校验时间 ${fmtTs(res.verified_at)}。请立即通知 QA 负责人调查，并保留本次校验结果作为偏差记录。`}
            />
            <Table
              rowKey="seal_no"
              size="small"
              pagination={false}
              dataSource={res.problems}
              columns={[
                { title: '封存序号', dataIndex: 'seal_no', width: 100 },
                { title: '记录ID', dataIndex: 'id', width: 100 },
                { title: '问题', dataIndex: 'problem', render: (v) => <Typography.Text type="danger">{v}</Typography.Text> },
              ]}
            />
          </>
        ))}
      </Modal>
    </>
  );
}

export default function AuditLogs() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const eid = sp.get('entity_id');
  const { rows, loading, setQuery, reload, pagination } = usePaged(
    '/system/audit-logs',
    { entity: sp.get('entity') || undefined, entity_id: eid ? Number(eid) : undefined },
    50,
  );

  const columns: TableColumnsType<Rec> = [
    { title: '时间', dataIndex: 'ts', width: 160, render: (v) => <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtTs(v)}</span> },
    {
      title: '操作人', key: 'user', width: 150,
      render: (_, r) => <span>{r.full_name || '-'} <Typography.Text type="secondary">({r.username})</Typography.Text></span>,
    },
    { title: '动作', dataIndex: 'action', width: 70, render: (v) => <StatusTag dict="audit_action" value={v} /> },
    {
      title: '对象', dataIndex: 'entity', width: 140,
      render: (v) => <Tooltip title={v}><span>{entityName(v)}</span></Tooltip>,
    },
    {
      title: '记录ID', dataIndex: 'entity_id', width: 80,
      render: (v, r) => {
        const url = entityUrl(r.entity, v);
        return url ? <Link to={url}>{v}</Link> : v ?? '-';
      },
    },
    { title: '变更内容', key: 'changes', render: (_, r): ReactNode => <CompactDiff row={r} /> },
  ];

  return (
    <>
      <PageHeader title="审计追踪" sub="谁、在什么时间、对哪条记录、做了什么修改（修改前 / 修改后），满足 GMP 与 21 CFR Part 11 数据完整性要求。" />
      <Alert
        type="info"
        showIcon
        icon={<LockOutlined />}
        style={{ marginBottom: 16 }}
        message="审计追踪由系统自动记录，任何人（包括管理员）都无法修改或删除；系统每分钟把新记录接入哈希链封存，可随时做完整性校验。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="对象（数据表）"
            style={{ width: 240 }}
            defaultValue={sp.get('entity') || undefined}
            options={ENTITY_OPTIONS}
            onChange={(v) => setQuery({ entity: v, entity_id: undefined })}
          />
          <Input.Search allowClear placeholder="操作人账号，如 qa" style={{ width: 180 }} onSearch={(v) => setQuery({ username: v.trim() })} />
          <Select allowClear placeholder="动作" style={{ width: 110 }} options={dictOptions('audit_action')} onChange={(v) => setQuery({ action: v })} />
          <DatePicker.RangePicker onChange={(v) => setQuery({ date_from: toDate(v?.[0]) || undefined, date_to: toDate(v?.[1]) || undefined })} />
          {eid && <Tag color="blue">记录ID = {eid}</Tag>}
          <Button icon={<ReloadOutlined />} onClick={reload} />
          {can('admin', 'qa') && <IntegrityCheck />}
        </Space>
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          scroll={{ x: 'max-content' }}
          expandable={{ expandedRowRender: (r) => <FullDiff row={r} /> }}
        />
      </Card>
    </>
  );
}
