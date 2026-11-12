import {
  Alert, App, Button, Card, DatePicker, Descriptions, Empty, Form, Input, InputNumber, Modal, Popconfirm, Progress, Result, Select,
  Space, Spin, Steps, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  ArrowLeftOutlined, ColumnHeightOutlined, EditOutlined, ExportOutlined, FileProtectOutlined, FormOutlined, InboxOutlined, ReloadOutlined, ScanOutlined, SendOutlined,
  SplitCellsOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { EquipmentSelect, LocationSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty, toDate } from '../../utils/format';
import { KittingTable, kittingSummary } from '../erp/shared';
import { ReleaseBatchModal, WoReleaseHistory } from './ReleaseBatch';
import { PRIORITY_OPTIONS, ParamsText, inSpec, num, specText, type SpecParam } from './spec';

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const sortedOps = (wo: Rec): Rec[] => [...(wo.operations || [])].sort((a, b) => a.seq - b.seq);

/** 批量报工时各工序的可报数量 = 上道工序合格数（首道为计划数） − 本工序已报合格 − 本工序已报不良 */
function availOf(wo: Rec, ops: Rec[], idx: number) {
  const upstream = idx === 0 ? wo.planned_qty : ops[idx - 1].good_qty || 0;
  return r4(upstream - (ops[idx].good_qty || 0) - (ops[idx].ng_qty || 0));
}

/** 工单当前所处的流程节点（Steps） */
function stepState(wo: Rec): { current: number; status: 'wait' | 'process' | 'finish' | 'error' } {
  switch (wo.status) {
    case 'PLANNED':
      return { current: 1, status: 'process' };
    case 'RELEASED':
    case 'IN_PROGRESS':
      return { current: 2, status: 'process' };
    case 'COMPLETED':
      return { current: 4, status: wo.dhr_status === 'REJECTED' ? 'error' : 'process' };
    case 'CLOSED':
      return { current: 4, status: wo.dhr_status === 'REJECTED' ? 'error' : 'finish' };
    default:
      return { current: 0, status: 'error' };
  }
}

/** 根据状态告诉用户“下一步做什么” */
function guide(wo: Rec): { type: 'info' | 'success' | 'warning' | 'error'; text: string } {
  const pendingFg = r4((wo.completed_qty || 0) - (wo.received_qty || 0));
  switch (wo.status) {
    case 'PLANNED':
      return { type: 'info', text: '下一步：先看【齐套检查】页签确认物料是否齐套，产品、数量和计划日期无误后点击【下达】。下达后未开工的部分仍可【调整】数量和日期。' };
    case 'RELEASED':
      return {
        type: 'info',
        text: `下一步：先看【齐套检查】（只读，不占库存），齐套后点击【生成领料单】，系统按 FEFO 自动分配合格批次，仓库过账发料后即可开工；${wo.serial_control ? '在工位终端逐台扫码报工' : '在本页【批量报工】'}。`,
      };
    case 'IN_PROGRESS':
      return {
        type: 'info',
        text: `生产中：${wo.serial_control ? '各工位扫码过站，测试数据自动判定，不合格自动开 NCR' : '按工序批量报工，不良数量自动开 NCR'}。${pendingFg > 0 ? `已有 ${num(pendingFg)} 件完工未入库，可分批【完工入库】。` : ''}${(wo.received_qty || 0) > (wo.released_qty || 0) ? '已入库的成品可由 QA【分批放行】后先行发货。' : ''}`,
      };
    case 'COMPLETED':
      if (pendingFg > 0) return { type: 'warning', text: `下一步：还有 ${num(pendingFg)} 件完工产品未入库，请【完工入库】（入库后为“待放行”）。` };
      if (wo.dhr_status === 'REJECTED') return { type: 'error', text: 'QA 已拒绝放行，该批成品已冻结（HOLD），请根据拒绝原因处理。' };
      return {
        type: 'warning',
        text: `生产已完工并全部入库，等待 QA 审核 DHR 并电子签名放行（可分批放行，或【放行全部剩余】）；未放行的成品不能发货。${(wo.released_qty || 0) > 0 ? `已放行 ${num(wo.released_qty)} / 已入库 ${num(wo.received_qty)}。` : ''}`,
      };
    case 'CLOSED':
      return { type: 'success', text: '该批已由 QA 审核 DHR 并放行，成品为合格库存，可以发货。' };
    case 'CANCELLED':
      return { type: 'error', text: wo.lot_no ? '工单已取消，下达时生成的序列号已作废。' : '工单已取消（未下达，未生成序列号）。' };
    default:
      return { type: 'info', text: '' };
  }
}

// ---------------- 弹窗：领料单生成结果 ----------------
function IssueResultModal({ issue, onClose, onPosted }: { issue: Rec | null; onClose: () => void; onPosted: () => void }) {
  const { can } = useAuth();
  const [posting, setPosting] = useState(false);
  const shortages: Rec[] = issue?.shortages || [];
  const postNow = async () => {
    setPosting(true);
    try {
      await post(`/issues/${issue!.id}/confirm`);
      message.success(`领料单 ${issue!.no} 已过账：库存已扣减，批次已记入工单追溯`);
      onPosted();
      onClose();
    } finally {
      setPosting(false);
    }
  };
  return (
    <Modal
      open={!!issue}
      width={860}
      title={`领料单 ${issue?.no ?? ''} 已生成（待过账）`}
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button key="later" onClick={onClose}>稍后由仓库过账</Button>,
        <Tooltip key="now" title={can('wms') ? '' : '需要仓库权限才能过账'}>
          <Button type="primary" loading={posting} disabled={!can('wms')} onClick={postNow}>立即过账</Button>
        </Tooltip>,
      ]}
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="系统已按 FEFO（先到期先出）自动分配合格（已检验放行）批次；待检、不合格、过期批次不会被分配。" />
      {shortages.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`缺料 ${shortages.length} 项，以下物料可用库存不足：`}
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {shortages.map((s) => (
                <li key={s.material_id} style={{ color: '#cf1322' }}>
                  {s.material_code} {s.material_name}：需领 {num(s.required)}，缺 <b>{num(s.shortage)}</b>
                  {s.customer_supplied && '（客供料：请通知客户补料）'}
                </li>
              ))}
            </ul>
          }
        />
      )}
      <Table<Rec>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={issue?.lines || []}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '物料', dataIndex: 'material_code', render: (v, r) => <span>{v} {r.material_name}</span> },
          { title: '批号', dataIndex: 'lot_no', render: (v) => <span className="mono">{v || '-'}</span> },
          { title: '库位', dataIndex: 'location_code' },
          { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => `${fmtQty(v)} ${r.uom ?? ''}` },
          { title: '有效期至', dataIndex: 'expiry_date', render: (v) => fmtDate(v) },
          { title: '客供料', dataIndex: 'owner_customer_id', render: (v) => (v ? <Tag color="purple">客供料</Tag> : '-') },
        ]}
      />
    </Modal>
  );
}

// ---------------- 弹窗：批量报工（非序列号产品） ----------------
function BatchReportModal({ wo, open, onClose, onDone }: { wo: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const ops = useMemo(() => sortedOps(wo), [wo]);
  const seq = Form.useWatch('seq', form);
  const good = Form.useWatch('good_qty', form) || 0;
  const ng = Form.useWatch('ng_qty', form) || 0;
  const vals: Rec = Form.useWatch('values', form) || {};
  const idx = ops.findIndex((o) => o.seq === seq);
  const op = idx >= 0 ? ops[idx] : undefined;
  const avail = idx >= 0 ? availOf(wo, ops, idx) : 0;
  const params: SpecParam[] = op?.params || [];

  const init = () => {
    form.resetFields();
    const first = ops.findIndex((_, i) => availOf(wo, ops, i) > 0);
    if (first >= 0) form.setFieldsValue({ seq: ops[first].seq, good_qty: availOf(wo, ops, first), ng_qty: 0 });
  };

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = await post(`/work-orders/${wo.id}/report-batch`, {
        seq: v.seq, good_qty: v.good_qty || 0, ng_qty: v.ng_qty || 0, values: v.values || {}, equipment_id: v.equipment_id, remark: v.remark,
      });
      message.success(`已报工【${op?.name}】合格 ${num(v.good_qty || 0)}、不良 ${num(v.ng_qty || 0)}${r.ncr_no ? `；不良品已自动开具 ${r.ncr_no}，等待 QA 处置` : ''}`);
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title={`批量报工 - ${wo.no}`} width={680} okText="提交报工" onOk={submit} confirmLoading={saving} onCancel={onClose}
      destroyOnHidden maskClosable={false} afterOpenChange={(o) => o && init()}>
      <Form form={form} layout="vertical">
        <Form.Item name="seq" label="工序" rules={[{ required: true, message: '请选择工序' }]}>
          <Select
            options={ops.map((o, i) => {
              const a = availOf(wo, ops, i);
              return { value: o.seq, label: `${o.seq} ${o.name}（可报 ${num(a)}）`, disabled: a <= 0 };
            })}
            onChange={(s) => {
              const i = ops.findIndex((o) => o.seq === s);
              form.setFieldsValue({ good_qty: availOf(wo, ops, i), ng_qty: 0, values: {} });
            }}
          />
        </Form.Item>
        {op && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            {dictLabel('op_type', op.op_type)} · {op.work_center_name || '-'}{op.sop_no ? ` · 作业指导书 ${op.sop_no}` : ''}；本工序可报数量 <b>{num(avail)}</b>（防超报：不超过上道工序合格数）
          </Typography.Paragraph>
        )}
        <Space size={16} wrap>
          <Form.Item name="good_qty" label="合格数量" rules={[{ required: true, message: '请填写' }]}>
            <InputNumber min={0} max={avail} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="ng_qty" label="不良数量">
            <InputNumber min={0} max={avail} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="equipment_id" label="设备/仪器" rules={[{ required: !!op?.requires_equipment, message: '该工序必须选择设备' }]}>
            <EquipmentSelect params={{ status: 'NORMAL' }} style={{ width: 260 }} />
          </Form.Item>
        </Space>
        {good + ng > avail + 1e-9 && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`合格 + 不良 不能超过可报数量 ${num(avail)}`} />}
        {ng > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="不良数量将自动开具 NCR（不合格品报告），等待 QA 评审处置（返工/报废）。" />}
        {params.length > 0 && good > 0 && (
          <Card size="small" title="抽测数据（超出规格不能按合格报工）" style={{ marginBottom: 12 }}>
            {params.map((p) => {
              const ok = inSpec(p, vals[p.code!]);
              return (
                <Form.Item key={p.code} name={['values', p.code!]} label={`${p.name}（规格 ${specText(p)}）`} rules={[{ required: true, message: '请录入测量值' }]} style={{ marginBottom: 12 }}>
                  <InputNumber style={{ width: 220, ...(ok === true ? { borderColor: '#52c41a', background: '#f6ffed' } : {}) }} suffix={p.unit}
                    status={ok === false ? 'error' : undefined} />
                </Form.Item>
              );
            })}
          </Card>
        )}
        <Form.Item name="remark" label="备注">
          <Input placeholder={ng > 0 ? '请描述不良现象' : ''} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 弹窗：完工入库 ----------------
function FgReceiptModal({ wo, open, onClose, onDone }: { wo: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const avail = r4((wo.completed_qty || 0) - (wo.received_qty || 0));

  const init = () => {
    form.resetFields();
    get('/locations', { page_size: 200, is_active: true }, true)
      .then((d) => {
        const fg = (d.items as Rec[]).find((l) => l.warehouse_type === 'FG');
        if (fg && !form.getFieldValue('location_id')) form.setFieldValue('location_id', fg.id);
      })
      .catch(() => undefined);
  };

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const rc = await post(`/work-orders/${wo.id}/fg-receipt`, { location_id: v.location_id, qty: v.qty || null });
      const qty = (rc.lines || []).reduce((s: number, l: Rec) => s + (l.qty || 0), 0);
      message.success(`入库单 ${rc.no}：${num(qty)} ${wo.uom ?? ''} 已入成品仓，质量状态“待放行”`);
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title={`完工入库 - ${wo.no}`} okText="确认入库" onOk={submit} confirmLoading={saving} onCancel={onClose}
      destroyOnHidden maskClosable={false} afterOpenChange={(o) => o && init()}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="入库后成品质量状态为“待放行”，QA 审核 DHR 并电子签名放行后才能发货。" />
      <Descriptions size="small" column={2} style={{ marginBottom: 16 }} items={[
        { key: 'lot', label: '生产批号', children: <span className="mono">{wo.lot_no}</span> },
        { key: 'avail', label: '可入库数量', children: <b>{num(avail)} {wo.uom}</b> },
      ]} />
      <Form form={form} layout="vertical">
        <Form.Item name="location_id" label="入库库位（默认成品仓）" rules={[{ required: true, message: '请选择库位' }]}>
          <LocationSelect />
        </Form.Item>
        {wo.serial_control && (
          <Alert type="success" showIcon style={{ marginBottom: 12 }} message={<>需要逐台扫码核对？<Link to={`/wms/pda/fg?wo=${wo.id}`}>打开扫码完工入库</Link>（PDA 可用）</>} />
        )}
        <Form.Item name="qty" label="入库数量" extra={wo.serial_control ? '留空 = 全部已完成全部工序的序列号入库' : '留空 = 全部可入库数量'}>
          <InputNumber min={1} max={avail} precision={wo.serial_control ? 0 : 4} style={{ width: 200 }} placeholder={`全部 ${num(avail)}`} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 弹窗：修改计划工单 ----------------
function EditWoModal({ wo, open, onClose, onDone }: { wo: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const v = await form.validateFields();
    const [s, e] = v.range || [];
    setSaving(true);
    try {
      await put(`/work-orders/${wo.id}`, {
        material_id: wo.material_id, customer_id: wo.customer_id, so_id: wo.so_id, so_line_id: wo.so_line_id,
        planned_qty: v.planned_qty, planned_start: toDate(s), planned_end: toDate(e), priority: v.priority, remark: v.remark,
      });
      message.success('已保存');
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} title={`修改工单 ${wo.no}`} onOk={submit} confirmLoading={saving} onCancel={onClose} destroyOnHidden maskClosable={false}
      afterOpenChange={(o) => o && form.setFieldsValue({
        planned_qty: wo.planned_qty, priority: wo.priority, remark: wo.remark,
        range: [wo.planned_start ? dayjs(wo.planned_start) : null, wo.planned_end ? dayjs(wo.planned_end) : null],
      })}>
      <Form form={form} layout="vertical">
        <Space size={16} wrap>
          <Form.Item name="planned_qty" label="计划数量" rules={[{ required: true, message: '请填写数量' }]}>
            <InputNumber min={1} precision={wo.serial_control ? 0 : 4} style={{ width: 180 }} suffix={wo.uom} />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select options={PRIORITY_OPTIONS} style={{ width: 140 }} />
          </Form.Item>
        </Space>
        {wo.so_no && <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>来源订单 {wo.so_no}：工单数量超过订单数量的部分完工后入库为库存。</Typography.Paragraph>}
        <Form.Item name="range" label="计划开始 ~ 计划完成">
          <DatePicker.RangePicker style={{ width: '100%' }} allowEmpty={[true, true]} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 弹窗：下达后调整（未开工部分的数量 / 计划日期） ----------------
function AdjustWoModal({ wo, open, onClose, onDone }: { wo: Rec; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [info, setInfo] = useState<Rec | null>(null);
  const [preview, setPreview] = useState<Rec | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useMemo(() => ({ t: undefined as any }), []);
  const body = () => {
    const v = form.getFieldsValue();
    const [s, e] = v.range || [];
    return { planned_qty: v.planned_qty, planned_start: toDate(s), planned_end: toDate(e), reason: v.reason };
  };
  const runPreview = () => {
    clearTimeout(timer.t);
    timer.t = setTimeout(async () => {
      try {
        setPreview(await post(`/work-orders/${wo.id}/adjust`, { ...body(), preview: true }, true));
        setPreviewErr(null);
      } catch (e: any) {
        setPreview(null);
        const d = e?.response?.data?.detail;
        setPreviewErr(d && d !== '没有修改任何内容' ? d : null);
      }
    }, 300);
  };
  const submit = async () => {
    await form.validateFields();
    setSaving(true);
    try {
      const r = await post(`/work-orders/${wo.id}/adjust`, body());
      message.success(`工单已调整：${r.changes.join('；')}`);
      if (r.warnings?.length) message.warning(r.warnings.join('；'), 8);
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} title={`调整工单 ${wo.no}（未开工部分）`} width={620} okText="确认调整" onOk={submit} confirmLoading={saving} onCancel={onClose}
      destroyOnHidden maskClosable={false} okButtonProps={{ disabled: !!previewErr }}
      afterOpenChange={(o) => {
        if (!o) return;
        setPreview(null);
        setPreviewErr(null);
        form.setFieldsValue({
          planned_qty: wo.planned_qty, reason: '',
          range: [wo.planned_start ? dayjs(wo.planned_start) : null, wo.planned_end ? dayjs(wo.planned_end) : null],
        });
        get(`/work-orders/${wo.id}/adjust-info`).then(setInfo);
      }}>
      {info && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={`已开工 ${num(info.started)} ${info.uom}（完工 ${num(info.completed_qty)}、报废 ${num(info.scrap_qty)}），数量最少可调到 ${num(info.min_qty)}${info.serial_control ? `；调减时作废未开工的序列号（现有 ${info.unstarted_serials} 个），调增时按原批号补发序列号/UDI` : ''}`}
          description={info.so_line ? `来源订单 ${info.so_line.so_no} 第${info.so_line.line_no}行 订购 ${num(info.so_line.qty)}${info.so_line.other_wo_qty ? `，其他工单已排 ${num(info.so_line.other_wo_qty)}` : ''}` : undefined} />
      )}
      <Form form={form} layout="vertical" onValuesChange={runPreview}>
        <Form.Item name="planned_qty" label="计划数量" rules={[{ required: true, message: '请填写数量' }]}>
          <InputNumber min={info?.min_qty || 0} precision={wo.serial_control ? 0 : 4} style={{ width: 200 }} suffix={wo.uom} autoFocus />
        </Form.Item>
        <Form.Item name="range" label="计划开始 ~ 计划完成">
          <DatePicker.RangePicker style={{ width: '100%' }} allowEmpty={[true, true]} />
        </Form.Item>
        <Form.Item name="reason" label="调整原因（记入审计追踪）" rules={[{ required: true, whitespace: true, message: '请填写调整原因' }]}>
          <Input.TextArea rows={2} placeholder="如：客户订单减少 5 台 / 物料延期到货，推迟一周" />
        </Form.Item>
      </Form>
      {previewErr && <Alert type="error" showIcon message={previewErr} />}
      {preview && (
        <Alert type={preview.warnings?.length ? 'warning' : 'success'} showIcon message={`将调整：${preview.changes.join('；')}`}
          description={preview.warnings?.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{preview.warnings.map((t: string) => <li key={t}>{t}</li>)}</ul> : undefined} />
      )}
    </Modal>
  );
}

// ---------------- 页面 ----------------
export default function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const { modal } = App.useApp();
  const [wo, setWo] = useState<Rec | null>(null);
  const [failed, setFailed] = useState(false);
  const [serials, setSerials] = useState<Rec[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [issues, setIssues] = useState<Rec[]>([]);
  const [ncrs, setNcrs] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [snStatus, setSnStatus] = useState<string | undefined>();
  const [issueResult, setIssueResult] = useState<Rec | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [fgOpen, setFgOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [relKey, setRelKey] = useState(0);
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<string | undefined>(sp.get('tab') || undefined);
  const [kit, setKit] = useState<Rec | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await get(`/work-orders/${id}`);
      setWo(w);
      const [s, r, i, n] = await Promise.all([
        w.serial_control ? get(`/work-orders/${id}/serials`) : Promise.resolve([]),
        get(`/work-orders/${id}/records`),
        get('/issues', { wo_id: id, page_size: 200 }),
        get('/ncrs', { wo_id: id, page_size: 200 }),
      ]);
      setSerials(s);
      setRecords(r);
      setIssues(i.items);
      setNcrs(n.items);
      if (['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(w.status)) get(`/kitting/work-orders/${id}`, undefined, true).then(setKit).catch(() => setKit(null));
      else setKit(null);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const ops = useMemo(() => (wo ? sortedOps(wo) : []), [wo]);
  const opName = useMemo(() => Object.fromEntries(ops.map((o) => [o.seq, o.name])), [ops]);

  if (failed && !wo) return <Result status="404" title="工单不存在或无权查看" extra={<Button onClick={() => nav('/mes/work-orders')}>返回工单列表</Button>} />;
  if (!wo) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  const st = wo.status as string;
  const active = st === 'RELEASED' || st === 'IN_PROGRESS';
  const pendingFg = r4((wo.completed_qty || 0) - (wo.received_qty || 0));
  const canReceive = (st === 'IN_PROGRESS' || st === 'COMPLETED') && pendingFg > 0;
  const needIssue = (wo.materials || []).some((m: Rec) => (m.issued_qty || 0) < m.required_qty - 1e-9);
  /** QA 可分批放行：已入库、尚未放行的成品（拒绝的批次在弹窗中扣除） */
  const canRelease = can('qa') && wo.dhr_status === 'OPEN' && (st === 'IN_PROGRESS' || st === 'COMPLETED') && (wo.received_qty || 0) > (wo.released_qty || 0) + 1e-9;
  const draftIssue = issues.some((i) => i.status === 'DRAFT');
  const primary = st === 'PLANNED' ? 'release' : canReceive ? 'fg' : active && needIssue && !draftIssue ? 'issue' : active ? 'report' : 'dhr';
  const g = guide(wo);
  const steps = stepState(wo);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      message.success(ok);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const release = () =>
    modal.confirm({
      title: `下达工单 ${wo.no}？`,
      width: 520,
      okText: '确认下达',
      content: (
        <div>
          <p>下达后系统将自动：</p>
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            <li>锁定当前<b>已发布</b>的 BOM 与工艺路线版本（快照，之后的工程变更不影响本工单）；</li>
            <li>按 BOM 计算用料需求，生成领料依据；</li>
            <li>生成生产批号；</li>
            {wo.serial_control && <li>按数量逐台生成 <b>{num(wo.planned_qty)}</b> 个序列号及 UDI（GS1 格式）。</li>}
          </ol>
          {kit && !kit.kitted && <p style={{ marginTop: 8, color: '#d46b08' }}>{kittingSummary(kit).text}（可先下达，齐套后再领料）。</p>}
          <p style={{ marginTop: 8, color: '#8c8c9e' }}>下达后未开工的部分仍可用【调整】改数量和日期。</p>
        </div>
      ),
      onOk: () => run(() => post(`/work-orders/${id}/release`), '工单已下达：已生成批号' + (wo.serial_control ? '、序列号与 UDI' : '')),
    });

  const createIssue = async () => {
    if (kit && !kit.kitted) {
      const ok = await modal.confirm({
        title: `缺料 ${kit.shortage_count} 项，仍要生成领料单？`,
        content: '生成领料单会把现有合格库存先分配给本工单（排在后面的工单将领不到），缺的部分不会出库。建议先看【齐套检查】，物料到齐后再领料。',
        okText: '仍然生成',
        cancelText: '先不领料',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await post(`/work-orders/${id}/issues`, {});
      setIssueResult(r);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const extra = (
    <>
      <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/mes/work-orders')}>返回</Button>
      <Button icon={<ReloadOutlined />} onClick={load} />
      {st === 'PLANNED' && can('plan') && (
        <>
          <Button icon={<EditOutlined />} onClick={() => setEditOpen(true)}>修改</Button>
          <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={release}>下达</Button>
        </>
      )}
      {active && can('plan') && (
        <Tooltip title="未开工部分可调数量、计划日期（记入审计追踪）">
          <Button icon={<ColumnHeightOutlined />} onClick={() => setAdjustOpen(true)}>调整</Button>
        </Tooltip>
      )}
      {active && can('wms', 'plan') && (
        <Tooltip title={needIssue ? (draftIssue ? '已有待过账的领料单，系统只会为剩余需求分配批次' : '') : '物料已按 BOM 领齐'}>
          <Button type={primary === 'issue' ? 'primary' : 'default'} icon={<ExportOutlined />} loading={busy} disabled={!needIssue} onClick={createIssue}>生成领料单</Button>
        </Tooltip>
      )}
      {active && draftIssue && can('wms', 'plan') && (
        <Button onClick={() => nav(`/wms/issues?wo_id=${wo.id}&status=DRAFT`)}>待过账领料单</Button>
      )}
      {active && wo.serial_control && can('mes') && (
        <Button type={primary === 'report' ? 'primary' : 'default'} icon={<ScanOutlined />} onClick={() => nav('/mes/station')}>去工位扫码报工</Button>
      )}
      {active && !wo.serial_control && can('mes') && (
        <Button type={primary === 'report' ? 'primary' : 'default'} icon={<FormOutlined />} onClick={() => setBatchOpen(true)}>批量报工</Button>
      )}
      {canReceive && can('wms', 'plan') && (
        <Button type="primary" icon={<InboxOutlined />} onClick={() => setFgOpen(true)}>完工入库（{num(pendingFg)}）</Button>
      )}
      {canRelease && (
        <Button icon={<SplitCellsOutlined />} onClick={() => setReleaseOpen(true)}>分批放行</Button>
      )}
      {st !== 'PLANNED' && st !== 'CANCELLED' && (
        <Button type={primary === 'dhr' ? 'primary' : 'default'} icon={<FileProtectOutlined />} onClick={() => nav(`/quality/dhr/${id}`)}>查看 DHR</Button>
      )}
      {(st === 'PLANNED' || st === 'RELEASED') && can('plan') && (
        <Popconfirm title="确定取消该工单？" description={st === 'RELEASED' ? '下达时生成的序列号将作废；已领料的工单需先退料。' : '计划工单尚未下达，取消后不可恢复。'} okText="确认取消工单" cancelText="不取消"
          onConfirm={() => run(() => post(`/work-orders/${id}/cancel`), '工单已取消')}>
          <Button danger loading={busy}>取消工单</Button>
        </Popconfirm>
      )}
    </>
  );

  const kitOpen = ['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(st);
  const tabs = [
    ...(kitOpen
      ? [{
        key: 'kitting',
        label: (
          <span>
            齐套检查
            {kit && kit.lines?.length > 0 && (kit.kitted ? <Tag color="green" style={{ marginInlineStart: 4 }}>齐套</Tag> : <Tag color="red" style={{ marginInlineStart: 4 }}>缺 {kit.shortage_count} 项</Tag>)}
          </span>
        ),
        children: <KittingTable data={kit} loading={!kit} />,
      }]
      : []),
    {
      key: 'materials',
      label: `用料清单（${wo.materials?.length || 0}）`,
      children: wo.materials?.length ? (
        <Table<Rec> rowKey="id" size="middle" pagination={false} dataSource={wo.materials} scroll={{ x: 'max-content' }} columns={[
          {
            title: '物料', dataIndex: 'material_code',
            render: (v, r) => (
              <div>
                <Space size={4}>{v} {r.material_name}{r.customer_supplied && <Tag color="purple">客供料</Tag>}</Space>
                {r.material_spec && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_spec}</Typography.Text></div>}
              </div>
            ),
          },
          { title: '单耗', dataIndex: 'qty_per', align: 'right', render: (v) => fmtQty(v) },
          { title: '需求数量', dataIndex: 'required_qty', align: 'right', render: (v, r) => `${fmtQty(v)} ${r.uom ?? ''}` },
          { title: '已领数量', dataIndex: 'issued_qty', align: 'right', render: (v) => fmtQty(v) },
          {
            title: '领料进度', key: 'p', width: 200,
            render: (_, r) => {
              const p = r.required_qty ? Math.min(100, Math.round(((r.issued_qty || 0) / r.required_qty) * 1000) / 10) : 100;
              return <Progress percent={p} size="small" status={p >= 100 ? 'success' : 'active'} />;
            },
          },
        ]} />
      ) : <Empty description={st === 'PLANNED' ? '下达后按 BOM 生成用料清单' : '无用料'} />,
    },
    {
      key: 'ops',
      label: `工序进度（${ops.length}）`,
      children: ops.length ? (
        <Table<Rec> rowKey="id" size="middle" pagination={false} dataSource={ops} scroll={{ x: 'max-content' }} columns={[
          { title: '工序', dataIndex: 'seq', width: 60 },
          {
            title: '名称', dataIndex: 'name',
            render: (v, r) => (
              <div>
                <div>{v} <Typography.Text type="secondary">({r.code})</Typography.Text></div>
                {r.sop_no && <Typography.Text type="secondary" style={{ fontSize: 12 }}>SOP {r.sop_no}</Typography.Text>}
              </div>
            ),
          },
          { title: '类型', dataIndex: 'op_type', render: (v) => <StatusTag dict="op_type" value={v} /> },
          { title: '工作中心', dataIndex: 'work_center_name', render: (v) => v || '-' },
          { title: '测试规格', dataIndex: 'params', render: (v) => <ParamsText params={v} /> },
          {
            title: '设备/关键件', key: 'eq',
            render: (_, r) => (
              <Space size={4} wrap>
                {r.requires_equipment && <Tag color="geekblue">需设备</Tag>}
                {r.key_part_material_id && <Tag color="purple">扫关键件</Tag>}
                {!r.requires_equipment && !r.key_part_material_id && '-'}
              </Space>
            ),
          },
          { title: '合格', dataIndex: 'good_qty', align: 'right', render: (v) => <span style={{ color: '#389e0d', fontWeight: 600 }}>{fmtQty(v)}</span> },
          { title: '不良', dataIndex: 'ng_qty', align: 'right', render: (v) => <span style={{ color: v > 0 ? '#cf1322' : undefined }}>{fmtQty(v)}</span> },
          {
            title: '完成进度', key: 'p', width: 180,
            render: (_, r) => <Progress size="small" percent={wo.planned_qty ? Math.min(100, Math.round(((r.good_qty || 0) / wo.planned_qty) * 1000) / 10) : 0} />,
          },
        ]} />
      ) : <Empty description={st === 'PLANNED' ? '下达后按工艺路线生成工序' : '无工序'} />,
    },
    ...(wo.serial_control
      ? [{
        key: 'serials',
        label: `序列号/UDI（${serials.length}）`,
        children: (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <Select allowClear placeholder="按状态筛选" style={{ width: 160 }} value={snStatus} onChange={setSnStatus}
                options={Object.entries(serials.reduce((acc: Rec, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }), {}))
                  .map(([k, c]) => ({ value: k, label: `${dictLabel('sn_status', k)}（${c}）` }))} />
              <Typography.Text type="secondary">UDI = (01)UDI-DI + (11)生产日期 + (17)失效日期 + (10)批号 + (21)序列号</Typography.Text>
            </Space>
            <Table<Rec> rowKey="id" size="small" dataSource={snStatus ? serials.filter((s) => s.status === snStatus) : serials} scroll={{ x: 'max-content' }}
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个` }}
              columns={[
                { title: '序列号', dataIndex: 'sn', render: (v) => <Link to={`/trace?sn=${encodeURIComponent(v)}`} className="mono">{v}</Link> },
                { title: 'UDI', dataIndex: 'udi', render: (v) => <span className="mono" style={{ fontSize: 12 }}>{v || '-'}</span> },
                { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="sn_status" value={v} /> },
                { title: '已通过工序', dataIndex: 'last_seq', render: (v) => (v ? `${v} ${opName[v] ?? ''}` : <Typography.Text type="secondary">未开始</Typography.Text>) },
                { title: '完工时间', dataIndex: 'completed_at', render: (v) => fmtDateTime(v) },
                {
                  title: '放行批', dataIndex: 'release_no',
                  render: (v, r) => (v ? <Space size={4}><span className="mono">{v}</span><StatusTag dict="release_status" value={r.release_status} /></Space> : <Typography.Text type="secondary">-</Typography.Text>),
                },
              ]} />
          </>
        ),
      }]
      : []),
    {
      key: 'records',
      label: `报工记录（${records.length}）`,
      children: (
        <Table<Rec> rowKey="id" size="small" dataSource={records} scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          expandable={{
            rowExpandable: (r) => !!r.values?.length,
            expandedRowRender: (r) => (
              <Table<Rec> rowKey="id" size="small" pagination={false} dataSource={r.values} style={{ maxWidth: 720 }} columns={[
                { title: '测试项', dataIndex: 'name' },
                { title: '测量值', dataIndex: 'value', align: 'right', render: (v, x) => <b style={{ color: x.result === 'FAIL' ? '#cf1322' : undefined }}>{num(v)} {x.unit ?? ''}</b> },
                { title: '规格', key: 'spec', render: (_, x) => specText(x as SpecParam) },
                { title: '判定', dataIndex: 'result', render: (v) => <StatusTag dict="result" value={v} /> },
              ]} />
            ),
          }}
          columns={[
            { title: '时间', dataIndex: 'ts', render: (v) => dayjs(v).format('MM-DD HH:mm:ss') },
            { title: '序列号', dataIndex: 'sn', render: (v) => (v ? <Link to={`/trace?sn=${encodeURIComponent(v)}`} className="mono">{v}</Link> : <Tag>批量</Tag>) },
            { title: '工序', key: 'op', render: (_, r) => `${r.seq} ${r.op_name}` },
            { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => fmtQty(v) },
            { title: '结果', dataIndex: 'result', render: (v, r) => <Space size={4}><StatusTag dict="result" value={v} />{r.is_rework && <Tag color="orange">返工</Tag>}</Space> },
            { title: '测试项', key: 'vals', render: (_, r) => (r.values?.length ? `${r.values.length} 项${r.values.some((x: Rec) => x.result === 'FAIL') ? '（有超差）' : ''}` : '-') },
            { title: '操作员', dataIndex: 'operator_name' },
            { title: '设备', dataIndex: 'equipment_code', render: (v) => v || '-' },
            { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v) => v || '-' },
          ]} />
      ),
    },
    {
      key: 'issues',
      label: `领料单（${issues.length}）`,
      children: (
        <Table<Rec> rowKey="id" size="middle" dataSource={issues} pagination={false} scroll={{ x: 'max-content' }}
          locale={{ emptyText: active ? '尚未领料，点击右上角【生成领料单】' : '无领料单' }}
          expandable={{
            expandedRowRender: (r) => (
              <Table<Rec> rowKey="id" size="small" pagination={false} dataSource={r.lines} columns={[
                { title: '物料', dataIndex: 'material_code', render: (v, l) => `${v} ${l.material_name}` },
                { title: '批号', dataIndex: 'lot_no', render: (v, l) => <Link className="mono" to={`/trace?material_code=${encodeURIComponent(l.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> },
                { title: '库位', dataIndex: 'location_code' },
                { title: '数量', dataIndex: 'qty', align: 'right', render: (v, l) => `${fmtQty(v)} ${l.uom ?? ''}` },
                { title: '有效期至', dataIndex: 'expiry_date', render: (v) => fmtDate(v) },
              ]} />
            ),
          }}
          columns={[
            { title: '领料单号', dataIndex: 'no', render: (v) => <Link to={`/wms/issues?q=${encodeURIComponent(v)}`}>{v}</Link> },
            { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="doc_status" value={v} /> },
            { title: '行数', key: 'n', render: (_, r) => r.lines?.length ?? 0 },
            { title: '创建', key: 'c', render: (_, r) => `${r.created_by ?? ''} ${fmtDateTime(r.created_at)}` },
            { title: '过账', key: 'p', render: (_, r) => (r.confirmed_at ? `${r.confirmed_by ?? ''} ${fmtDateTime(r.confirmed_at)}` : '-') },
            {
              title: '操作', key: 'op',
              render: (_, r) => r.status === 'DRAFT' && (
                <Space size={4}>
                  {can('wms') && (
                    <Popconfirm title="确认过账？将扣减库存并记录批次追溯。" onConfirm={() => run(() => post(`/issues/${r.id}/confirm`), `领料单 ${r.no} 已过账`)}>
                      <Button size="small" type="primary">过账</Button>
                    </Popconfirm>
                  )}
                  {can('wms', 'plan') && (
                    <Popconfirm title="取消该领料单？" onConfirm={() => run(() => post(`/issues/${r.id}/cancel`), '领料单已取消')}>
                      <Button size="small">取消</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]} />
      ),
    },
    ...(st !== 'PLANNED' && st !== 'CANCELLED'
      ? [{
        key: 'releases',
        label: `放行记录${(wo.released_qty || 0) > 0 ? `（已放行 ${num(wo.released_qty)}）` : ''}`,
        children: (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <Typography.Text type="secondary">
                已入库 {fmtQty(wo.received_qty)} / 已放行 {fmtQty(wo.released_qty)} {wo.uom ?? ''}；DHR 审核放行按“放行批”记录，只有已放行批中的产品可以发货。
              </Typography.Text>
              {canRelease && <Button type="primary" size="small" icon={<SplitCellsOutlined />} onClick={() => setReleaseOpen(true)}>分批放行</Button>}
              <Button size="small" icon={<FileProtectOutlined />} onClick={() => nav(`/quality/dhr/${id}`)}>查看 DHR</Button>
            </Space>
            <WoReleaseHistory woId={id!} refreshKey={relKey} />
          </>
        ),
      }]
      : []),
    {
      key: 'ncrs',
      label: (
        <span>不合格品（{ncrs.length}）{ncrs.some((n) => n.status === 'OPEN') && <Tag color="red" style={{ marginInlineStart: 4 }}>待处置</Tag>}</span>
      ),
      children: (
        <Table<Rec> rowKey="id" size="middle" dataSource={ncrs} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: '无不合格品' }} columns={[
          { title: 'NCR 编号', dataIndex: 'no', render: (v) => <Link to={`/quality/ncrs?q=${encodeURIComponent(v)}`}>{v}</Link> },
          { title: '序列号', dataIndex: 'sn', render: (v) => (v ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`}>{v}</Link> : '-') },
          { title: '工序', dataIndex: 'op_name', render: (v, r) => (v ? `${r.op_seq ?? ''} ${v}` : '-') },
          { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => fmtQty(v) },
          { title: '不合格描述', dataIndex: 'description', width: 360 },
          { title: '严重度', dataIndex: 'severity', render: (v) => <StatusTag dict="severity" value={v} /> },
          { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="ncr_status" value={v} /> },
          { title: '处置', dataIndex: 'disposition', render: (v) => <StatusTag dict="disposition" value={v} /> },
          { title: '开具时间', dataIndex: 'created_at', render: (v) => fmtDateTime(v) },
        ]} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={
          <Space wrap>
            生产工单 {wo.no}
            <StatusTag dict="wo_status" value={st} />
            {(st === 'COMPLETED' || st === 'CLOSED' || wo.received_qty > 0) && <StatusTag dict="dhr_status" value={wo.dhr_status} />}
          </Space>
        }
        sub={`${wo.material_code} ${wo.material_name}${wo.material_spec ? ` | ${wo.material_spec}` : ''}`}
        extra={extra}
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          {st !== 'CANCELLED' && (
            <Steps
              current={steps.current}
              status={steps.status}
              style={{ marginBottom: 20 }}
              items={[
                { title: '计划', description: fmtDate(wo.created_at) },
                { title: '下达', description: wo.released_by ? `${wo.released_by}` : '锁定版本、生成批号/UDI' },
                { title: '生产', description: wo.actual_start ? `开工 ${fmtDateTime(wo.actual_start)}` : '领料、报工' },
                { title: '完工', description: wo.actual_end ? fmtDateTime(wo.actual_end) : `完工 ${num(wo.completed_qty)} / ${num(wo.planned_qty)}` },
                {
                  title: '放行',
                  description: wo.dhr_status === 'RELEASED' ? 'QA 已放行' : wo.dhr_status === 'REJECTED' ? '拒绝放行'
                    : (wo.released_qty || 0) > 0 ? `已分批放行 ${num(wo.released_qty)}` : 'QA 审核 DHR',
                },
              ]}
            />
          )}
          {g.text && <Alert type={g.type} showIcon message={g.text} style={{ marginBottom: 16 }} />}
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3, xxl: 4 }}
            items={[
              { key: 'p', label: '产品', children: `${wo.material_code} ${wo.material_name}` },
              { key: 'c', label: '客户', children: wo.customer_name || '-' },
              { key: 'so', label: '来源订单', children: wo.so_no ? <Link to={`/sales/orders/${wo.so_id}`}>{wo.so_no}</Link> : '-' },
              { key: 'lot', label: '生产批号', children: wo.lot_no ? <span className="mono">{wo.lot_no}</span> : '下达后生成' },
              {
                key: 'qty', label: '计划 / 完工 / 报废',
                children: <span>{fmtQty(wo.planned_qty)} / <b>{fmtQty(wo.completed_qty)}</b> / <span style={{ color: wo.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(wo.scrap_qty)}</span> {wo.uom}</span>,
              },
              { key: 'rcv', label: '已入库 / 已放行', children: `${fmtQty(wo.received_qty)} / ${fmtQty(wo.released_qty)} ${wo.uom ?? ''}` },
              { key: 'prog', label: '完工进度', children: <Progress percent={wo.progress} size="small" style={{ width: 180, margin: 0 }} /> },
              { key: 'plan', label: '计划开始 ~ 完成', children: `${fmtDate(wo.planned_start)} ~ ${fmtDate(wo.planned_end)}` },
              { key: 'act', label: '实际开工 ~ 完工', children: `${fmtDateTime(wo.actual_start)} ~ ${fmtDateTime(wo.actual_end)}` },
              { key: 'bom', label: 'BOM 版本', children: wo.bom_version ? <Link to={`/engineering/boms/${wo.bom_id}`}>{wo.bom_version}</Link> : '下达时锁定' },
              { key: 'rt', label: '工艺版本', children: wo.routing_version ? <Link to={`/engineering/routings/${wo.routing_id}`}>{wo.routing_version}</Link> : '下达时锁定' },
              { key: 'sc', label: '管理方式', children: wo.serial_control ? <Tag color="blue">序列号 + UDI</Tag> : <Tag>批次</Tag> },
              { key: 'pr', label: '优先级', children: PRIORITY_OPTIONS.find((o) => o.value === wo.priority)?.label ?? wo.priority },
              { key: 'by', label: '创建 / 下达', children: `${wo.created_by ?? '-'} / ${wo.released_by ?? '-'}` },
              { key: 'rm', label: '备注', children: wo.remark || '-' },
            ]}
          />
        </Card>
        <Card styles={{ body: { paddingTop: 4 } }}>
          <Tabs items={tabs} activeKey={tab && tabs.some((t) => t.key === tab) ? tab : undefined} onChange={setTab} />
        </Card>
      </Space>
      <IssueResultModal issue={issueResult} onClose={() => setIssueResult(null)} onPosted={load} />
      <BatchReportModal wo={wo} open={batchOpen} onClose={() => setBatchOpen(false)} onDone={load} />
      <FgReceiptModal wo={wo} open={fgOpen} onClose={() => setFgOpen(false)} onDone={load} />
      <EditWoModal wo={wo} open={editOpen} onClose={() => setEditOpen(false)} onDone={load} />
      <AdjustWoModal wo={wo} open={adjustOpen} onClose={() => setAdjustOpen(false)} onDone={load} />
      <ReleaseBatchModal wo={wo} open={releaseOpen} onClose={() => setReleaseOpen(false)}
        onDone={() => {
          setRelKey((k) => k + 1);
          load();
        }} />
    </>
  );
}
