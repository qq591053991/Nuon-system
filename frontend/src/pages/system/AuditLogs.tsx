import { Alert, Button, Card, DatePicker, Input, Modal, Result, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { CloseOutlined, LockOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { toDate } from '../../utils/format';
import { ENTITY_OPTIONS, FIELD_NAMES, STATUS_DICT, entityName, rowUrl } from './entities';

const fmtTs = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-');

type Refs = Record<string, Record<string, string>>;
interface FieldChange { field: string; old: unknown; new: unknown }
interface LineItem { key: string; op: 'ADD' | 'DEL' | 'MOD'; title: string | null; fields: FieldChange[]; children?: { rel: string; rel_name: string; items: LineItem[] }[] }
interface LineChanges { rel: string; rel_name: string; before_known: boolean; items: LineItem[]; unchanged: number }

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

const ROLE_NAMES: Record<string, string> = {
  admin: '系统管理员', manager: '厂长/管理层', sales: '销售/客服', purchaser: '采购', planner: 'PMC 计划', engineer: '工艺/研发工程师',
  warehouse: '仓管员', operator: '产线操作员', qc: '质检员', qa: '质量工程师/QA', finance: '财务',
};

/** 字段值 → 显示文本（导出 Excel 与页面共用） */
function valText(v: unknown, field: string, entity: string, refs?: Refs): string {
  if (v === null || v === undefined || v === '') return '空';
  if (typeof v === 'boolean') return v ? '是' : '否';
  const ref = refs?.[field]?.[String(v)];
  if (ref) return ref;
  if (typeof v === 'object') return JSON.stringify(v);
  if (field === 'roles') return String(v).split(',').filter(Boolean).map((r) => ROLE_NAMES[r] || r).join('、') || '无';
  if (field === 'auth_source' || field === 'source') return ({ LOCAL: '本系统', KINGDEE: '金蝶云星空', BADGE: '工牌' } as Rec)[String(v)] ?? String(v);
  if (field === 'scrap_rate' && typeof v === 'number') return `${+(v * 100).toFixed(4)}%`;
  const dict = field === 'status' ? STATUS_DICT[entity] : FIELD_DICT[field];
  if (dict) return dictLabel(dict, String(v));
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtTs(v);
  return String(v);
}

/** 字段值显示：空值灰色、ID 显示编码名称（悬停看 ID）、状态码中文化 */
function Val({ v, field, entity, refs }: { v: unknown; field: string; entity: string; refs?: Refs }) {
  if (v === null || v === undefined || v === '') return <Typography.Text type="secondary" italic>空</Typography.Text>;
  const text = valText(v, field, entity, refs);
  const raw = typeof v === 'object' ? '' : String(v);
  const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return text !== raw && raw ? <Tooltip title={`${field}=${raw}`}><span>{shown}</span></Tooltip> : <span style={{ wordBreak: 'break-all' }}>{shown}</span>;
}

const OP_TAG: Record<string, [string, string]> = { ADD: ['新增', 'green'], DEL: ['删除', 'red'], MOD: ['修改', 'blue'] };

/** 新增/删除行只列有意义的字段（标题已含物料/工序，损耗率 0 不列） */
const shownFields = (it: LineItem) => (it.op === 'MOD'
  ? it.fields
  : it.fields.filter((f) => !['line_no', 'component_id', 'seq', 'code', 'name'].includes(f.field) && !(f.field === 'scrap_rate' && !(it.op === 'DEL' ? f.old : f.new))));

function itemText(it: LineItem, entity: string, refs?: Refs): string {
  const head = `${OP_TAG[it.op][0]} ${it.key}${it.title ? ` ${it.title}` : ''}`;
  const fields = shownFields(it);
  const parts = it.op === 'MOD'
    ? fields.map((f) => `${fieldLabel(f.field)} ${valText(f.old, f.field, entity, refs)}→${valText(f.new, f.field, entity, refs)}`)
    : fields.map((f) => `${fieldLabel(f.field)} ${valText(it.op === 'DEL' ? f.old : f.new, f.field, entity, refs)}`);
  const kids = (it.children ?? []).flatMap((c) => c.items.map((x) => `${c.rel_name}：${itemText(x, entity, refs)}`));
  return [head + (parts.length ? `：${parts.join('，')}` : ''), ...kids].join('；');
}

/** 子表按行差异（如 BOM 明细：第70行 SCREW-M3X8：用量 12 → 14） */
function LineChangesView({ list, row, max }: { list: LineChanges[]; row: Rec; max?: number }) {
  const parent = row.entity_name || entityName(row.entity);
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {list.map((lc) => {
        const items = max ? lc.items.slice(0, max) : lc.items;
        return (
          <div key={lc.rel} style={{ fontSize: 13 }}>
            <Typography.Text strong>{parent} {lc.rel_name}：</Typography.Text>
            {!lc.items.length && <Typography.Text type="secondary">内容未变化</Typography.Text>}
            {!lc.before_known && <Typography.Text type="secondary">（修改前无记录，仅列出保存后的内容）</Typography.Text>}
            {items.map((it) => <LineItemView key={`${it.op}-${it.key}`} it={it} row={row} />)}
            {max && lc.items.length > max && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>等 {lc.items.length} 处变更，展开查看全部</Typography.Text></div>}
            {lc.before_known && lc.unchanged > 0 && lc.items.length > 0 && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>其余 {lc.unchanged} 行未变</Typography.Text></div>}
          </div>
        );
      })}
    </Space>
  );
}

function LineItemView({ it, row, depth = 0 }: { it: LineItem; row: Rec; depth?: number }) {
  const [label, color] = OP_TAG[it.op];
  const fields = shownFields(it);
  return (
    <div style={{ paddingLeft: depth * 16, lineHeight: '22px' }}>
      <Tag color={color} style={{ marginInlineEnd: 4, fontSize: 12, lineHeight: '18px' }}>{label}</Tag>
      <b>{it.key}</b>{it.title && <span className="mono" style={{ marginLeft: 6 }}>{it.title}</span>}
      {fields.length > 0 && <Typography.Text type="secondary">：</Typography.Text>}
      {fields.map((f, i) => (
        <span key={f.field}>
          {i > 0 && <Typography.Text type="secondary">，</Typography.Text>}
          <Typography.Text type="secondary">{fieldLabel(f.field)} </Typography.Text>
          {it.op === 'MOD' ? (
            <>
              <span style={{ color: '#cf1322', textDecoration: 'line-through' }}><Val v={f.old} field={f.field} entity={row.entity} refs={row.refs} /></span>
              <span style={{ color: '#8c8c8c', margin: '0 4px' }}>→</span>
              <span style={{ color: '#389e0d', fontWeight: 600 }}><Val v={f.new} field={f.field} entity={row.entity} refs={row.refs} /></span>
            </>
          ) : (
            <span style={{ color: it.op === 'DEL' ? '#cf1322' : undefined }}><Val v={it.op === 'DEL' ? f.old : f.new} field={f.field} entity={row.entity} refs={row.refs} /></span>
          )}
        </span>
      ))}
      {(it.children ?? []).map((c) => c.items.map((x) => (
        <div key={`${c.rel}-${x.key}`} style={{ paddingLeft: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.rel_name}：</Typography.Text>
          <LineItemView it={x} row={row} depth={0} />
        </div>
      )))}
    </div>
  );
}

const LOGIN_FIELDS = new Set(['reason', 'source', 'badge_no', 'locked']);

/** 变更内容（导出 Excel 用的纯文本） */
function diffText(row: Rec): string {
  const ch = parseChanges(row.changes);
  if (!ch) return row.changes || '';
  const lines: LineChanges[] = row.line_changes || [];
  const keys = Object.keys(ch).filter((k) => k !== '_nested');
  const parts: string[] = [];
  if (row.action === 'UPDATE') {
    for (const k of keys) {
      const [o, n] = Array.isArray(ch[k]) ? ch[k] : [undefined, ch[k]];
      parts.push(`${fieldLabel(k)}：${valText(o, k, row.entity, row.refs)}→${valText(n, k, row.entity, row.refs)}`);
    }
  } else {
    for (const k of keys) parts.push(`${fieldLabel(k)}=${valText(ch[k], k, row.entity, row.refs)}`);
  }
  for (const lc of lines) {
    if (!lc.items.length) continue;
    parts.push(`${row.entity_name ? `${row.entity_name} ` : ''}${lc.rel_name}：${lc.items.map((it) => itemText(it, row.entity, row.refs)).join('；')}${lc.unchanged ? `（其余 ${lc.unchanged} 行未变）` : ''}`);
  }
  if (ch._nested && !lines.length) parts.push('明细已变更');
  return parts.join('；');
}

/** 列表中的紧凑差异 */
export function CompactDiff({ row }: { row: Rec }) {
  const ch = parseChanges(row.changes);
  if (!ch) return <Typography.Text type="secondary">{row.changes || '-'}</Typography.Text>;
  const keys = Object.keys(ch).filter((k) => k !== '_nested');
  const lines: LineChanges[] = row.line_changes || [];
  const nestedOnly = !!ch._nested && !lines.length;
  if (!keys.length && !lines.length) return <Typography.Text type="secondary">{nestedOnly ? '明细已变更（展开查看）' : '-'}</Typography.Text>;
  const lineView = lines.length > 0 && <LineChangesView list={lines} row={row} max={3} />;
  if (row.action === 'UPDATE') {
    const shown = keys.slice(0, 3);
    return (
      <Space direction="vertical" size={0} style={{ maxWidth: 640 }}>
        {shown.map((k) => {
          const [o, n] = Array.isArray(ch[k]) ? ch[k] : [undefined, ch[k]];
          return (
            <span key={k} style={{ fontSize: 13 }}>
              <Typography.Text type="secondary">{fieldLabel(k)}：</Typography.Text>
              <span style={{ color: '#cf1322', textDecoration: 'line-through' }}><Val v={o} field={k} entity={row.entity} refs={row.refs} /></span>
              <span style={{ color: '#bfbfbf', margin: '0 6px' }}>→</span>
              <span style={{ color: '#389e0d', fontWeight: 600 }}><Val v={n} field={k} entity={row.entity} refs={row.refs} /></span>
            </span>
          );
        })}
        {keys.length > 3 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>等 {keys.length} 个字段，展开查看</Typography.Text>}
        {lineView}
      </Space>
    );
  }
  // CREATE / DELETE / 登录：优先展示能识别记录的字段
  const prefer = row.entity === 'sys_login' ? ['reason', 'source', 'badge_no', 'locked'] : ['no', 'code', 'sn', 'name', 'username', 'material_id', 'component_id', 'lot_no', 'status', 'qty'];
  const pick = [...prefer.filter((k) => k in ch), ...keys.filter((k) => !prefer.includes(k) && (row.entity !== 'sys_login' || LOGIN_FIELDS.has(k)))].slice(0, 4);
  return (
    <Space direction="vertical" size={0} style={{ maxWidth: 640 }}>
      <span style={{ fontSize: 13 }}>
        {pick.map((k, i) => (
          <span key={k}>
            {i > 0 && <Typography.Text type="secondary">；</Typography.Text>}
            <Typography.Text type="secondary">{fieldLabel(k)}=</Typography.Text>
            <Val v={ch[k]} field={k} entity={row.entity} refs={row.refs} />
          </span>
        ))}
        {keys.length > 4 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（共 {keys.length} 个字段）</Typography.Text>}
      </span>
      {lineView}
    </Space>
  );
}

/** 展开行：完整差异表 + 子表逐行差异 */
export function FullDiff({ row }: { row: Rec }) {
  const ch = parseChanges(row.changes);
  if (!ch) return <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{row.changes || '（无变更内容）'}</pre>;
  const isUpdate = row.action === 'UPDATE';
  const lines: LineChanges[] = row.line_changes || [];
  const data = Object.keys(ch).filter((k) => k !== '_nested').map((k) => {
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
          { title: '修改前', dataIndex: 'old', render: (v: any, r: Rec) => <span style={{ color: '#cf1322' }}><Val v={v} field={r.field} entity={row.entity} refs={row.refs} /></span> },
          { title: '修改后', dataIndex: 'new', render: (v: any, r: Rec) => <span style={{ color: '#389e0d', fontWeight: 600 }}><Val v={v} field={r.field} entity={row.entity} refs={row.refs} /></span> },
        ]
      : [{ title: row.action === 'DELETE' ? '删除前的值' : '值', dataIndex: 'new', render: (v: any, r: Rec) => <Val v={v} field={r.field} entity={row.entity} refs={row.refs} /> }]),
  ];
  return (
    <Space direction="vertical" size={12} style={{ width: '100%', maxWidth: 960 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        对象：{row.entity_name || entityName(row.entity)}（{row.entity}）· 记录ID {row.entity_id ?? '-'} · 审计序号 {row.id}{row.parent_name ? ` · 所属${row.parent_name} ${row.doc_no}` : ''}
      </Typography.Text>
      {data.length > 0 && <Table rowKey="field" size="small" columns={columns} dataSource={data} pagination={false} />}
      {lines.length > 0 && <LineChangesView list={lines} row={row} />}
      {ch._nested && !lines.length && <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(ch._nested, null, 1)}</pre>}
    </Space>
  );
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
  const [sp, setSp] = useSearchParams();
  const eid = sp.get('entity_id');
  const init = {
    entity: sp.get('entity') || undefined, entity_id: eid ? Number(eid) : undefined, doc: sp.get('doc') || undefined,
    user: sp.get('user') || undefined, username: sp.get('username') || undefined,
  };
  const { rows, loading, setQuery, reload, pagination, query, total } = usePaged('/system/audit-logs', init, 50);
  const [doc, setDoc] = useState(init.doc || '');
  const [user, setUser] = useState(init.user || init.username || '');

  const columns: TableColumnsType<Rec> = [
    { title: '时间', dataIndex: 'ts', width: 156, render: (v) => <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtTs(v)}</span> },
    {
      title: '操作人', key: 'user', width: 130,
      render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}>{r.full_name || '-'} <Typography.Text type="secondary">({r.username})</Typography.Text></span>,
    },
    { title: '动作', dataIndex: 'action', width: 76, render: (v) => <StatusTag dict="audit_action" value={v} /> },
    {
      title: '对象', dataIndex: 'entity', width: 100,
      render: (v, r) => <Tooltip title={`${v} · 记录ID ${r.entity_id ?? '-'}`}><span style={{ whiteSpace: 'nowrap' }}>{r.entity_name || entityName(v)}</span></Tooltip>,
    },
    {
      title: '单号 / 编码', key: 'doc', width: 150,
      render: (_, r) => {
        const text = r.doc_no || (r.entity_id ? `#${r.entity_id}` : '-');
        const url = rowUrl(r);
        const node = url ? <Link className="mono" style={{ wordBreak: 'break-all' }} to={url}>{text}</Link> : <span className="mono" style={{ wordBreak: 'break-all' }}>{text}</span>;
        return r.parent_name ? <Tooltip title={`所属${r.parent_name}`}>{node}</Tooltip> : node;
      },
    },
    { title: '变更内容', key: 'changes', render: (_, r): ReactNode => <CompactDiff row={r} /> },
  ];

  const clearRecord = () => {
    sp.delete('entity_id');
    setSp(sp, { replace: true });
    setQuery({ entity_id: undefined });
  };

  return (
    <>
      <PageHeader title="审计追踪" sub="谁、在什么时间、对哪张单据、改了什么（修改前 → 修改后）。可按单号/物料编码、姓名查，明细行逐行显示差异。" />
      <Alert
        type="info"
        showIcon
        icon={<LockOutlined />}
        style={{ marginBottom: 16 }}
        message="审计追踪由系统自动记录，任何人（包括管理员）都无法修改或删除；系统每分钟把新记录接入哈希链封存，可随时做完整性校验。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder="单号 / 物料编码 / 序列号"
            style={{ width: 230 }}
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            onSearch={(v) => setQuery({ doc: v.trim() || undefined })}
          />
          <Input.Search
            allowClear
            placeholder="操作人姓名或账号"
            style={{ width: 180 }}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onSearch={(v) => setQuery({ user: v.trim() || undefined, username: undefined })}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="对象（如 BOM、销售订单）"
            style={{ width: 200 }}
            value={query.entity}
            options={ENTITY_OPTIONS}
            onChange={(v) => setQuery({ entity: v, entity_id: undefined })}
          />
          <Select allowClear placeholder="动作" style={{ width: 110 }} options={dictOptions('audit_action')} value={query.action} onChange={(v) => setQuery({ action: v })} />
          <DatePicker.RangePicker onChange={(v) => setQuery({ date_from: toDate(v?.[0]) || undefined, date_to: toDate(v?.[1]) || undefined })} />
          {query.entity_id && <Tag color="blue" closable closeIcon={<CloseOutlined />} onClose={clearRecord}>只看记录ID {query.entity_id}</Tag>}
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton
            url="/system/audit-logs"
            params={{ ...query, line_diff: 1 }}
            filename="审计追踪"
            title="审计追踪导出"
            columns={[
              { title: '时间', key: 'ts', type: 'datetime', width: 20 },
              { title: '操作人', key: 'full_name', width: 12 },
              { title: '账号', key: 'username', width: 12 },
              { title: '动作', value: (r) => dictLabel('audit_action', r.action), width: 8 },
              { title: '对象', value: (r) => r.entity_name || entityName(r.entity), width: 12 },
              { title: '单号/编码', value: (r) => r.doc_no || (r.entity_id ? `#${r.entity_id}` : ''), width: 18 },
              { title: '变更内容', value: (r) => diffText(r), width: 80 },
              { title: '审计序号', key: 'id', type: 'number', width: 10 },
            ]}
          />
          {can('admin', 'qa') && <IntegrityCheck />}
        </Space>
        {(query as Rec).doc && !loading && total === 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`没有找到与“${(query as Rec).doc}”相关的记录：请确认单号/编码是否正确（支持部分匹配，如只输末几位）。`} />
        )}
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          tableLayout="fixed"
          scroll={{ x: 1000 }}
          expandable={{ expandedRowRender: (r) => <FullDiff row={r} />, columnWidth: 40 }}
        />
      </Card>
    </>
  );
}
