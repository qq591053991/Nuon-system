import {
  Alert, Button, Card, Col, Descriptions, Form, Input, InputNumber, Popconfirm, Result, Row, Select, Space, Spin, Switch, Table, Tag, Tooltip,
  Typography, message, type TableColumnsType,
} from 'antd';
import {
  ArrowLeftOutlined, BranchesOutlined, DeleteOutlined, ExperimentOutlined, PlusOutlined, SafetyCertificateOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState, type Key } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect, WorkCenterSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { NewVersionModal, uid } from './shared';

type ParamRow = Rec & { _key: string };
type OpRow = Rec & { _key: string; params: ParamRow[] };

const isNum = (v: any) => v !== null && v !== undefined && v !== '';

/** 规格显示：下限~上限 单位 */
function specText(p: Rec) {
  const u = p.unit ? ` ${p.unit}` : '';
  if (isNum(p.lower) && isNum(p.upper)) return `${p.lower} ~ ${p.upper}${u}`;
  if (isNum(p.lower)) return `≥ ${p.lower}${u}`;
  if (isNum(p.upper)) return `≤ ${p.upper}${u}`;
  return '仅记录（不判定）';
}

const toOpRows = (ops: Rec[]): OpRow[] =>
  ops.map((o) => ({ ...o, _key: uid(), params: ((o.params || []) as Rec[]).map((p) => ({ ...p, _key: uid() })) }));

/** 某工序的测试项编辑表 */
function ParamsEditor({ op, onChange }: { op: OpRow; onChange: (params: ParamRow[]) => void }) {
  const patch = (key: string, p: Rec) => onChange(op.params.map((x) => (x._key === key ? { ...x, ...p } : x)));
  const numCell = (r: ParamRow, k: string) => (
    <InputNumber
      style={{ width: 100 }}
      value={isNum(r[k]) ? r[k] : null}
      onChange={(v) => patch(r._key, { [k]: v })}
      status={k !== 'target' && isNum(r.lower) && isNum(r.upper) && r.lower > r.upper ? 'error' : undefined}
    />
  );
  const columns: TableColumnsType<ParamRow> = [
    { title: '测试项编码', key: 'code', width: 140, render: (_, r) => <Input placeholder="如 WL_PEAK" value={r.code ?? ''} onChange={(e) => patch(r._key, { code: e.target.value })} /> },
    { title: '测试项名称', key: 'name', width: 180, render: (_, r) => <Input placeholder="如 峰值波长" value={r.name ?? ''} onChange={(e) => patch(r._key, { name: e.target.value })} /> },
    { title: '单位', key: 'unit', width: 110, render: (_, r) => <Input placeholder="如 nm" value={r.unit ?? ''} onChange={(e) => patch(r._key, { unit: e.target.value })} /> },
    { title: '下限', key: 'lower', width: 110, render: (_, r) => numCell(r, 'lower') },
    { title: '上限', key: 'upper', width: 110, render: (_, r) => numCell(r, 'upper') },
    { title: '目标值', key: 'target', width: 110, render: (_, r) => numCell(r, 'target') },
    { title: '判定规格', key: 'spec', render: (_, r) => <Typography.Text type="secondary">{specText(r)}</Typography.Text> },
    {
      title: '', key: 'op', width: 50,
      render: (_, r) => <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => onChange(op.params.filter((x) => x._key !== r._key))} />,
    },
  ];
  return (
    <div style={{ padding: '4px 0 4px 24px' }}>
      <Table<ParamRow>
        rowKey="_key"
        size="small"
        columns={columns}
        dataSource={op.params}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '本工序没有测试项' }}
        footer={() => (
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => onChange([...op.params, { _key: uid() }])}>
            添加测试项
          </Button>
        )}
      />
    </div>
  );
}

function RoutingBody({ routing, versions, reload }: { routing: Rec; versions: Rec[]; reload: () => Promise<unknown> }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  const [form] = Form.useForm();
  const editing = routing.status === 'DRAFT' && can('engineering');
  const [ops, setOps] = useState<OpRow[]>(() => toOpRows(routing.operations || []));
  const [expanded, setExpanded] = useState<readonly Key[]>(() => ops.filter((o) => o.params.length).map((o) => o._key));
  const [busy, setBusy] = useState<string>();
  const [verOpen, setVerOpen] = useState(false);

  const patch = (key: string, p: Rec) => setOps((old) => old.map((o) => (o._key === key ? { ...o, ...p } : o)));
  const toggle = (key: string) => setExpanded((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]));
  const addOp = () => {
    const seq = ops.reduce((m, o) => Math.max(m, Number(o.seq) || 0), 0) + 10;
    setOps((old) => [...old, { _key: uid(), seq, op_type: 'ASSEMBLY', std_minutes: 0, requires_equipment: false, params: [] }]);
  };

  /** 校验并组装提交体；不通过返回 null */
  const collect = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return null;
    const fail = (msg: string) => {
      message.error(msg);
      return null;
    };
    const seqs = new Set<number>();
    for (const [i, o] of ops.entries()) {
      const label = `第 ${i + 1} 道工序`;
      if (!isNum(o.seq)) return fail(`${label}请填写工序号`);
      if (seqs.has(o.seq)) return fail(`工序号 ${o.seq} 重复`);
      seqs.add(o.seq);
      if (!o.code || !o.name) return fail(`${label}请填写工序编码和名称`);
      for (const p of o.params) {
        if (!p.code || !p.name) return fail(`工序【${o.name}】的测试项请填写编码和名称`);
        if (isNum(p.lower) && isNum(p.upper) && p.lower > p.upper) return fail(`工序【${o.name}】测试项【${p.name}】下限大于上限`);
      }
    }
    return {
      material_id: routing.material_id,
      version: v.version,
      name: v.name || null,
      remark: v.remark || null,
      operations: ops.map((o) => ({
        seq: Number(o.seq),
        code: o.code,
        name: o.name,
        op_type: o.op_type || 'OTHER',
        work_center_id: o.work_center_id ?? null,
        std_minutes: Number(o.std_minutes) || 0,
        requires_equipment: !!o.requires_equipment,
        key_part_material_id: o.key_part_material_id ?? null,
        sop_no: o.sop_no || null,
        instructions: o.instructions || null,
        params: o.params.map((p) => ({
          code: p.code,
          name: p.name,
          unit: p.unit || null,
          lower: isNum(p.lower) ? Number(p.lower) : null,
          upper: isNum(p.upper) ? Number(p.upper) : null,
          target: isNum(p.target) ? Number(p.target) : null,
        })),
      })),
    };
  };

  const save = async () => {
    const body = await collect();
    if (!body) return;
    setBusy('save');
    try {
      await put(`/routings/${routing.id}`, body);
      message.success('已保存');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const release = async () => {
    const body = await collect();
    if (!body) return;
    if (!body.operations.length) {
      message.error('工艺路线没有工序，不能发布');
      return;
    }
    let signature;
    try {
      signature = await sign({
        meaning: '工艺路线发布批准',
        description: `发布 ${routing.material_code} 工艺路线版本 ${body.version}：发布后新下达的工单将按此工序与测试规格执行，旧的已发布版本自动作废。`,
      });
    } catch (e) {
      if (isCancel(e)) return;
      throw e;
    }
    setBusy('release');
    try {
      await put(`/routings/${routing.id}`, body);
      await post(`/routings/${routing.id}/release`, { signature });
      message.success('工艺路线已发布');
      await reload();
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    await del(`/routings/${routing.id}`);
    message.success('草稿已删除');
    nav('/engineering/routings');
  };

  const paramsBtn = (o: OpRow) => (
    <Button size="small" icon={<ExperimentOutlined />} onClick={() => toggle(o._key)} type={o.params.length ? 'default' : 'dashed'}>
      测试项 {o.params.length}
    </Button>
  );

  const editCols: TableColumnsType<OpRow> = [
    { title: '工序号', key: 'seq', width: 80, render: (_, o) => <InputNumber min={1} style={{ width: 70 }} value={o.seq} onChange={(v) => patch(o._key, { seq: v })} /> },
    { title: '工序编码', key: 'code', width: 110, render: (_, o) => <Input style={{ width: 100 }} value={o.code ?? ''} onChange={(e) => patch(o._key, { code: e.target.value })} /> },
    { title: '工序名称', key: 'name', width: 170, render: (_, o) => <Input style={{ width: 160 }} value={o.name ?? ''} onChange={(e) => patch(o._key, { name: e.target.value })} /> },
    {
      title: '类型', key: 'op_type', width: 140,
      render: (_, o) => <Select style={{ width: 130 }} options={dictOptions('op_type')} value={o.op_type} onChange={(v) => patch(o._key, { op_type: v })} />,
    },
    { title: '测试项', key: 'params', width: 100, render: (_, o) => paramsBtn(o) },
    {
      title: '工作中心', key: 'wc', width: 180,
      render: (_, o) => <WorkCenterSelect style={{ width: 170 }} value={o.work_center_id} onChange={(v) => patch(o._key, { work_center_id: v ?? null })} />,
    },
    {
      title: '标准工时(分)', key: 'std', width: 110,
      render: (_, o) => <InputNumber min={0} style={{ width: 100 }} value={o.std_minutes} onChange={(v) => patch(o._key, { std_minutes: v })} />,
    },
    {
      title: <Tooltip title="报工时必须扫描设备/仪器编号；校准过期的仪器不能使用">需设备</Tooltip>, key: 'eq', width: 80, align: 'center',
      render: (_, o) => <Switch checked={!!o.requires_equipment} onChange={(v) => patch(o._key, { requires_equipment: v })} />,
    },
    {
      title: <Tooltip title="本工序报工时需扫码绑定的关键件（如主控板），用于整机追溯">关键件绑定</Tooltip>, key: 'kp', width: 240,
      render: (_, o) => (
        <MaterialSelect style={{ width: 230 }} placeholder="不绑定" value={o.key_part_material_id} onChange={(v) => patch(o._key, { key_part_material_id: v ?? null })} />
      ),
    },
    { title: 'SOP 编号', key: 'sop', width: 130, render: (_, o) => <Input style={{ width: 120 }} value={o.sop_no ?? ''} onChange={(e) => patch(o._key, { sop_no: e.target.value })} /> },
    {
      title: '作业指导', key: 'ins', width: 220,
      render: (_, o) => (
        <Input.TextArea style={{ width: 210 }} autoSize={{ minRows: 1, maxRows: 4 }} value={o.instructions ?? ''} onChange={(e) => patch(o._key, { instructions: e.target.value })} />
      ),
    },
    {
      title: '', key: 'del', width: 50, fixed: 'right',
      render: (_, o) => (
        <Popconfirm title="删除此工序（含测试项）？" onConfirm={() => setOps((old) => old.filter((x) => x._key !== o._key))}>
          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const viewCols: TableColumnsType<Rec> = [
    { title: '工序号', dataIndex: 'seq', width: 70 },
    { title: '工序编码', dataIndex: 'code', render: (v) => <span className="mono">{v}</span> },
    { title: '工序名称', dataIndex: 'name' },
    { title: '类型', dataIndex: 'op_type', render: (v) => <StatusTag dict="op_type" value={v} /> },
    { title: '工作中心', dataIndex: 'work_center_name', render: (v) => v || '-' },
    { title: '标准工时(分)', dataIndex: 'std_minutes', align: 'right', render: (v) => fmtQty(v) },
    { title: '需设备', dataIndex: 'requires_equipment', align: 'center', render: (v) => (v ? <Tag color="blue">是</Tag> : <span style={{ color: '#bbb' }}>否</span>) },
    { title: '关键件绑定', dataIndex: 'key_part_material_code', render: (v) => (v ? <Tag color="geekblue" className="mono">{v}</Tag> : '-') },
    { title: 'SOP 编号', dataIndex: 'sop_no', render: (v) => v || '-' },
    { title: '作业指导', dataIndex: 'instructions', ellipsis: true, width: 220, render: (v) => v || '-' },
    { title: '测试项', key: 'pc', render: (_, o) => (o.params?.length ? <Tag color="magenta">{o.params.length} 项</Tag> : '-') },
  ];

  const paramViewCols: TableColumnsType<Rec> = [
    { title: '测试项编码', dataIndex: 'code', width: 160, render: (v) => <span className="mono">{v}</span> },
    { title: '测试项名称', dataIndex: 'name', width: 280 },
    { title: '规格（下限~上限）', key: 'spec', width: 220, render: (_, p) => <b>{specText(p)}</b> },
    { title: '目标值', dataIndex: 'target', render: (v, p) => (isNum(v) ? `${v}${p.unit ? ` ${p.unit}` : ''}` : '-') },
  ];

  const others = versions.filter((v) => v.id !== routing.id);
  const paramCount = ops.reduce((s, o) => s + o.params.length, 0);

  return (
    <>
      {signHolder}
      <PageHeader
        title={<Space>工艺路线 {routing.material_code} {routing.material_name}<Tag>{routing.version}</Tag><StatusTag dict="eng_status" value={routing.status} /></Space>}
        sub={
          others.length ? (
            <Space size={4} wrap>
              其他版本：
              {others.map((v) => (
                <Link key={v.id} to={`/engineering/routings/${v.id}`}>
                  {v.version}（{(v.status === 'RELEASED' && '已发布') || (v.status === 'DRAFT' && '草稿') || '已作废'}）
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
                <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy} onClick={save}>保存</Button>
                <Button type="primary" icon={<SafetyCertificateOutlined />} loading={busy === 'release'} disabled={!!busy} onClick={release}>发布</Button>
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
              : '测试项设置上下限后，工位终端录入测试值时系统自动判定合格/不合格（不合格自动开 NCR）；已发布的工艺路线不能修改，变更请升版，已下达工单使用下达时的快照。'
          }
        />
        <Card size="small" title="基本信息">
          {editing ? (
            <Form form={form} layout="vertical" initialValues={{ version: routing.version, name: routing.name, remark: routing.remark }}>
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
                { key: 'rel', label: '发布', children: routing.released_by ? `${routing.released_by}${routing.released_at ? ` · ${fmtDateTime(routing.released_at)}` : ''}` : '-' },
                { key: 'c', label: '创建', children: `${routing.created_by ?? '-'} · ${fmtDateTime(routing.created_at)}` },
                { key: 'r', label: '备注', children: routing.remark || '-' },
              ]}
            />
          )}
        </Card>
        <Card
          size="small"
          title={`工序（${editing ? ops.length : (routing.operations || []).length}）`}
          extra={editing && <Typography.Text type="secondary">共 {paramCount} 个测试项；点击“测试项”按钮展开编辑上下限</Typography.Text>}
        >
          {editing ? (
            <Table<OpRow>
              rowKey="_key"
              size="middle"
              columns={editCols}
              dataSource={ops}
              pagination={false}
              scroll={{ x: 'max-content' }}
              expandable={{
                expandedRowKeys: expanded,
                onExpandedRowsChange: setExpanded,
                expandedRowRender: (o) => <ParamsEditor op={o} onChange={(params) => patch(o._key, { params })} />,
              }}
              footer={() => (
                <Button type="dashed" icon={<PlusOutlined />} onClick={addOp}>添加工序</Button>
              )}
            />
          ) : (
            <Table
              rowKey="id"
              size="middle"
              columns={viewCols}
              dataSource={routing.operations}
              pagination={false}
              scroll={{ x: 'max-content' }}
              expandable={{
                defaultExpandAllRows: true,
                rowExpandable: (o) => !!o.params?.length,
                expandedRowRender: (o) => (
                  <div style={{ padding: '4px 0 4px 24px' }}>
                    <Table rowKey="id" size="small" tableLayout="fixed" columns={paramViewCols} dataSource={o.params} pagination={false} />
                  </div>
                ),
              }}
            />
          )}
        </Card>
      </Space>
      <NewVersionModal
        open={verOpen}
        current={routing.version}
        onCancel={() => setVerOpen(false)}
        onOk={async (v) => {
          const nr = await post(`/routings/${routing.id}/new-version`, v);
          message.success(`已生成新版本 ${nr.version} 草稿，请修改后发布`);
          setVerOpen(false);
          nav(`/engineering/routings/${nr.id}`);
        }}
      />
    </>
  );
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
      <RoutingBody key={`${routing.id}-${routing.status}`} routing={routing} versions={versions} reload={load} />
    </Spin>
  );
}
