import {
  Alert, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer, Form, Input, Modal, Radio, Row, Segmented, Select, Space, Steps, Tag, Tooltip, Typography, message,
} from 'antd';
import { AlertOutlined, AuditOutlined, CheckCircleOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SolutionOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import ExportButton from '../../components/ExportButton';
import { CustomerSelect, MaterialSelect } from '../../components/RemoteSelect';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';
import { DateRangeFilter, useUrlFilters } from './qshared';

const STATUS_TABS = [
  { value: 'OPEN,INVESTIGATING', label: '未结案' },
  { value: 'OPEN', label: '已登记' },
  { value: 'INVESTIGATING', label: '调查中' },
  { value: 'CLOSED', label: '已结案' },
  { value: '', label: '全部' },
];
const COUNTRIES = ['中国', 'US', 'EU', '德国', '日本', '韩国', '澳大利亚', '其他'];
/** 上报时限说明（与后端默认一致） */
const REPORT_RULE = '默认上报期限（自接收日起）：中国《医疗器械不良事件监测和再评价管理办法》严重伤害 20 天（死亡 7 天）；美国 FDA MDR 30 天；欧盟 MDR 严重事件 15 天。可按实际调整。';
const dateKeys = ['received_date', 'event_date', 'report_deadline', 'reported_at', 'replied_at'];
const toForm = (r: Rec) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, dateKeys.includes(k) && v ? dayjs(v as string) : v]));

/** 上报倒计时标签 */
function ReportDue({ c }: { c: Rec }) {
  if (c.report_no) return <Tooltip title={`上报日期 ${fmtDate(c.reported_at)}`}><Tag color="green">已上报 {c.report_no}</Tag></Tooltip>;
  if (c.reportable === false) return <Tag>无需上报</Tag>;
  if (c.report_days_left === null || c.report_days_left === undefined) return c.is_adverse_event || c.reportable ? <span>{fmtDate(c.report_due)}</span> : <span>-</span>;
  const left: number = c.report_days_left;
  const text = c.reportable ? '待上报' : '待评估';
  const color = left < 0 ? 'red' : left <= 5 ? 'orange' : 'gold';
  return <Tooltip title={`${text}，期限 ${c.report_due}。${REPORT_RULE}`}><Tag color={color}>{text} · {left < 0 ? `超期 ${-left} 天` : `剩 ${left} 天`}</Tag></Tooltip>;
}

/** 法规字段：上报评估与客户回复（修改弹窗与结案弹窗共用） */
function RegulatoryFields({ adverse, due }: { adverse: boolean; due?: string | null }) {
  const form = Form.useFormInstance();
  const reportable = Form.useWatch('reportable', form);
  return (
    <>
      <Form.Item name="reportable" label="上报评估" tooltip={REPORT_RULE} rules={adverse ? [{ required: true, message: '不良事件须完成上报评估' }] : []}>
        <Radio.Group optionType="button" options={[{ value: true, label: '需要上报' }, { value: false, label: '无需上报' }]}
          onChange={(e) => {
            // 选“需要上报”时自动带出法规期限
            if (e.target.value && !form.getFieldValue('report_deadline')) {
              const r = form.getFieldsValue(['received_date', 'country']);
              const days = ['US', 'USA', '美国'].includes(String(r.country ?? '').toUpperCase()) ? 30 : ['EU', '欧盟', '德国', '法国'].includes(String(r.country ?? '')) ? 15 : 20;
              form.setFieldsValue({ report_deadline: due ? dayjs(due) : dayjs(r.received_date || undefined).add(days, 'day') });
            }
          }} />
      </Form.Item>
      {reportable && (
        <Row gutter={12}>
          <Col xs={24} sm={8}><Form.Item name="report_deadline" label="上报期限" tooltip="不填按国家默认"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          <Col xs={24} sm={8}><Form.Item name="report_no" label="上报编号"><Input placeholder="监管系统报告编号" /></Form.Item></Col>
          <Col xs={24} sm={8}><Form.Item name="reported_at" label="上报日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
      )}
      <Row gutter={12}>
        <Col xs={24} sm={16}><Form.Item name="customer_reply" label="给客户的回复"><Input.TextArea rows={2} placeholder="调查结论与处理方案（如：已更换整机并寄送调查报告）" /></Form.Item></Col>
        <Col xs={24} sm={8}><Form.Item name="replied_at" label="回复日期" tooltip="填写回复后默认今天"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
      </Row>
    </>
  );
}
const regBody = (v: Rec) => ({
  reportable: v.reportable ?? null, report_deadline: toDate(v.report_deadline), report_no: v.report_no?.trim() || null,
  reported_at: toDate(v.reported_at), customer_reply: v.customer_reply?.trim() || null, replied_at: toDate(v.replied_at),
});

const stop = (e: MouseEvent) => e.stopPropagation();

/** 不良事件醒目标记 */
function AdverseTag() {
  return (
    <Tooltip title="涉及或可能涉及使用者伤害的不良事件：需评估并协助注册人（MAH）按法规时限上报">
      <Tag color="red" icon={<AlertOutlined />} style={{ fontWeight: 600, marginInlineEnd: 0 }}>不良事件</Tag>
    </Tooltip>
  );
}

// ---------------- 登记 / 修改 ----------------
function ComplaintModal({ open, record, onClose, onDone }: { open: boolean; record: Rec | null; onClose: () => void; onDone: (r: Rec) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const adverse = Form.useWatch('is_adverse_event', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (record) {
      form.setFieldsValue(toForm(record));
    } else {
      form.setFieldsValue({ received_date: dayjs(), is_adverse_event: false, country: '中国' });
    }
  }, [open, record, form]);

  /** 输入序列号后自动带出产品与批号 */
  const fillBySn = async (sn: string) => {
    if (!sn.trim()) return;
    try {
      const d = await get(`/mes/scan/${encodeURIComponent(sn.trim())}`, undefined, true);
      form.setFieldsValue({ material_id: d.product?.id, lot_no: d.lot_no });
      message.info(`已带出：${d.product?.code} ${d.product?.name}，批号 ${d.lot_no}`);
    } catch {
      /* 非本系统序列号，手工填写 */
    }
  };

  const submit = async () => {
    const v = await form.validateFields();
    const body = {
      customer_id: v.customer_id, received_date: toDate(v.received_date), material_id: v.material_id ?? null,
      sn: v.sn?.trim() || null, lot_no: v.lot_no?.trim() || null, description: v.description, is_adverse_event: !!v.is_adverse_event,
      reporter_contact: v.reporter_contact?.trim() || null, event_date: toDate(v.event_date), country: v.country || null,
      ...(record ? regBody(v) : {}),
    };
    setSaving(true);
    try {
      const r = record ? await put(`/complaints/${record.id}`, body) : await post('/complaints', body);
      message.success(record ? `${r.no} 已保存` : `已登记客户投诉 ${r.no}`);
      onDone(r);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title={record ? `修改客户投诉 ${record.no}` : '登记客户投诉 / 不良事件'} width={720} okText={record ? '保存' : '登记'}
      confirmLoading={saving} onOk={submit} onCancel={onClose} destroyOnHidden maskClosable={false}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="收到客户投诉（含电话、邮件、退货附言）应在当日登记；涉及使用者伤害或可能导致伤害的，请勾选“不良事件”，QA 将评估是否需协助注册人上报。" />
      <Form form={form} layout="vertical">
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="customer_id" label="投诉客户" rules={[{ required: true, message: '请选择客户' }]}>
            <CustomerSelect style={{ width: 300 }} />
          </Form.Item>
          <Form.Item name="received_date" label="接收日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="reporter_contact" label="投诉人 / 联系方式" rules={[{ max: 128 }]}>
            <Input style={{ width: 300 }} placeholder="如：Dr. Smith / +1-555-0100 / 邮箱" />
          </Form.Item>
          <Form.Item name="event_date" label="事件发生日期">
            <DatePicker style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="country" label="国家/地区" tooltip="决定不良事件上报时限">
            <Select style={{ width: 130 }} showSearch allowClear options={COUNTRIES.map((c) => ({ value: c, label: c }))} />
          </Form.Item>
        </Space>
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="sn" label="产品序列号" extra="输入后自动带出产品与批号">
            <Input style={{ width: 220 }} className="mono" onBlur={(e) => fillBySn(e.target.value)} onPressEnter={(e) => fillBySn((e.target as HTMLInputElement).value)} />
          </Form.Item>
          <Form.Item name="lot_no" label="批号">
            <Input style={{ width: 180 }} className="mono" />
          </Form.Item>
        </Space>
        <Form.Item name="material_id" label="产品">
          <MaterialSelect params={{ category: 'FINISHED' }} />
        </Form.Item>
        <Form.Item name="description" label="投诉内容" rules={[{ required: true, whitespace: true, message: '请填写投诉内容' }]}>
          <Input.TextArea rows={4} placeholder="客户反馈的现象、发生时间与场景、使用者/患者情况、数量、客户诉求" />
        </Form.Item>
        <Form.Item name="is_adverse_event" valuePropName="checked" style={{ marginBottom: record ? 16 : 0 }}>
          <Checkbox><b style={{ color: adverse ? '#cf1322' : undefined }}>涉及不良事件</b>（导致或可能导致使用者/患者伤害，如灼伤、电击、眼部损伤等）</Checkbox>
        </Form.Item>
        {record && <RegulatoryFields adverse={false} due={record.report_due} />}
      </Form>
    </Modal>
  );
}

// ---------------- 结案（调查结论 + 上报评估 + 客户回复 + 电子签名） ----------------
function CloseModal({ c, onClose, onDone }: { c: Rec | null; onClose: () => void; onDone: (r: Rec) => void }) {
  const [form] = Form.useForm();
  const [sign, signHolder] = useESign();
  useEffect(() => {
    if (c) {
      form.resetFields();
      form.setFieldsValue(toForm(c));
    }
  }, [c, form]);
  return (
    <Modal open={!!c} title={`结案 - 客户投诉 ${c?.no ?? ''}`} width={720} okText="签名并结案" onCancel={onClose} destroyOnHidden maskClosable={false}
      onOk={async () => {
        const v = await form.validateFields();
        try {
          const r = await sign({
            meaning: '客诉结案',
            description: `${c!.no}：确认调查已完成、处理措施已落实${c!.is_adverse_event ? `，不良事件上报评估：${v.reportable ? `需上报（${v.report_no || '-'}）` : '无需上报'}` : ''}。`,
            submit: (signature) => post(`/complaints/${c!.id}/close`, { investigation: v.investigation?.trim(), ...regBody(v), signature }, true),
          });
          message.success(`${c!.no} 已结案`);
          onDone(r);
          onClose();
        } catch (e) {
          if (!isCancel(e)) throw e;
        }
      }}>
      {signHolder}
      {c?.is_adverse_event && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="不良事件：须完成上报评估；需上报的须填写上报编号与上报日期后才能结案。" />}
      {c && !c.ncr_id && !c.capa_id && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该投诉未关联 NCR 或 CAPA，请确认无需纠正措施。" />}
      <Form form={form} layout="vertical">
        <Form.Item name="investigation" label="调查结论" rules={[{ required: true, whitespace: true, message: '结案前必须填写调查结论' }]}>
          <Input.TextArea rows={5} placeholder="原因分析（追溯结果、复现/检测情况）、处理措施（返修/更换/退货/CAPA）、上报评估依据、对其他批次的影响评估" />
        </Form.Item>
        <RegulatoryFields adverse={!!c?.is_adverse_event} due={c?.report_due} />
      </Form>
    </Modal>
  );
}

// ---------------- 详情 ----------------
function ComplaintDrawer({ c, onClose, onChanged, onEdit, onCloseIt }: {
  c: Rec | null; onClose: () => void; onChanged: (r: Rec) => void; onEdit: () => void; onCloseIt: () => void;
}) {
  const { can } = useAuth();
  const [inv, setInv] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setInv(c?.investigation ?? ''), [c]);
  if (!c) return <Drawer open={false} onClose={onClose} />;
  const closed = c.status === 'CLOSED';
  const step = c.status === 'OPEN' ? 0 : c.status === 'INVESTIGATING' ? 1 : 2;

  const act = async (key: string, fn: () => Promise<Rec>, ok: string) => {
    setBusy(key);
    try {
      const r = await fn();
      message.success(ok);
      onChanged(r);
    } finally {
      setBusy(null);
    }
  };
  const confirm = (title: string, content: string, run: () => void) => Modal.confirm({ title, content, okText: '确定', cancelText: '取消', onOk: run });

  return (
    <Drawer
      open
      width={760}
      onClose={onClose}
      title={<Space wrap>{c.no}<StatusTag dict="complaint_status" value={c.status} />{c.is_adverse_event && <AdverseTag />}</Space>}
      extra={!closed && (
        <Space wrap>
          {can('qa', 'sales') && <Button icon={<EditOutlined />} onClick={onEdit}>修改</Button>}
          {can('qa') && c.status === 'OPEN' && (
            <Button icon={<SearchOutlined />} loading={busy === 'inv'} onClick={() => act('inv', () => post(`/complaints/${c.id}/investigate`), '已开始调查')}>开始调查</Button>
          )}
          {can('qa') && c.status === 'INVESTIGATING' && <Button type="primary" icon={<CheckCircleOutlined />} onClick={onCloseIt}>结案</Button>}
        </Space>
      )}
    >
      {c.is_adverse_event && (
        <Alert type="error" showIcon icon={<AlertOutlined />} style={{ marginBottom: 16 }}
          message={<b>不良事件</b>}
          description="该投诉涉及或可能涉及使用者/患者伤害。QA 须评估是否需协助医疗器械注册人（MAH）按法规时限向监管部门上报，并记录上报编号与日期。" />
      )}
      <Steps size="small" current={step} status={closed ? 'finish' : 'process'} style={{ marginBottom: 20 }} items={[
        { title: '登记', description: fmtDateTime(c.created_at) },
        { title: '调查', description: c.ncr_no || c.capa_no ? [c.ncr_no, c.capa_no].filter(Boolean).join(' / ') : '原因分析与处理' },
        { title: '结案', description: c.closed_by ? `${c.closed_by} ${fmtDateTime(c.closed_at)}` : 'QA 电子签名' },
      ]} />
      {!closed && (c.is_adverse_event || c.reportable) && c.report_days_left !== null && c.report_days_left !== undefined && (
        <Alert type={c.report_days_left < 0 ? 'error' : 'warning'} showIcon style={{ marginBottom: 12 }}
          message={<span>{c.reportable ? '需上报' : '上报评估'}期限 <b>{c.report_due}</b>（{c.report_days_left < 0 ? `已超期 ${-c.report_days_left} 天` : `剩 ${c.report_days_left} 天`}）</span>}
          description={REPORT_RULE} />
      )}
      <Descriptions size="small" column={2} bordered items={[
        { key: 'cust', label: '客户', children: c.customer_name || '-' },
        { key: 'date', label: '接收日期', children: fmtDate(c.received_date) },
        { key: 'rc', label: '投诉人 / 联系方式', children: c.reporter_contact || '-' },
        { key: 'ed', label: '事件日期 / 国家', children: `${fmtDate(c.event_date)} / ${c.country || '-'}` },
        { key: 'm', label: '产品', span: 2, children: c.material_code ? `${c.material_code} ${c.material_name}` : '-' },
        { key: 'sn', label: '序列号', children: c.sn ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(c.sn)}`}>{c.sn}</Link> : '-' },
        {
          key: 'lot', label: '批号',
          children: c.lot_no && c.material_code
            ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(c.material_code)}&lot_no=${encodeURIComponent(c.lot_no)}`}>{c.lot_no}</Link>
            : c.lot_no || '-',
        },
        { key: 'desc', label: '投诉内容', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{c.description}</span> },
        {
          key: 'ncr', label: '关联 NCR',
          children: c.ncr_no ? <Space><Link to={`/quality/ncrs?id=${c.ncr_id}`}>{c.ncr_no}</Link><StatusTag dict="ncr_status" value={c.ncr_status} /></Space> : '-',
        },
        {
          key: 'capa', label: '关联 CAPA',
          children: c.capa_no ? <Space><Link to={`/quality/capas?id=${c.capa_id}`}>{c.capa_no}</Link><StatusTag dict="capa_status" value={c.capa_status} /></Space> : '-',
        },
        { key: 'rep', label: '上报评估', children: <ReportDue c={c} /> },
        { key: 'repd', label: '上报期限 / 日期', children: `${fmtDate(c.report_deadline ?? c.report_due)} / ${fmtDate(c.reported_at)}` },
        { key: 'reply', label: '客户回复', span: 2, children: c.customer_reply ? <span style={{ whiteSpace: 'pre-wrap' }}>{c.customer_reply}（{fmtDate(c.replied_at)}）</span> : <Typography.Text type="secondary">尚未回复</Typography.Text> },
        { key: 'by', label: '登记人', children: c.created_by || '-' },
        { key: 'cl', label: '结案人/时间', children: c.closed_by ? `${c.closed_by} ${fmtDateTime(c.closed_at)}` : '-' },
      ]} />
      {!closed && can('qa') && (
        <Space wrap style={{ marginTop: 16 }}>
          {!c.ncr_id && (
            <Button icon={<AuditOutlined />} loading={busy === 'ncr'}
              onClick={() => confirm('由投诉开具 NCR？', `将开具来源为“客诉”的不合格品报告${c.is_adverse_event ? '（不良事件默认严重程度：致命）' : ''}，由 QA 评审处置。`,
                () => act('ncr', () => post(`/complaints/${c.id}/ncr`), '已开具 NCR'))}>
              开具 NCR
            </Button>
          )}
          {!c.capa_id && (
            <Button icon={<SolutionOutlined />} loading={busy === 'capa'}
              onClick={() => confirm('由投诉发起 CAPA？', '将创建来源为“客户投诉”的纠正预防措施，请随后在 CAPA 中填写根本原因与措施。',
                () => act('capa', () => post(`/complaints/${c.id}/capa`), '已发起 CAPA'))}>
              发起 CAPA
            </Button>
          )}
        </Space>
      )}
      <Card size="small" title="调查记录" style={{ marginTop: 16 }}
        extra={!closed && can('qa', 'sales') && (
          <Button size="small" loading={busy === 'save'} disabled={inv === (c.investigation ?? '')}
            onClick={() => act('save', () => put(`/complaints/${c.id}`, { investigation: inv }), '调查记录已保存')}>
            保存
          </Button>
        )}>
        {closed || !can('qa', 'sales') ? (
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{c.investigation || '-'}</Typography.Paragraph>
        ) : (
          <>
            <Input.TextArea rows={5} value={inv} onChange={(e) => setInv(e.target.value)} placeholder="原因分析、追溯结果、处理措施、是否需上报…（保存后自动进入“调查中”）" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>结案时需 QA 电子签名确认调查结论。上报评估与客户回复可在【修改】或【结案】时填写。</Typography.Text>
          </>
        )}
      </Card>
      <div style={{ marginTop: 16 }}>
        <Attachments entity="qms_complaint" entityId={c.id} bare hint="客户邮件、照片/视频、检测报告、上报回执等。" canUpload={can('qa', 'sales')} />
      </div>
    </Drawer>
  );
}

export default function Complaints() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const qParam = sp.get('q') || '';
  const url = useUrlFilters(['status', 'is_adverse_event', 'reportable', 'customer_id']);
  const initStatus = url.status ?? (qParam ? '' : 'OPEN,INVESTIGATING');
  const [status, setStatus] = useState(initStatus);
  const [adverse, setAdverse] = useState<string | undefined>(url.is_adverse_event);
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/complaints', { ...url, q: qParam || undefined, status: initStatus || undefined });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [editing, setEditing] = useState<{ open: boolean; record: Rec | null }>({ open: false, record: null });
  const [closing, setClosing] = useState<Rec | null>(null);

  const lastQ = useRef(qParam);
  useEffect(() => {
    if (lastQ.current === qParam) return;
    lastQ.current = qParam;
    setQuery({ q: qParam || undefined });
  }, [qParam, setQuery]);

  // 支持 ?id= 直接打开
  const idParam = Number(sp.get('id')) || null;
  useEffect(() => {
    if (idParam) get(`/complaints/${idParam}`).then(setCurrent).catch(() => undefined);
  }, [idParam]);

  const changed = (r: Rec) => {
    setCurrent((c) => (c && c.id === r.id ? r : c));
    reload();
  };
  const closeDrawer = () => {
    setCurrent(null);
    if (idParam) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const columns: any[] = [
    {
      title: '投诉编号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title',
      render: (v: string, r: Rec) => <Space size={4}><Typography.Link className="mono">{v}</Typography.Link>{r.is_adverse_event && <AdverseTag />}</Space>,
    },
    { title: '状态', dataIndex: 'status', sorter: true, mobile: 'subtitle', render: (v: string) => <StatusTag dict="complaint_status" value={v} /> },
    { title: '上报', key: 'report', render: (_: any, r: Rec) => <ReportDue c={r} /> },
    { title: '接收日期', dataIndex: 'received_date', sorter: true, render: (v: string) => fmtDate(v) },
    { title: '客户', dataIndex: 'customer_name' },
    { title: '产品', dataIndex: 'material_name', render: (v: string, r: Rec) => (v ? <Tooltip title={r.material_code}>{v}</Tooltip> : '-') },
    { title: '序列号', dataIndex: 'sn', render: (v: string) => (v ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`} onClick={stop}>{v}</Link> : '-') },
    { title: '批号', dataIndex: 'lot_no', render: (v: string) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '投诉内容', dataIndex: 'description', width: 260, ellipsis: { showTitle: true } },
    { title: '国家', dataIndex: 'country', sorter: true, render: (v: string) => v || '-' },
    { title: 'NCR', dataIndex: 'ncr_no', render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/quality/ncrs?id=${r.ncr_id}`} onClick={stop}>{v}</Link> : '-') },
    { title: 'CAPA', dataIndex: 'capa_no', render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/quality/capas?id=${r.capa_id}`} onClick={stop}>{v}</Link> : '-') },
    { title: '客户回复', dataIndex: 'replied_at', sorter: true, render: (v: string) => (v ? fmtDate(v) : <Typography.Text type="secondary">未回复</Typography.Text>) },
    { title: '登记人', dataIndex: 'created_by' },
    {
      title: '操作', key: '_op', fixed: 'right',
      render: (_: any, r: Rec) =>
        can('qa') && r.status === 'INVESTIGATING' ? (
          <Button size="small" type="primary" onClick={(e) => { stop(e); setClosing(r); }}>结案</Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="客户投诉 / 不良事件"
        sub="登记 → 调查（开具 NCR、发起 CAPA）→ 上报评估与客户回复 → QA 电子签名结案。不良事件需在法规时限内评估并协助注册人上报。"
        extra={
          <Space wrap>
            <ExportButton url="/complaints" params={query} filename="客户投诉" columns={[
              { title: '投诉编号', key: 'no' }, { title: '状态', value: (r) => dictLabel('complaint_status', r.status) }, { title: '不良事件', value: (r) => (r.is_adverse_event ? '是' : '') },
              { title: '接收日期', key: 'received_date', type: 'date' }, { title: '客户', key: 'customer_name' }, { title: '投诉人/联系方式', key: 'reporter_contact' },
              { title: '事件日期', key: 'event_date', type: 'date' }, { title: '国家', key: 'country' }, { title: '产品', key: 'material_name' }, { title: '序列号', key: 'sn' }, { title: '批号', key: 'lot_no' },
              { title: '投诉内容', key: 'description' }, { title: '需上报', value: (r) => (r.reportable === true ? '是' : r.reportable === false ? '否' : '') },
              { title: '上报期限', value: (r) => r.report_deadline ?? r.report_due, type: 'date' }, { title: '上报编号', key: 'report_no' }, { title: '上报日期', key: 'reported_at', type: 'date' },
              { title: '客户回复', key: 'customer_reply' }, { title: '回复日期', key: 'replied_at', type: 'date' }, { title: 'NCR', key: 'ncr_no' }, { title: 'CAPA', key: 'capa_no' },
              { title: '调查结论', key: 'investigation' }, { title: '结案人', key: 'closed_by' }, { title: '结案时间', key: 'closed_at', type: 'datetime' },
            ]} />
            {can('qa', 'sales') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ open: true, record: null })}>登记投诉</Button>}
          </Space>
        }
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="ISO 13485 §8.2.2 / 21 CFR 820.198：所有投诉均须记录并调查；不调查须记录理由。投诉为质量记录，不可删除；结案需填写调查结论（不良事件须完成上报评估）并由 QA 电子签名。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: (v as string) || undefined }); }} />
          <Select allowClear placeholder="不良事件" style={{ width: 130 }} value={adverse}
            options={[{ value: 'true', label: '仅不良事件' }, { value: 'false', label: '非不良事件' }]}
            onChange={(v) => { setAdverse(v); setQuery({ is_adverse_event: v }); }} />
          <Select allowClear placeholder="上报" style={{ width: 130 }} defaultValue={url.reportable}
            options={[{ value: 'pending', label: '需上报未上报' }, { value: 'true', label: '需上报' }, { value: 'false', label: '无需上报' }]}
            onChange={(v) => setQuery({ reportable: v })} />
          <DateRangeFilter placeholder={['接收起', '接收止']} onChange={(v) => setQuery(v)} />
          <Input.Search key={qParam} allowClear placeholder="编号 / 序列号 / 批号 / 内容" defaultValue={qParam} style={{ width: 260 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <ResponsiveTable<Rec>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          onChange={onTableChange}
          scroll={{ x: 'max-content' }}
          onRow={(r) => ({ onClick: () => setCurrent(r), style: { cursor: 'pointer', background: r.is_adverse_event && r.status !== 'CLOSED' ? '#fff1f0' : undefined } })}
        />
      </Card>
      <ComplaintDrawer
        c={current}
        onClose={closeDrawer}
        onChanged={changed}
        onEdit={() => setEditing({ open: true, record: current })}
        onCloseIt={() => setClosing(current)}
      />
      <ComplaintModal open={editing.open} record={editing.record} onClose={() => setEditing({ open: false, record: null })} onDone={changed} />
      <CloseModal c={closing} onClose={() => setClosing(null)} onDone={changed} />
    </>
  );
}
