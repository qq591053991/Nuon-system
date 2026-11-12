/**
 * 工艺路线详情 / 编辑 / 审批。
 * 好用性修复（docs/ux-review.md G5）：
 * - C-F02 [P0] 测试项编码重复当场标红（后端同样拒绝）；
 * - F09 查看 / 审批页工序表列宽修复，作业指导、关键件、需设备完整显示；
 * - F10 离开页面有未保存修改时提示；变更原因只在【提交审批】时必填，【保存草稿】随时可用；
 * - F11 / D#2 与上一版本差异（新增 / 删除 / 修改分色，判定规格变化醒目），删除改为可撤销的“待删除”，提交时自动生成变更摘要；
 * - F19 测试项上移 / 下移、复制行、OK/NG 判定型、小数位、合理范围；工序详情抽屉（作业指导文字 + 图片 / SOP 附件）。
 */
import {
  Alert, App, Button, Card, Col, Descriptions, Drawer, Form, Input, InputNumber, Popconfirm, Result, Row, Select, Space, Spin, Switch, Table, Tag,
  Tooltip, Typography, type TableColumnsType,
} from 'antd';
import {
  ArrowDownOutlined, ArrowLeftOutlined, ArrowUpOutlined, BranchesOutlined, CloseCircleOutlined, CopyOutlined, DeleteOutlined, ExperimentOutlined,
  FileTextOutlined, PlusOutlined, RollbackOutlined, SafetyCertificateOutlined, SaveOutlined, SendOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect, WorkCenterSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { DiffCard, SignatureHistory, diffIndex, useUnsavedGuard, type DiffResult } from './EngSignatures';
import { NewVersionModal, uid } from './shared';

type ParamRow = Rec & { _key: string; _del?: boolean };
type OpRow = Rec & { _key: string; _del?: boolean; params: ParamRow[] };

const isNum = (v: any) => v !== null && v !== undefined && v !== '';
const up = (s: unknown) => String(s ?? '').trim().toUpperCase();
const PARAM_TYPES = [{ value: 'NUMBER', label: '数值' }, { value: 'OKNG', label: 'OK/NG 判定' }];

/** 规格显示：下限~上限 单位 */
function specText(p: Rec) {
  if (p.param_type === 'OKNG') return 'OK / NG 判定';
  const u = p.unit ? ` ${p.unit}` : '';
  if (isNum(p.lower) && isNum(p.upper)) return `${p.lower} ~ ${p.upper}${u}`;
  if (isNum(p.lower)) return `≥ ${p.lower}${u}`;
  if (isNum(p.upper)) return `≤ ${p.upper}${u}`;
  return '仅记录（不判定）';
}
const validText = (p: Rec) => (isNum(p.min_valid) || isNum(p.max_valid) ? `${isNum(p.min_valid) ? p.min_valid : '不限'} ~ ${isNum(p.max_valid) ? p.max_valid : '不限'}` : '-');

const toOpRows = (ops: Rec[]): OpRow[] =>
  ops.map((o) => ({ ...o, _key: uid(), params: ((o.params || []) as Rec[]).map((p) => ({ ...p, param_type: p.param_type || 'NUMBER', _key: uid() })) }));

/** 同一工序内重复的测试项编码 → {行 key: 与第几项重复} */
function dupParams(params: ParamRow[]) {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  params.forEach((p, i) => {
    if (p._del) return;
    const k = up(p.code);
    if (!k) return;
    if (seen.has(k)) out.set(p._key, seen.get(k)! + 1);
    else seen.set(k, i);
  });
  return out;
}

/** 测试项的问题（编辑表格当场标红 + 保存前校验） */
function paramProblem(p: ParamRow, dupWith?: number): string | null {
  if (!p.code || !String(p.code).trim()) return '请填写编码';
  if (dupWith) return `编码与第 ${dupWith} 项重复`;
  if (!p.name || !String(p.name).trim()) return '请填写名称';
  if (p.param_type === 'OKNG') return null;
  if (isNum(p.lower) && isNum(p.upper) && p.lower > p.upper) return '下限大于上限';
  if (isNum(p.min_valid) && isNum(p.max_valid) && p.min_valid > p.max_valid) return '合理范围下限大于上限';
  for (const [k, l] of [['lower', '下限'], ['upper', '上限'], ['target', '目标值']] as const) {
    if (isNum(p[k]) && ((isNum(p.min_valid) && p[k] < p.min_valid) || (isNum(p.max_valid) && p[k] > p.max_valid))) return `${l}不在合理范围内`;
  }
  return null;
}

/** 某工序的测试项编辑表（工序详情抽屉内） */
function ParamsEditor({ op, onChange, hl }: { op: OpRow; onChange: (params: ParamRow[]) => void; hl: Map<string, string> }) {
  const patch = (key: string, p: Rec) => onChange(op.params.map((x) => (x._key === key ? { ...x, ...p } : x)));
  const dups = dupParams(op.params);
  const move = (i: number, d: number) => {
    const l = [...op.params];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    onChange(l);
  };
  const copy = (r: ParamRow, i: number) => {
    const codes = new Set(op.params.map((x) => up(x.code)));
    let n = 2;
    while (codes.has(up(`${r.code}_${n}`))) n += 1;
    const l = [...op.params];
    l.splice(i + 1, 0, { ...r, id: undefined, _key: uid(), _del: false, code: `${r.code || 'P'}_${n}`, name: `${r.name || ''}（复制）` });
    onChange(l);
  };
  const okng = (r: ParamRow) => r.param_type === 'OKNG';
  const numCell = (r: ParamRow, k: string, w = 84, extra: Rec = {}) => (
    <InputNumber style={{ width: w }} disabled={okng(r) || r._del} value={isNum(r[k]) ? r[k] : null} onChange={(v) => patch(r._key, { [k]: v })} {...extra} />
  );
  const columns: TableColumnsType<ParamRow> = [
    {
      title: '顺序', key: 'ord', width: 92,
      render: (_, __, i) => (
        <Space size={2}>
          <span style={{ width: 18, display: 'inline-block' }}>{i + 1}</span>
          <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移" />
          <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === op.params.length - 1} onClick={() => move(i, 1)} aria-label="下移" />
        </Space>
      ),
    },
    {
      title: '编码', key: 'code', width: 132,
      render: (_, r) => {
        const d = dups.get(r._key);
        const bad = !r._del && (d || !String(r.code ?? '').trim());
        return (
          <div>
            <Input placeholder="如 WL_PEAK" disabled={r._del} status={bad ? 'error' : undefined} value={r.code ?? ''} onChange={(e) => patch(r._key, { code: e.target.value.toUpperCase().replace(/\s/g, '_') })} />
            {d && !r._del && <div style={{ color: '#cf1322', fontSize: 12 }}>与第 {d} 项重复</div>}
          </div>
        );
      },
    },
    { title: '名称', key: 'name', width: 176, render: (_, r) => <Input disabled={r._del} status={!r._del && !String(r.name ?? '').trim() ? 'error' : undefined} placeholder="如 峰值波长" value={r.name ?? ''} onChange={(e) => patch(r._key, { name: e.target.value })} /> },
    {
      title: '类型', key: 'type', width: 120,
      render: (_, r) => <Select style={{ width: 110 }} disabled={r._del} options={PARAM_TYPES} value={r.param_type || 'NUMBER'} onChange={(v) => patch(r._key, { param_type: v })} />,
    },
    { title: '单位', key: 'unit', width: 80, render: (_, r) => <Input disabled={okng(r) || r._del} placeholder="nm" value={r.unit ?? ''} onChange={(e) => patch(r._key, { unit: e.target.value })} /> },
    {
      title: '下限 ~ 上限', key: 'lu', width: 196,
      render: (_, r) => (
        <Space size={4}>
          {numCell(r, 'lower', 84, { status: isNum(r.lower) && isNum(r.upper) && r.lower > r.upper ? 'error' : undefined })}~{numCell(r, 'upper', 84, { status: isNum(r.lower) && isNum(r.upper) && r.lower > r.upper ? 'error' : undefined })}
        </Space>
      ),
    },
    { title: '目标值', key: 'target', width: 92, render: (_, r) => numCell(r, 'target') },
    { title: <Tooltip title="工位录入时限制的小数位数，防止多打或拼接">小数位</Tooltip>, key: 'dec', width: 76, render: (_, r) => numCell(r, 'decimals', 64, { min: 0, max: 6, precision: 0 }) },
    {
      title: <Tooltip title="超出合理范围视为录入错误（如漏打小数点），工位当场拦截、不前进，不会判不合格">合理范围</Tooltip>, key: 'valid', width: 176,
      render: (_, r) => <Space size={4}>{numCell(r, 'min_valid', 74)}~{numCell(r, 'max_valid', 74)}</Space>,
    },
    {
      title: '', key: 'op', width: 84, fixed: 'right',
      render: (_, r, i) => (r._del ? (
        <Button size="small" icon={<RollbackOutlined />} onClick={() => patch(r._key, { _del: false })}>撤销</Button>
      ) : (
        <Space size={0}>
          <Tooltip title="复制此行（编码自动加后缀）"><Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(r, i)} /></Tooltip>
          <Tooltip title="删除（保存前可撤销）">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => (r.id ? patch(r._key, { _del: true }) : onChange(op.params.filter((x) => x._key !== r._key)))} />
          </Tooltip>
        </Space>
      )),
    },
  ];
  return (
    <Table<ParamRow>
      rowKey="_key"
      size="small"
      columns={columns}
      dataSource={op.params}
      pagination={false}
      scroll={{ x: 'max-content' }}
      rowClassName={(r) => (r._del ? 'eng-row-del' : hl.get(`param:${up(op.code)}/${up(r.code)}`) ? `eng-row-${hl.get(`param:${up(op.code)}/${up(r.code)}`)}` : '')}
      locale={{ emptyText: '本工序没有测试项（工位扫码后回车即过站）' }}
      footer={() => (
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => onChange([...op.params, { _key: uid(), param_type: 'NUMBER' }])}>添加测试项</Button>
      )}
    />
  );
}

const ENG_CSS = `
.eng-row-del td { background: #fafafa !important; color: #bfbfbf; text-decoration: line-through; }
.eng-row-del td .ant-btn, .eng-row-del td:last-child { text-decoration: none; }
.eng-row-added td { background: #f6ffed !important; }
.eng-row-changed td:first-child { box-shadow: inset 4px 0 0 #1677ff; }
.eng-ops-view .ant-table-cell { vertical-align: top; }
`;

function RoutingBody({ routing, versions, reload }: { routing: Rec; versions: Rec[]; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { message } = App.useApp();
  const { can, user } = useAuth();
  const [sign, signHolder] = useESign();
  const [form] = Form.useForm();
  const editing = routing.status === 'DRAFT' && can('engineering');
  const reviewing = routing.status === 'SUBMITTED' && can('qa');
  /** 该产品已有发布过的版本：提交时须填写变更原因 */
  const needReason = versions.some((v) => v.id !== routing.id && (v.status === 'RELEASED' || v.status === 'OBSOLETE'));
  const selfSubmitted = !!routing.submitted_by && routing.submitted_by === user?.full_name;
  const [ops, setOps] = useState<OpRow[]>(() => toOpRows(routing.operations || []));
  const [initial] = useState(() => JSON.stringify(toPayloadOps(toOpRows(routing.operations || []))));
  const [formDirty, setFormDirty] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [verOpen, setVerOpen] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const reason: string | undefined = Form.useWatch('change_reason', form);

  const payloadOps = useMemo(() => toPayloadOps(ops), [ops]);
  const dirty = editing && (formDirty || JSON.stringify(payloadOps) !== initial);
  const bypass = useUnsavedGuard(dirty);
  const hl = useMemo(() => {
    const m = diffIndex(diff);
    return new Map([...m].map(([k, v]) => [k, v === 'removed' ? 'changed' : v]));
  }, [diff]);

  const patch = (key: string, p: Rec) => setOps((old) => old.map((o) => (o._key === key ? { ...o, ...p } : o)));
  const addOp = () => {
    const seq = ops.reduce((m, o) => Math.max(m, Number(o.seq) || 0), 0) + 10;
    const k = uid();
    setOps((old) => [...old, { _key: k, seq, op_type: 'ASSEMBLY', std_minutes: 0, requires_equipment: false, params: [] }]);
  };
  const opDups = useMemo(() => {
    const seen = new Map<string, number>();
    const out = new Map<string, number>();
    ops.forEach((o) => {
      if (o._del || !up(o.code)) return;
      if (seen.has(up(o.code))) out.set(o._key, seen.get(up(o.code))!);
      else seen.set(up(o.code), o.seq);
    });
    return out;
  }, [ops]);

  /** 校验并组装提交体；不通过返回 null（forSubmit：提交审批时变更原因必填） */
  const collect = async (forSubmit = false) => {
    if (forSubmit && needReason && !form.getFieldValue('change_reason')?.trim()) {
      form.setFields([{ name: 'change_reason', errors: ['本产品已有发布过的版本：提交审批前请填写变更原因及影响评估（可点“插入变更摘要”）'] }]);
      form.scrollToField('change_reason');
      message.error('提交审批前请填写变更原因及影响评估');
      return null;
    }
    const v = await form.validateFields().catch(() => null);
    if (!v) return null;
    const fail = (msg: string, key?: string) => {
      message.error(msg);
      if (key) setDrawer(key);
      return null;
    };
    const seqs = new Set<number>();
    for (const [i, o] of ops.entries()) {
      if (o._del) continue;
      const label = `第 ${i + 1} 道工序`;
      if (!isNum(o.seq)) return fail(`${label}请填写工序号`);
      if (seqs.has(o.seq)) return fail(`工序号 ${o.seq} 重复`);
      seqs.add(o.seq);
      if (!o.code || !o.name) return fail(`${label}请填写工序编码和名称`);
      if (opDups.has(o._key)) return fail(`工序编码“${o.code}”重复：同一工艺路线内工序编码必须唯一`);
      const dups = dupParams(o.params);
      for (const [j, p] of o.params.entries()) {
        if (p._del) continue;
        const prob = paramProblem(p, dups.get(p._key));
        if (prob) return fail(`工序【${o.seq} ${o.name}】第 ${j + 1} 个测试项：${prob}`, o._key);
      }
    }
    return {
      material_id: routing.material_id,
      version: v.version,
      name: v.name || null,
      remark: v.remark || null,
      change_reason: v.change_reason?.trim() || null,
      operations: payloadOps,
    };
  };

  const save = async () => {
    const body = await collect();
    if (!body) return;
    setBusy('save');
    try {
      await put(`/routings/${routing.id}`, body);
      message.success('草稿已保存');
      bypass();
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const signed = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (isCancel(e)) return null;
      throw e;
    }
  };

  /** 工程师提交（电子签名：编制）→ 待 QA 批准；签名理由默认写入系统生成的变更摘要 */
  const submit = async () => {
    const body = await collect(true);
    if (!body) return;
    if (!body.operations.length) {
      message.error('工艺路线没有工序，不能提交');
      return;
    }
    const summary = diff?.base ? diff.summary : '';
    setBusy('submit');
    try {
      const ok = await signed(() => sign({
        meaning: '工艺路线编制提交',
        description: `提交 ${routing.material_code} 工艺路线版本 ${body.version} 给 QA 审核：批准前不生效；提交后不能修改。${summary ? `\n变更摘要：${summary}` : ''}`,
        defaultReason: summary ? `变更摘要：${summary}`.slice(0, 250) : undefined,
        submit: async (signature) => {
          await put(`/routings/${routing.id}`, body);
          return post(`/routings/${routing.id}/submit`, { signature, change_reason: body.change_reason }, true);
        },
      }));
      if (!ok) return;
      message.success('已提交，等待 QA 批准');
      bypass();
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** QA 批准（电子签名：批准）→ 生效 */
  const approve = async () => {
    setBusy('approve');
    try {
      const ok = await signed(() => sign({
        meaning: '工艺路线批准',
        description: `批准后新下达的工单将按 ${routing.material_code} 版本 ${routing.version} 的工序与测试规格执行，原已发布版本自动作废；已下达工单不受影响。${diff?.base ? `\n本次变更：${diff.summary}` : ''}`,
        submit: (signature) => post(`/routings/${routing.id}/approve`, { signature }, true),
      }));
      if (!ok) return;
      message.success('工艺路线已批准生效');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** QA 驳回（电子签名 + 原因）→ 退回草稿 */
  const reject = async () => {
    setBusy('reject');
    try {
      const ok = await signed(() => sign({
        meaning: '工艺路线驳回',
        description: '驳回后退回草稿，由工程师修改后重新提交。',
        reasonRequired: true,
        reasonLabel: '驳回原因',
        reasonPlaceholder: '如：测试规格缺少验证依据，请补充验证报告后重新提交',
        submit: (signature) => post(`/routings/${routing.id}/reject`, { reason: signature.reason, signature }, true),
      }));
      if (!ok) return;
      message.success('已驳回，退回工程师修改');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    await del(`/routings/${routing.id}`);
    message.success('草稿已删除');
    bypass();
    nav('/engineering/routings');
  };

  const drawerOp = ops.find((o) => o._key === drawer);

  const editCols: TableColumnsType<OpRow> = [
    { title: '工序号', key: 'seq', width: 80, render: (_, o) => <InputNumber min={1} disabled={o._del} style={{ width: 70 }} value={o.seq} onChange={(v) => patch(o._key, { seq: v })} /> },
    {
      title: '编码', key: 'code', width: 110,
      render: (_, o) => (
        <div>
          <Input style={{ width: 100 }} disabled={o._del} status={!o._del && (opDups.has(o._key) || !o.code) ? 'error' : undefined} value={o.code ?? ''}
            onChange={(e) => patch(o._key, { code: e.target.value.toUpperCase().replace(/\s/g, '_') })} />
          {opDups.has(o._key) && !o._del && <div style={{ color: '#cf1322', fontSize: 12 }}>编码重复</div>}
        </div>
      ),
    },
    { title: '工序名称', key: 'name', width: 170, render: (_, o) => <Input disabled={o._del} style={{ width: 160 }} value={o.name ?? ''} onChange={(e) => patch(o._key, { name: e.target.value })} /> },
    {
      title: '类型', key: 'op_type', width: 140,
      render: (_, o) => <Select disabled={o._del} style={{ width: 130 }} options={dictOptions('op_type')} value={o.op_type} onChange={(v) => patch(o._key, { op_type: v })} />,
    },
    {
      title: '工作中心', key: 'wc', width: 160,
      render: (_, o) => <WorkCenterSelect disabled={o._del} style={{ width: 150 }} value={o.work_center_id} onChange={(v) => patch(o._key, { work_center_id: v ?? null })} />,
    },
    {
      title: <Tooltip title="报工时必须记录设备/仪器；校准过期或不适用本工序的仪器不能使用">需设备</Tooltip>, key: 'eq', width: 70, align: 'center',
      render: (_, o) => <Switch disabled={o._del} checked={!!o.requires_equipment} onChange={(v) => patch(o._key, { requires_equipment: v })} />,
    },
    {
      title: '测试项', key: 'params', width: 120,
      render: (_, o) => {
        const live = o.params.filter((p) => !p._del);
        const bad = live.some((p) => paramProblem(p, dupParams(o.params).get(p._key)));
        return (
          <Button size="small" danger={bad} icon={bad ? <WarningOutlined /> : <ExperimentOutlined />} type={live.length ? 'default' : 'dashed'} disabled={o._del} onClick={() => setDrawer(o._key)}>
            测试项 {live.length}
          </Button>
        );
      },
    },
    {
      title: '详情', key: 'detail', width: 120,
      render: (_, o) => (
        <Button size="small" icon={<FileTextOutlined />} disabled={o._del} onClick={() => setDrawer(o._key)}>
          {o.instructions || o.key_part_material_id || o.sop_no ? '作业指导…' : '设置详情'}
        </Button>
      ),
    },
    {
      title: '', key: 'del', width: 90, fixed: 'right',
      render: (_, o) => (o._del ? (
        <Button size="small" icon={<RollbackOutlined />} onClick={() => patch(o._key, { _del: false })}>撤销</Button>
      ) : (
        <Popconfirm title={`删除工序 ${o.seq} ${o.name ?? ''}（含 ${o.params.length} 个测试项）？`} description="保存前可撤销" onConfirm={() => (o.id ? patch(o._key, { _del: true }) : setOps((old) => old.filter((x) => x._key !== o._key)))}>
          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      )),
    },
  ];

  const viewCols: TableColumnsType<Rec> = [
    { title: '工序', key: 'op', width: 200, render: (_, o) => <span><b>{o.seq}</b> <span className="mono">{o.code}</span> {o.name}</span> },
    { title: '类型', dataIndex: 'op_type', width: 110, render: (v) => <StatusTag dict="op_type" value={v} /> },
    { title: '工作中心', dataIndex: 'work_center_name', width: 110, render: (v) => v || '-' },
    { title: '工时(分)', dataIndex: 'std_minutes', width: 76, align: 'right', render: (v) => fmtQty(v) },
    { title: '需设备', dataIndex: 'requires_equipment', width: 66, align: 'center', render: (v) => (v ? <Tag color="blue">是</Tag> : <span style={{ color: '#bbb' }}>否</span>) },
    { title: '关键件', dataIndex: 'key_part_material_code', width: 120, render: (v) => (v ? <Tag color="geekblue" className="mono">{v}</Tag> : '-') },
    {
      title: '作业指导', key: 'ins',
      render: (_, o) => (
        <div style={{ whiteSpace: 'pre-wrap', minWidth: 160 }}>
          {o.sop_no && <Tag>{o.sop_no}</Tag>}
          {o.instructions || (o.sop_no ? '' : '-')}
        </div>
      ),
    },
  ];

  const paramViewCols: TableColumnsType<Rec> = [
    { title: '#', key: 'i', width: 40, render: (_, __, i) => i + 1 },
    { title: '测试项编码', dataIndex: 'code', width: 130, render: (v) => <span className="mono">{v}</span> },
    { title: '测试项名称', dataIndex: 'name', width: 220 },
    { title: '判定规格', key: 'spec', width: 180, render: (_, p) => <b>{specText(p)}</b> },
    { title: '目标值', dataIndex: 'target', width: 100, render: (v, p) => (isNum(v) ? `${v}${p.unit ? ` ${p.unit}` : ''}` : '-') },
    { title: '小数位', dataIndex: 'decimals', width: 70, render: (v) => (isNum(v) ? v : '-') },
    { title: '合理范围', key: 'valid', width: 130, render: (_, p) => validText(p) },
  ];

  const others = versions.filter((v) => v.id !== routing.id);
  const live = ops.filter((o) => !o._del);
  const paramCount = live.reduce((s, o) => s + o.params.filter((p) => !p._del).length, 0);
  const draftBody = editing ? { operations: payloadOps } : null;

  return (
    <>
      {signHolder}
      <style>{ENG_CSS}</style>
      <PageHeader
        title={<Space>工艺路线 {routing.material_code} {routing.material_name}<Tag>{routing.version}</Tag><StatusTag dict="eng_status" value={routing.status} />{dirty && <Tag color="orange">未保存</Tag>}</Space>}
        sub={
          others.length ? (
            <Space size={4} wrap>
              其他版本：
              {others.map((v) => (
                <Link key={v.id} to={`/engineering/routings/${v.id}`}>
                  {v.version}（{dictLabel('eng_status', v.status)}）
                </Link>
              ))}
            </Space>
          ) : routing.name
        }
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/engineering/routings')}>返回列表</Button>
            {editing && (
              <>
                <Popconfirm title="确定删除此工艺路线草稿？" onConfirm={remove}>
                  <Button danger>删除草稿</Button>
                </Popconfirm>
                <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy} onClick={save} type={dirty ? 'primary' : 'default'} ghost={dirty}>保存草稿</Button>
                <Button type="primary" icon={<SendOutlined />} loading={busy === 'submit'} disabled={!!busy} onClick={submit}>提交审批</Button>
              </>
            )}
            {reviewing && (
              <>
                <Button danger icon={<CloseCircleOutlined />} loading={busy === 'reject'} disabled={!!busy} onClick={reject}>驳回</Button>
                <Tooltip title={selfSubmitted ? '批准人不能与提交人相同（职责分离）' : undefined}>
                  <Button type="primary" icon={<SafetyCertificateOutlined />} loading={busy === 'approve'} disabled={!!busy || selfSubmitted} onClick={approve}>批准</Button>
                </Tooltip>
              </>
            )}
            {routing.status === 'RELEASED' && can('engineering') && (
              <Button type="primary" icon={<BranchesOutlined />} onClick={() => setVerOpen(true)}>升版</Button>
            )}
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type={routing.status === 'OBSOLETE' ? 'warning' : 'info'}
          showIcon
          message={
            routing.status === 'OBSOLETE'
              ? '此版本已作废（已被新版本替代），仅供查阅。'
              : routing.status === 'SUBMITTED'
                ? reviewing
                  ? '工程师已提交：请重点审核下方“与上一版本差异”（判定规格变化标红）和变更原因，然后【批准】或【驳回】（均需电子签名；批准人不能是提交人）。'
                  : '已提交，等待 QA 批准；批准前不生效，且不能修改。'
                : routing.status === 'DRAFT'
                  ? `草稿：可随时【保存草稿】；改完点【提交审批】（电子签名：编制），QA 批准后才生效。${needReason ? '本产品已有发布过的版本，提交审批时须填写变更原因及影响评估。' : ''}`
                  : '测试项设置上下限后，工位终端录入测试值时系统自动判定合格/不合格（不合格自动开 NCR）；已发布的工艺路线不能修改，变更请升版并经 QA 批准，已下达工单使用下达时的快照。'
          }
        />
        {(editing || routing.status === 'SUBMITTED' || others.length > 0) && (
          <DiffCard url={`/routings/${routing.id}/diff`} draft={draftBody} reason={editing ? reason ?? '' : routing.status === 'SUBMITTED' ? routing.change_reason ?? '' : undefined} stamp={routing.updated_at}
            onResult={setDiff} emphasize={routing.status === 'SUBMITTED'} />
        )}
        <Card size="small" title="基本信息">
          {editing ? (
            <Form form={form} layout="vertical" onValuesChange={() => setFormDirty(true)}
              initialValues={{ version: routing.version, name: routing.name, remark: routing.remark, change_reason: routing.change_reason }}>
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item label="产品"><Input disabled value={`${routing.material_code} ${routing.material_name}`} /></Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请填写版本号' }]}><Input /></Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item name="name" label="工艺名称"><Input /></Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item name="remark" label="备注"><Input /></Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="change_reason"
                    label={<Space>变更原因 / 影响评估{needReason && <Typography.Text type="secondary">（提交审批时必填）</Typography.Text>}
                      {diff?.base && diff.items.length > 0 && (
                        <Button size="small" type="link" onClick={() => {
                          const cur = form.getFieldValue('change_reason') || '';
                          form.setFieldsValue({ change_reason: `${cur ? `${cur}\n` : ''}变更内容：${diff.summary}` });
                          setFormDirty(true);
                        }}>插入变更摘要</Button>
                      )}
                    </Space>}
                    extra={needReason ? '说明变更了哪些工序/测试规格、原因及验证依据，以及对在制品和已放行产品的影响。保存草稿时可暂不填写。' : '首版可不填。'}
                  >
                    <Input.TextArea autoSize={{ minRows: 1, maxRows: 5 }} placeholder="如：光学测试辐照度下限由 40 调整为 42 mW/cm²（ECN-2026-016），依据验证报告 VR-0921" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          ) : (
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2, lg: 3 }}
              items={[
                { key: 'm', label: '产品', children: `${routing.material_code} ${routing.material_name}` },
                { key: 'n', label: '工艺名称', children: routing.name || '-' },
                { key: 'v', label: '版本', children: routing.version },
                { key: 's', label: '状态', children: <StatusTag dict="eng_status" value={routing.status} /> },
                { key: 'sub', label: '提交（编制）', children: routing.submitted_by ? `${routing.submitted_by}${routing.submitted_at ? ` · ${fmtDateTime(routing.submitted_at)}` : ''}` : '-' },
                { key: 'rel', label: '批准（QA）', children: routing.released_by ? `${routing.released_by}${routing.released_at ? ` · ${fmtDateTime(routing.released_at)}` : ''}` : '-' },
                { key: 'c', label: '创建', children: `${routing.created_by ?? '-'} · ${fmtDateTime(routing.created_at)}` },
                { key: 'r', label: '备注', children: routing.remark || '-' },
                { key: 'cr', label: '变更原因 / 影响评估', span: 'filled', children: <span style={{ whiteSpace: 'pre-wrap' }}>{routing.change_reason || '-'}</span> },
              ]}
            />
          )}
        </Card>
        <Card
          size="small"
          title={`工序（${editing ? live.length : (routing.operations || []).length}）`}
          extra={editing && <Typography.Text type="secondary">共 {paramCount} 个测试项；点“测试项”或“详情”在右侧抽屉编辑上下限、作业指导与附件</Typography.Text>}
        >
          {editing ? (
            <Table<OpRow>
              rowKey="_key"
              size="middle"
              columns={editCols}
              dataSource={ops}
              pagination={false}
              scroll={{ x: 'max-content' }}
              rowClassName={(o) => (o._del ? 'eng-row-del' : hl.get(`op:${up(o.code)}`) ? `eng-row-${hl.get(`op:${up(o.code)}`)}` : '')}
              footer={() => (
                <Button type="dashed" icon={<PlusOutlined />} onClick={addOp}>添加工序</Button>
              )}
            />
          ) : (
            <Table
              className="eng-ops-view"
              rowKey="id"
              size="middle"
              tableLayout="fixed"
              columns={viewCols}
              dataSource={routing.operations}
              pagination={false}
              expandable={{
                defaultExpandAllRows: true,
                rowExpandable: (o) => !!o.params?.length,
                expandedRowRender: (o) => (
                  <Table rowKey="id" size="small" tableLayout="fixed" columns={paramViewCols} dataSource={o.params} pagination={false} />
                ),
              }}
            />
          )}
        </Card>
        <Card size="small" title="签名记录">
          <SignatureHistory entity="eng_routing" id={routing.id} stamp={routing.updated_at} />
        </Card>
      </Space>
      <Drawer
        open={!!drawerOp}
        width="min(1240px, 96vw)"
        title={drawerOp ? `工序 ${drawerOp.seq ?? ''} ${drawerOp.name ?? ''}（${drawerOp.code ?? '未填编码'}）` : ''}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        extra={<Button type="primary" onClick={() => setDrawer(null)}>完成</Button>}
      >
        {drawerOp && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="工序信息">
              <Row gutter={16}>
                <Col span={6}>
                  <div className="ant-form-item-label"><label>标准工时（分）</label></div>
                  <InputNumber min={0} style={{ width: '100%' }} value={drawerOp.std_minutes} onChange={(v) => patch(drawerOp._key, { std_minutes: v })} />
                </Col>
                <Col span={6}>
                  <div className="ant-form-item-label"><label>SOP 编号</label></div>
                  <Input value={drawerOp.sop_no ?? ''} onChange={(e) => patch(drawerOp._key, { sop_no: e.target.value })} />
                </Col>
                <Col span={12}>
                  <div className="ant-form-item-label"><label><Tooltip title="本工序报工时需扫码绑定的关键件（如电源适配器），用于整机追溯">关键件绑定</Tooltip></label></div>
                  <MaterialSelect placeholder="不绑定" value={drawerOp.key_part_material_id} onChange={(v) => patch(drawerOp._key, { key_part_material_id: v ?? null })} />
                </Col>
                <Col span={24} style={{ marginTop: 12 }}>
                  <div className="ant-form-item-label"><label>作业指导（工位终端在右侧显示）</label></div>
                  <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} value={drawerOp.instructions ?? ''} placeholder="如：1. 开机预热 3 分钟；2. 探头距面板 15cm 垂直放置；3. 依次读取红光、近红外峰值波长与辐照度"
                    onChange={(e) => patch(drawerOp._key, { instructions: e.target.value })} />
                </Col>
              </Row>
            </Card>
            <Card size="small" title={`测试项（${drawerOp.params.filter((p) => !p._del).length}）`} extra={<Typography.Text type="secondary">编码在同一工序内必须唯一；OK/NG 型在工位点 OK / NG；合理范围用于拦截录错的数值</Typography.Text>}>
              <ParamsEditor op={drawerOp} hl={hl} onChange={(params) => patch(drawerOp._key, { params })} />
            </Card>
            {drawerOp.id ? (
              <Attachments entity="eng_routing_op" entityId={drawerOp.id} title="作业指导附件（图片 / SOP 文件，工位可查看）" hint="上传后永久保存；新版本自动带上" />
            ) : (
              <Alert type="info" showIcon message="新工序保存草稿后即可上传作业指导图片 / SOP 附件。" />
            )}
          </Space>
        )}
      </Drawer>
      <NewVersionModal
        open={verOpen}
        current={routing.version}
        onCancel={() => setVerOpen(false)}
        onOk={async (v) => {
          const nr = await post(`/routings/${routing.id}/new-version`, v);
          message.success(`已生成新版本 ${nr.version} 草稿，请修改后提交审批`);
          setVerOpen(false);
          nav(`/engineering/routings/${nr.id}`);
        }}
      />
    </>
  );
}

/** 编辑行 → 提交体（去掉待删除的行） */
function toPayloadOps(ops: OpRow[]) {
  return ops.filter((o) => !o._del).map((o) => ({
    seq: Number(o.seq),
    code: String(o.code ?? '').trim(),
    name: o.name,
    op_type: o.op_type || 'OTHER',
    work_center_id: o.work_center_id ?? null,
    std_minutes: Number(o.std_minutes) || 0,
    requires_equipment: !!o.requires_equipment,
    key_part_material_id: o.key_part_material_id ?? null,
    sop_no: o.sop_no || null,
    instructions: o.instructions || null,
    params: o.params.filter((p) => !p._del).map((p) => {
      const okng = p.param_type === 'OKNG';
      const n = (k: string) => (!okng && isNum(p[k]) ? Number(p[k]) : null);
      return {
        code: String(p.code ?? '').trim(),
        name: p.name,
        param_type: okng ? 'OKNG' : 'NUMBER',
        unit: okng ? null : p.unit || null,
        lower: n('lower'),
        upper: n('upper'),
        target: n('target'),
        decimals: n('decimals'),
        min_valid: n('min_valid'),
        max_valid: n('max_valid'),
      };
    }),
  }));
}

export default function RoutingDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [routing, setRouting] = useState<Rec | null>(null);
  const [versions, setVersions] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const r = await get(`/routings/${id}`);
      setRouting(r);
      get('/routings', { material_id: r.material_id, page_size: 50 }, true).then((d) => setVersions(d.items)).catch(() => undefined);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setRouting(null);
    load();
  }, [load]);

  if (failed && !routing) return <Result status="404" title="工艺路线不存在或无法加载" extra={<Button onClick={() => nav('/engineering/routings')}>返回列表</Button>} />;
  if (!routing) return <Spin style={{ display: 'block', padding: 80 }} />;
  return (
    <Spin spinning={loading}>
      <RoutingBody key={`${routing.id}-${routing.status}-${routing.updated_at}`} routing={routing} versions={versions} reload={load} />
    </Spin>
  );
}
