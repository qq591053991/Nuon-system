/**
 * BOM 详情 / 编辑 / 审批。
 * 好用性修复（docs/ux-review.md G5）：F10 未保存离开提示、变更原因只在提交审批时必填；F11 / D#2 与上一版本差异、删除可撤销、提交自动生成变更摘要；
 * F21 重复组件当场提示“已在第 N 行”；D#18 生效日期：未来日期批准后为“已批准待生效”，生效前旧版本继续用于新工单与 MRP。
 */
import {
  Alert, App, Button, Card, Col, DatePicker, Descriptions, Form, Input, InputNumber, Popconfirm, Result, Row, Space, Spin, Table, Tabs, Tag, Tooltip,
  Typography, type TableColumnsType,
} from 'antd';
import {
  ArrowLeftOutlined, BranchesOutlined, CloseCircleOutlined, DeleteOutlined, PlusOutlined, RollbackOutlined, SafetyCertificateOutlined, SaveOutlined, SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState, type Key } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty, toDate } from '../../utils/format';
import { NewVersionModal, toDayjs, uid, type LineRow } from './shared';
import { DiffCard, SignatureHistory, diffIndex, useUnsavedGuard, type DiffResult } from './EngSignatures';

const ENG_CSS = `
.eng-row-del td { background: #fafafa !important; color: #bfbfbf; text-decoration: line-through; }
.eng-row-del td:last-child { text-decoration: none; }
.eng-row-added td { background: #f6ffed !important; }
.eng-row-changed td:first-child { box-shadow: inset 4px 0 0 #1677ff; }
`;

/** 编辑行 → 提交体（去掉待删除和未选组件的空行） */
const toPayloadLines = (lines: LineRow[]) =>
  lines.filter((l) => !l._del && l.component_id).map((l) => ({
    component_id: l.component_id,
    qty_per: Number(l.qty_per),
    scrap_rate: (Number(l.scrap_pct) || 0) / 100,
    designator: l.designator || null,
    remark: l.remark || null,
  }));
const toLineRows = (lines: Rec[]): LineRow[] => lines.map((l) => ({ ...l, scrap_pct: l.scrap_rate ? Math.round(l.scrap_rate * 10000) / 100 : 0, _key: uid() }));

const CsTag = () => <Tag color="purple" style={{ marginInlineStart: 6 }}>客供料</Tag>;
const pct = (v?: number | null) => (v ? `${Math.round(v * 10000) / 100}%` : '-');

/** 多级 BOM 展开 */
function BomTree({ bomId, version }: { bomId: number; version: string }) {
  const [qty, setQty] = useState<number>(1);
  const [tree, setTree] = useState<Rec[]>([]);
  const [expanded, setExpanded] = useState<readonly Key[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (n: number) => {
    setLoading(true);
    try {
      const d = await get(`/boms/${bomId}/tree`, { qty: n });
      const keys: string[] = [];
      const walk = (ns: Rec[]) => ns.forEach((x) => { if (x.children?.length) { keys.push(x.key); walk(x.children); } });
      walk(d.tree || []);
      setTree(d.tree || []);
      setExpanded(keys);
    } finally {
      setLoading(false);
    }
  }, [bomId]);

  useEffect(() => {
    setQty(1);
    load(1);
  }, [load, version]);

  const columns: TableColumnsType<Rec> = [
    {
      title: '物料编码', dataIndex: 'code', width: 260,
      render: (v, r) => <span><span className="mono">{v}</span>{r.customer_supplied && <CsTag />}</span>,
    },
    { title: '名称', dataIndex: 'name' },
    { title: '规格', dataIndex: 'spec', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '单位', dataIndex: 'uom' },
    { title: '层级', dataIndex: 'level', align: 'center', render: (v) => `L${v}` },
    { title: '单位用量', dataIndex: 'qty_per', align: 'right', render: (v) => fmtQty(v) },
    { title: <Tooltip title="含损耗：上级总需求 × 单位用量 ×（1+损耗率）">总需求</Tooltip>, dataIndex: 'total_qty', align: 'right', render: (v) => <b>{fmtQty(v)}</b> },
    { title: '位号', dataIndex: 'designator', ellipsis: true, width: 180, render: (v) => v || '-' },
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <span>生产数量</span>
        <InputNumber min={0.0001} value={qty} onChange={(v) => setQty(Number(v) || 1)} onPressEnter={() => load(qty)} />
        <Button type="primary" onClick={() => load(qty)}>计算</Button>
        <Typography.Text type="secondary">展开基于已保存的内容；有已发布 BOM 的半成品会继续向下展开。</Typography.Text>
      </Space>
      <Table
        rowKey="key"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={tree}
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{ expandedRowKeys: expanded, onExpandedRowsChange: setExpanded }}
      />
    </>
  );
}

function BomBody({ bom, versions, reload }: { bom: Rec; versions: Rec[]; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { message } = App.useApp();
  const { can, user } = useAuth();
  const [sign, signHolder] = useESign();
  const [form] = Form.useForm();
  const editing = bom.status === 'DRAFT' && can('engineering');
  const reviewing = bom.status === 'SUBMITTED' && can('qa');
  /** 该产品已有发布过的版本：提交时须填写变更原因 */
  const needReason = versions.some((v) => v.id !== bom.id && (v.status === 'RELEASED' || v.status === 'OBSOLETE'));
  const selfSubmitted = !!bom.submitted_by && bom.submitted_by === user?.full_name;
  const [lines, setLines] = useState<LineRow[]>(() => toLineRows(bom.lines as Rec[]));
  const [initial] = useState(() => JSON.stringify(toPayloadLines(toLineRows(bom.lines as Rec[]))));
  const [formDirty, setFormDirty] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [verOpen, setVerOpen] = useState(false);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const reason: string | undefined = Form.useWatch('change_reason', form);
  const payloadLines = useMemo(() => toPayloadLines(lines), [lines]);
  const dirty = editing && (formDirty || JSON.stringify(payloadLines) !== initial);
  const bypass = useUnsavedGuard(dirty);
  const hl = useMemo(() => diffIndex(diff), [diff]);
  const current = versions.find((v) => v.id !== bom.id && v.status === 'RELEASED');
  const effFuture = !!bom.effective_date && dayjs(bom.effective_date).isAfter(dayjs(), 'day');

  const patch = (key: string, p: Rec) => setLines((old) => old.map((r) => (r._key === key ? { ...r, ...p } : r)));
  /** 重复组件：行 key → 与第几行重复（F21 当场提示） */
  const dupOf = useMemo(() => {
    const first = new Map<number, number>();
    const out = new Map<string, number>();
    lines.forEach((l, i) => {
      if (l._del || !l.component_id) return;
      if (first.has(l.component_id)) out.set(l._key, first.get(l.component_id)! + 1);
      else first.set(l.component_id, i);
    });
    return out;
  }, [lines]);

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
    const fail = (msg: string) => {
      message.error(msg);
      return null;
    };
    for (const [i, l] of lines.entries()) {
      if (l._del || !l.component_id) continue;
      if (!(Number(l.qty_per) > 0)) return fail(`第 ${i + 1} 行单位用量必须大于 0`);
      if (dupOf.has(l._key)) return fail(`第 ${i + 1} 行组件 ${l.component_code} 已在第 ${dupOf.get(l._key)} 行，请合并为一行`);
    }
    return {
      material_id: bom.material_id,
      version: v.version,
      ecn_no: v.ecn_no || null,
      effective_date: toDate(v.effective_date),
      remark: v.remark || null,
      change_reason: v.change_reason?.trim() || null,
      lines: payloadLines,
    };
  };

  const save = async () => {
    const body = await collect();
    if (!body) return;
    setBusy('save');
    try {
      await put(`/boms/${bom.id}`, body);
      message.success('草稿已保存');
      bypass();
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** 签名后执行；用户取消签名时静默返回 */
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
    if (!body.lines.length) {
      message.error('BOM 没有组件，不能提交');
      return;
    }
    const summary = diff?.base ? diff.summary : '';
    setBusy('submit');
    try {
      const ok = await signed(() => sign({
        meaning: 'BOM编制提交',
        description: `提交 ${bom.material_code} 版本 ${body.version} 给 QA 审核：批准前不生效；提交后不能修改，如需修改请由 QA 驳回。${summary ? `\n变更摘要：${summary}` : ''}`,
        defaultReason: summary ? `变更摘要：${summary}`.slice(0, 250) : undefined,
        submit: async (signature) => {
          await put(`/boms/${bom.id}`, body);
          return post(`/boms/${bom.id}/submit`, { signature, change_reason: body.change_reason }, true);
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

  /** QA 批准（电子签名：批准）→ 生效（生效日期在未来：已批准待生效，旧版本继续使用到生效日） */
  const approve = async () => {
    const eff = bom.effective_date ? dayjs(bom.effective_date).format('YYYY-MM-DD') : null;
    setBusy('approve');
    try {
      const ok = await signed(() => sign({
        meaning: 'BOM批准',
        description: effFuture
          ? `批准后 ${bom.material_code} 版本 ${bom.version} 将于 ${eff} 生效；生效前新下达的工单和 MRP 继续使用${current ? `当前版本 ${current.version}` : '当前已发布版本'}，到生效日原版本自动作废。已下达的工单不受影响。`
          : `批准后 ${bom.material_code} 版本 ${bom.version} 立即生效（生效日期 ${eff ?? '今天'}），原已发布版本自动作废；已下达的工单不受影响。${diff?.base ? `\n本次变更：${diff.summary}` : ''}`,
        submit: (signature) => post(`/boms/${bom.id}/approve`, { signature }, true),
      }));
      if (!ok) return;
      message.success(effFuture ? `BOM 已批准，将于 ${eff} 生效` : 'BOM 已批准生效');
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
        meaning: 'BOM驳回',
        description: '驳回后退回草稿，由工程师修改后重新提交。',
        reasonRequired: true,
        reasonLabel: '驳回原因',
        reasonPlaceholder: '如：组件用量与图纸不符，请复核后重新提交',
        submit: (signature) => post(`/boms/${bom.id}/reject`, { reason: signature.reason, signature }, true),
      }));
      if (!ok) return;
      message.success('已驳回，退回工程师修改');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    await del(`/boms/${bom.id}`);
    message.success('草稿已删除');
    bypass();
    nav('/engineering/boms');
  };

  const editCols: TableColumnsType<LineRow> = [
    { title: '#', key: 'idx', width: 44, render: (_, __, i) => i + 1 },
    {
      title: '组件', key: 'component', width: 330,
      render: (_, r) => (
        <div>
          <Space size={0}>
            <MaterialSelect
              style={{ width: 300 }}
              disabled={r._del}
              status={dupOf.has(r._key) && !r._del ? 'error' : undefined}
              value={r.component_id}
              onPick={(m) => {
                const at = m ? lines.findIndex((x) => x._key !== r._key && !x._del && x.component_id === m.id) : -1;
                if (at >= 0) message.warning(`${m!.code} 已在第 ${at + 1} 行，请直接修改那一行的用量（同一组件只能出现一次）`);
                patch(r._key, {
                  component_id: m?.id, component_code: m?.code, component_name: m?.name, component_spec: m?.spec,
                  component_uom: m?.uom, customer_supplied: !!m?.owner_customer_id,
                });
              }}
            />
            {r.customer_supplied && <CsTag />}
          </Space>
          {dupOf.has(r._key) && !r._del && <div style={{ color: '#cf1322', fontSize: 12 }}>已在第 {dupOf.get(r._key)} 行，请合并为一行</div>}
        </div>
      ),
    },
    { title: '单位', dataIndex: 'component_uom', width: 60, render: (v) => v || '-' },
    {
      title: '单位用量', key: 'qty_per', width: 120,
      render: (_, r) => <InputNumber min={0} style={{ width: 110 }} value={r.qty_per} onChange={(v) => patch(r._key, { qty_per: v })} />,
    },
    {
      title: '损耗率', key: 'scrap', width: 120,
      render: (_, r) => <InputNumber min={0} max={100} style={{ width: 110 }} suffix="%" value={r.scrap_pct} onChange={(v) => patch(r._key, { scrap_pct: v })} />,
    },
    {
      title: '位号', key: 'designator', width: 200,
      render: (_, r) => <Input value={r.designator ?? ''} onChange={(e) => patch(r._key, { designator: e.target.value })} />,
    },
    { title: '备注', key: 'remark', width: 180, render: (_, r) => <Input value={r.remark ?? ''} onChange={(e) => patch(r._key, { remark: e.target.value })} /> },
    {
      title: '', key: 'op', width: 84, fixed: 'right',
      render: (_, r) => (r._del ? (
        <Button size="small" icon={<RollbackOutlined />} onClick={() => patch(r._key, { _del: false })}>撤销</Button>
      ) : (
        <Tooltip title="删除（保存前可撤销）">
          <Button type="text" danger size="small" icon={<DeleteOutlined />}
            onClick={() => (r.id ? patch(r._key, { _del: true }) : setLines((old) => old.filter((x) => x._key !== r._key)))} />
        </Tooltip>
      )),
    },
  ];

  const viewCols: TableColumnsType<Rec> = [
    { title: '行号', dataIndex: 'line_no', width: 60 },
    { title: '组件编码', dataIndex: 'component_code', render: (v, r) => <span><span className="mono">{v}</span>{r.customer_supplied && <CsTag />}</span> },
    { title: '名称', dataIndex: 'component_name' },
    { title: '规格', dataIndex: 'component_spec', ellipsis: true, width: 220, render: (v) => v || '-' },
    { title: '单位', dataIndex: 'component_uom' },
    { title: '单位用量', dataIndex: 'qty_per', align: 'right', render: (v) => fmtQty(v) },
    { title: '损耗率', dataIndex: 'scrap_rate', align: 'right', render: pct },
    { title: '位号', dataIndex: 'designator', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '备注', dataIndex: 'remark', render: (v) => v || '-' },
  ];

  const others = versions.filter((v) => v.id !== bom.id);

  return (
    <>
      {signHolder}
      <style>{ENG_CSS}</style>
      <PageHeader
        title={<Space>BOM {bom.material_code} {bom.material_name}<Tag>{bom.version}</Tag><StatusTag dict="eng_status" value={bom.status} />{dirty && <Tag color="orange">未保存</Tag>}</Space>}
        sub={others.length ? (
          <Space size={4} wrap>
            其他版本：
            {others.map((v) => (
              <Link key={v.id} to={`/engineering/boms/${v.id}`}>
                {v.version}（{dictLabel('eng_status', v.status)}）
              </Link>
            ))}
          </Space>
        ) : undefined}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/engineering/boms')}>返回列表</Button>
            {editing && (
              <>
                <Popconfirm title="确定删除此 BOM 草稿？" onConfirm={remove}>
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
            {bom.status === 'RELEASED' && can('engineering') && (
              <Button type="primary" icon={<BranchesOutlined />} onClick={() => setVerOpen(true)}>升版</Button>
            )}
          </>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type={bom.status === 'OBSOLETE' ? 'warning' : 'info'}
          showIcon
          message={
            bom.status === 'OBSOLETE'
              ? '此版本已作废（已被新版本替代），仅供查阅。'
              : bom.status === 'APPROVED'
                ? `已批准，将于 ${fmtDate(bom.effective_date)} 生效；生效前新下达的工单和 MRP 继续使用${current ? `当前版本 ${current.version}` : '当前已发布版本'}，到期自动切换。`
                : bom.status === 'SUBMITTED'
                  ? reviewing
                    ? `工程师已提交：请审核下方“与上一版本差异”（删除行、用量变化标红）与变更原因后【批准】或【驳回】（均需电子签名；批准人不能是提交人）。${effFuture ? `生效日期 ${fmtDate(bom.effective_date)}：批准后到该日才生效。` : ''}`
                    : '已提交，等待 QA 批准；批准前不生效，且不能修改。'
                  : bom.status === 'DRAFT'
                    ? `草稿：可随时【保存草稿】；录入组件后点【提交审批】（电子签名：编制），QA 批准（电子签名）后才生效。${needReason ? '本产品已有发布过的版本，提交审批时须填写变更原因及影响评估。' : ''}`
                    : 'GMP：BOM 变更须经 QA 批准；已发布的 BOM 不能修改，变更请升版（ECN），已下达工单使用下达时的快照。'
          }
        />
        {(editing || bom.status === 'SUBMITTED' || others.length > 0) && (
          <DiffCard url={`/boms/${bom.id}/diff`} draft={editing ? { lines: payloadLines } : null} reason={editing ? reason ?? '' : bom.status === 'SUBMITTED' ? bom.change_reason ?? '' : undefined}
            stamp={bom.updated_at} onResult={setDiff} emphasize={bom.status === 'SUBMITTED'} />
        )}
        <Card size="small" title="基本信息">
          {editing ? (
            <Form
              form={form}
              onValuesChange={() => setFormDirty(true)}
              layout="vertical"
              initialValues={{ version: bom.version, ecn_no: bom.ecn_no, effective_date: toDayjs(bom.effective_date), remark: bom.remark, change_reason: bom.change_reason }}
            >
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item label="产品"><Input disabled value={`${bom.material_code} ${bom.material_name}`} /></Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请填写版本号' }]}><Input /></Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item name="ecn_no" label="ECN 编号"><Input /></Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item name="effective_date" label="生效日期" tooltip="留空 = 批准当天生效；填未来日期 = 批准后到该日才生效，此前新工单和 MRP 继续用当前版本">
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} md={4}>
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
                    extra={needReason ? '说明变更内容、原因，以及对在制品、库存、已发货产品和注册/客户的影响。保存草稿时可暂不填写。' : '首版可不填。'}
                  >
                    <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder="如：LED 供应商变更（ECN-2026-015），光学性能经验证无差异；在制品按旧版本完工" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          ) : (
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2, lg: 3 }}
              items={[
                { key: 'm', label: '产品', children: `${bom.material_code} ${bom.material_name}` },
                { key: 'v', label: '版本', children: bom.version },
                { key: 's', label: '状态', children: <StatusTag dict="eng_status" value={bom.status} /> },
                { key: 'ecn', label: 'ECN 编号', children: bom.ecn_no || '-' },
                { key: 'eff', label: '生效日期', children: fmtDate(bom.effective_date) },
                { key: 'sub', label: '提交（编制）', children: bom.submitted_by ? `${bom.submitted_by}${bom.submitted_at ? ` · ${fmtDateTime(bom.submitted_at)}` : ''}` : '-' },
                { key: 'rel', label: '批准（QA）', children: bom.released_by ? `${bom.released_by}${bom.released_at ? ` · ${fmtDateTime(bom.released_at)}` : ''}` : '-' },
                { key: 'c', label: '创建', children: `${bom.created_by ?? '-'} · ${fmtDateTime(bom.created_at)}` },
                { key: 'r', label: '备注', children: bom.remark || '-' },
                { key: 'cr', label: '变更原因 / 影响评估', span: 'filled', children: <span style={{ whiteSpace: 'pre-wrap' }}>{bom.change_reason || '-'}</span> },
              ]}
            />
          )}
        </Card>
        <Card size="small">
          <Tabs
            items={[
              {
                key: 'lines',
                label: `BOM 明细（${editing ? lines.filter((l) => !l._del).length : bom.lines.length}）`,
                children: editing ? (
                  <Table<LineRow>
                    rowKey="_key"
                    size="middle"
                    columns={editCols}
                    dataSource={lines}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    rowClassName={(r) => (r._del ? 'eng-row-del' : r.component_id && hl.get(`line:${r.component_id}`) ? `eng-row-${hl.get(`line:${r.component_id}`)}` : '')}
                    footer={() => (
                      <Button type="dashed" icon={<PlusOutlined />} onClick={() => setLines((old) => [...old, { _key: uid(), qty_per: 1, scrap_pct: 0 }])}>
                        添加组件
                      </Button>
                    )}
                  />
                ) : (
                  <Table rowKey="id" size="middle" columns={viewCols} dataSource={bom.lines} pagination={false} scroll={{ x: 'max-content' }} />
                ),
              },
              { key: 'tree', label: '多级展开', children: <BomTree bomId={bom.id} version={bom.updated_at} /> },
              { key: 'sig', label: '签名记录', children: <SignatureHistory entity="eng_bom" id={bom.id} stamp={bom.updated_at} /> },
            ]}
          />
        </Card>
      </Space>
      <NewVersionModal
        open={verOpen}
        current={bom.version}
        withEcn
        onCancel={() => setVerOpen(false)}
        onOk={async (v) => {
          const nb = await post(`/boms/${bom.id}/new-version`, v);
          message.success(`已生成新版本 ${nb.version} 草稿，请修改后提交审批`);
          setVerOpen(false);
          nav(`/engineering/boms/${nb.id}`);
        }}
      />
    </>
  );
}

export default function BomDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [bom, setBom] = useState<Rec | null>(null);
  const [versions, setVersions] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const b = await get(`/boms/${id}`);
      setBom(b);
      get('/boms', { material_id: b.material_id, page_size: 50 }, true).then((d) => setVersions(d.items)).catch(() => undefined);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setBom(null);
    load();
  }, [load]);

  if (failed && !bom) return <Result status="404" title="BOM 不存在或无法加载" extra={<Button onClick={() => nav('/engineering/boms')}>返回列表</Button>} />;
  if (!bom) return <Spin style={{ display: 'block', padding: 80 }} />;
  return (
    <Spin spinning={loading}>
      <BomBody key={`${bom.id}-${bom.status}-${bom.updated_at}`} bom={bom} versions={versions} reload={load} />
    </Spin>
  );
}
