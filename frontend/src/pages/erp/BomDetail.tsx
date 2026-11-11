import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Form, Input, InputNumber, Popconfirm, Result, Row, Space, Spin, Table, Tabs, Tag, Tooltip,
  Typography, message, type TableColumnsType,
} from 'antd';
import { ArrowLeftOutlined, BranchesOutlined, CloseCircleOutlined, DeleteOutlined, PlusOutlined, SafetyCertificateOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState, type Key } from 'react';
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
import { SignatureHistory } from './EngSignatures';

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
  const { can, user } = useAuth();
  const [sign, signHolder] = useESign();
  const [form] = Form.useForm();
  const editing = bom.status === 'DRAFT' && can('engineering');
  const reviewing = bom.status === 'SUBMITTED' && can('qa');
  /** 该产品已有发布过的版本：提交时须填写变更原因 */
  const needReason = versions.some((v) => v.id !== bom.id && (v.status === 'RELEASED' || v.status === 'OBSOLETE'));
  const selfSubmitted = !!bom.submitted_by && bom.submitted_by === user?.full_name;
  const [lines, setLines] = useState<LineRow[]>(() =>
    (bom.lines as Rec[]).map((l) => ({ ...l, scrap_pct: l.scrap_rate ? Math.round(l.scrap_rate * 10000) / 100 : 0, _key: uid() })),
  );
  const [busy, setBusy] = useState<string>();
  const [verOpen, setVerOpen] = useState(false);

  const patch = (key: string, p: Rec) => setLines((old) => old.map((r) => (r._key === key ? { ...r, ...p } : r)));

  /** 校验并组装提交体；不通过返回 null */
  const collect = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return null;
    const fail = (msg: string) => {
      message.error(msg);
      return null;
    };
    const used = lines.filter((l) => l.component_id);
    for (const [i, l] of used.entries()) {
      if (!(Number(l.qty_per) > 0)) return fail(`第 ${i + 1} 行单位用量必须大于 0`);
    }
    const ids = used.map((l) => l.component_id);
    const dup = used.find((l, i) => ids.indexOf(l.component_id) !== i);
    if (dup) return fail(`组件 ${dup.component_code} 重复出现，请合并为一行`);
    return {
      material_id: bom.material_id,
      version: v.version,
      ecn_no: v.ecn_no || null,
      effective_date: toDate(v.effective_date),
      remark: v.remark || null,
      change_reason: v.change_reason?.trim() || null,
      lines: used.map((l) => ({
        component_id: l.component_id,
        qty_per: Number(l.qty_per),
        scrap_rate: (Number(l.scrap_pct) || 0) / 100,
        designator: l.designator || null,
        remark: l.remark || null,
      })),
    };
  };

  const save = async () => {
    const body = await collect();
    if (!body) return;
    setBusy('save');
    try {
      await put(`/boms/${bom.id}`, body);
      message.success('已保存');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** 签名后执行；用户取消签名时静默返回 */
  const signed = async (opts: Parameters<typeof sign>[0]) => {
    try {
      return await sign(opts);
    } catch (e) {
      if (isCancel(e)) return null;
      throw e;
    }
  };

  /** 工程师提交（电子签名：编制）→ 待 QA 批准 */
  const submit = async () => {
    const body = await collect();
    if (!body) return;
    if (!body.lines.length) {
      message.error('BOM 没有组件，不能提交');
      return;
    }
    const signature = await signed({
      meaning: 'BOM编制提交',
      description: `提交 ${bom.material_code} 版本 ${body.version} 给 QA 审核：批准前不生效；提交后不能修改，如需修改请由 QA 驳回。`,
    });
    if (!signature) return;
    setBusy('submit');
    try {
      await put(`/boms/${bom.id}`, body);
      await post(`/boms/${bom.id}/submit`, { signature, change_reason: body.change_reason });
      message.success('已提交，等待 QA 批准');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** QA 批准（电子签名：批准）→ 生效 */
  const approve = async () => {
    const signature = await signed({
      meaning: 'BOM批准',
      description: `批准后 ${bom.material_code} 版本 ${bom.version} 立即生效，原已发布版本自动作废；已下达的工单不受影响。`,
    });
    if (!signature) return;
    setBusy('approve');
    try {
      await post(`/boms/${bom.id}/approve`, { signature });
      message.success('BOM 已批准生效');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  /** QA 驳回（电子签名 + 原因）→ 退回草稿 */
  const reject = async () => {
    const signature = await signed({
      meaning: 'BOM驳回',
      description: '驳回后退回草稿，由工程师修改后重新提交。',
      reasonRequired: true,
      reasonLabel: '驳回原因',
      reasonPlaceholder: '如：组件用量与图纸不符，请复核后重新提交',
    });
    if (!signature) return;
    setBusy('reject');
    try {
      await post(`/boms/${bom.id}/reject`, { reason: signature.reason, signature });
      message.success('已驳回，退回工程师修改');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    await del(`/boms/${bom.id}`);
    message.success('草稿已删除');
    nav('/engineering/boms');
  };

  const editCols: TableColumnsType<LineRow> = [
    { title: '#', key: 'idx', width: 44, render: (_, __, i) => i + 1 },
    {
      title: '组件', key: 'component', width: 330,
      render: (_, r) => (
        <Space size={0}>
          <MaterialSelect
            style={{ width: 300 }}
            value={r.component_id}
            onPick={(m) =>
              patch(r._key, {
                component_id: m?.id, component_code: m?.code, component_name: m?.name, component_spec: m?.spec,
                component_uom: m?.uom, customer_supplied: !!m?.owner_customer_id,
              })
            }
          />
          {r.customer_supplied && <CsTag />}
        </Space>
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
      title: '', key: 'op', width: 50, fixed: 'right',
      render: (_, r) => <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => setLines((old) => old.filter((x) => x._key !== r._key))} />,
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
      <PageHeader
        title={<Space>BOM {bom.material_code} {bom.material_name}<Tag>{bom.version}</Tag><StatusTag dict="eng_status" value={bom.status} /></Space>}
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
                <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy} onClick={save}>保存</Button>
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
              : bom.status === 'SUBMITTED'
                ? reviewing
                  ? '工程师已提交：请审核组件、用量与变更原因后【批准】或【驳回】（均需电子签名；批准人不能是提交人）。'
                  : '已提交，等待 QA 批准；批准前不生效，且不能修改。'
                : bom.status === 'DRAFT'
                  ? `草稿：录入组件后点击【提交审批】（电子签名：编制），QA 批准（电子签名）后才生效。${needReason ? '本产品已有发布过的版本，须填写变更原因及影响评估。' : ''}`
                  : 'GMP：BOM 变更须经 QA 批准；已发布的 BOM 不能修改，变更请升版（ECN），已下达工单使用下达时的快照。'
          }
        />
        <Card size="small" title="基本信息">
          {editing ? (
            <Form
              form={form}
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
                  <Form.Item name="effective_date" label="生效日期" tooltip="留空则发布当天生效"><DatePicker style={{ width: '100%' }} /></Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item name="remark" label="备注"><Input /></Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="change_reason"
                    label="变更原因 / 影响评估"
                    rules={[{ required: needReason, whitespace: true, message: '本产品已有发布过的版本，请填写变更原因及影响评估' }]}
                    extra={needReason ? '说明变更内容、原因，以及对在制品、库存、已发货产品和注册/客户的影响。' : '首版可不填。'}
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
                { key: 'cr', label: '变更原因 / 影响评估', span: 'filled', children: bom.change_reason || '-' },
              ]}
            />
          )}
        </Card>
        <Card size="small">
          <Tabs
            items={[
              {
                key: 'lines',
                label: `BOM 明细（${editing ? lines.length : bom.lines.length}）`,
                children: editing ? (
                  <Table<LineRow>
                    rowKey="_key"
                    size="middle"
                    columns={editCols}
                    dataSource={lines}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
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
      <BomBody key={`${bom.id}-${bom.status}`} bom={bom} versions={versions} reload={load} />
    </Spin>
  );
}
