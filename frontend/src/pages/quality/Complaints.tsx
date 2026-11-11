import {
  Alert, Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, Modal, Segmented, Select, Space, Steps, Table, Tag, Tooltip, Typography, message,
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
import { CustomerSelect, MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';

const STATUS_TABS = [
  { value: '', label: '全部' },
  { value: 'OPEN,INVESTIGATING', label: '未关闭' },
  { value: 'OPEN', label: '已登记' },
  { value: 'INVESTIGATING', label: '调查中' },
  { value: 'CLOSED', label: '已关闭' },
];

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
      form.setFieldsValue({ ...record, received_date: record.received_date ? dayjs(record.received_date) : undefined });
    } else {
      form.setFieldsValue({ received_date: dayjs(), is_adverse_event: false });
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
        <Form.Item name="is_adverse_event" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox><b style={{ color: adverse ? '#cf1322' : undefined }}>涉及不良事件</b>（导致或可能导致使用者/患者伤害，如灼伤、电击、眼部损伤等）</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 关闭（调查结论 + 电子签名） ----------------
function CloseModal({ c, onClose, onDone }: { c: Rec | null; onClose: () => void; onDone: (r: Rec) => void }) {
  const [form] = Form.useForm();
  const [sign, signHolder] = useESign();
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={!!c} title={`关闭客户投诉 ${c?.no ?? ''}`} width={640} okText="签名并关闭" confirmLoading={saving} onCancel={onClose} destroyOnHidden maskClosable={false}
      afterOpenChange={(o) => o && form.setFieldsValue({ investigation: c?.investigation ?? '' })}
      onOk={async () => {
        const v = await form.validateFields();
        try {
          const signature = await sign({ meaning: '客诉关闭', description: `${c!.no}：确认调查已完成、处理措施已落实${c!.is_adverse_event ? '，不良事件上报评估已完成' : ''}。` });
          setSaving(true);
          const r = await post(`/complaints/${c!.id}/close`, { investigation: v.investigation, signature });
          message.success(`${c!.no} 已关闭`);
          onDone(r);
          onClose();
        } catch (e) {
          if (!isCancel(e)) throw e;
        } finally {
          setSaving(false);
        }
      }}>
      {signHolder}
      {c?.is_adverse_event && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="不良事件：请在调查结论中写明是否已协助注册人上报（上报编号/日期）或不需上报的理由。" />}
      {c && !c.ncr_id && !c.capa_id && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该投诉未关联 NCR 或 CAPA，请确认无需纠正措施。" />}
      <Form form={form} layout="vertical">
        <Form.Item name="investigation" label="调查结论" rules={[{ required: true, whitespace: true, message: '关闭前必须填写调查结论' }]}>
          <Input.TextArea rows={6} placeholder="原因分析（追溯结果、复现/检测情况）、处理措施（返修/更换/退货/CAPA）、是否需上报及依据、对其他批次的影响评估" />
        </Form.Item>
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
          {can('qa') && c.status === 'INVESTIGATING' && <Button type="primary" icon={<CheckCircleOutlined />} onClick={onCloseIt}>关闭</Button>}
        </Space>
      )}
    >
      {c.is_adverse_event && (
        <Alert type="error" showIcon icon={<AlertOutlined />} style={{ marginBottom: 16 }}
          message={<b>不良事件</b>}
          description="该投诉涉及或可能涉及使用者/患者伤害。QA 须评估是否需协助医疗器械注册人（MAH）按法规时限向监管部门上报，并在调查结论中记录评估结果。" />
      )}
      <Steps size="small" current={step} status={closed ? 'finish' : 'process'} style={{ marginBottom: 20 }} items={[
        { title: '登记', description: fmtDateTime(c.created_at) },
        { title: '调查', description: c.ncr_no || c.capa_no ? [c.ncr_no, c.capa_no].filter(Boolean).join(' / ') : '原因分析与处理' },
        { title: '关闭', description: c.closed_by ? `${c.closed_by} ${fmtDateTime(c.closed_at)}` : 'QA 电子签名' },
      ]} />
      <Descriptions size="small" column={2} bordered items={[
        { key: 'cust', label: '客户', children: c.customer_name || '-' },
        { key: 'date', label: '接收日期', children: fmtDate(c.received_date) },
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
          children: c.ncr_no ? <Space><Link to={`/quality/ncrs?q=${encodeURIComponent(c.ncr_no)}`}>{c.ncr_no}</Link><StatusTag dict="ncr_status" value={c.ncr_status} /></Space> : '-',
        },
        {
          key: 'capa', label: '关联 CAPA',
          children: c.capa_no ? <Space><Link to={`/quality/capas?id=${c.capa_id}`}>{c.capa_no}</Link><StatusTag dict="capa_status" value={c.capa_status} /></Space> : '-',
        },
        { key: 'by', label: '登记人', children: c.created_by || '-' },
        { key: 'cl', label: '关闭人/时间', children: c.closed_by ? `${c.closed_by} ${fmtDateTime(c.closed_at)}` : '-' },
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
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>关闭时需 QA 电子签名确认调查结论。</Typography.Text>
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
  const [status, setStatus] = useState('');
  const [adverse, setAdverse] = useState<string | undefined>();
  const { rows, loading, setQuery, reload, pagination } = usePaged('/complaints', { q: qParam || undefined });
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
      title: '投诉编号', dataIndex: 'no', fixed: 'left',
      render: (v: string, r: Rec) => <Space size={4}><Typography.Link className="mono">{v}</Typography.Link>{r.is_adverse_event && <AdverseTag />}</Space>,
    },
    { title: '接收日期', dataIndex: 'received_date', render: (v: string) => fmtDate(v) },
    { title: '客户', dataIndex: 'customer_name' },
    { title: '产品', dataIndex: 'material_name', render: (v: string, r: Rec) => (v ? <Tooltip title={r.material_code}>{v}</Tooltip> : '-') },
    { title: '序列号', dataIndex: 'sn', render: (v: string) => (v ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`} onClick={stop}>{v}</Link> : '-') },
    { title: '批号', dataIndex: 'lot_no', render: (v: string) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '投诉内容', dataIndex: 'description', width: 280, ellipsis: { showTitle: true } },
    { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag dict="complaint_status" value={v} /> },
    { title: 'NCR', dataIndex: 'ncr_no', render: (v: string) => (v ? <Link className="mono" to={`/quality/ncrs?q=${encodeURIComponent(v)}`} onClick={stop}>{v}</Link> : '-') },
    { title: 'CAPA', dataIndex: 'capa_no', render: (v: string, r: Rec) => (v ? <Link className="mono" to={`/quality/capas?id=${r.capa_id}`} onClick={stop}>{v}</Link> : '-') },
    { title: '登记人', dataIndex: 'created_by' },
    {
      title: '操作', key: 'op', fixed: 'right',
      render: (_: any, r: Rec) =>
        can('qa') && r.status === 'INVESTIGATING' ? (
          <Button size="small" type="primary" onClick={(e) => { stop(e); setClosing(r); }}>关闭</Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="客户投诉 / 不良事件"
        sub="登记 → 调查（开具 NCR、发起 CAPA）→ QA 电子签名关闭。不良事件需评估并协助注册人上报。"
        extra={can('qa', 'sales') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ open: true, record: null })}>登记投诉</Button>}
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="ISO 13485 §8.2.2：所有投诉均须记录并调查；不调查须记录理由。投诉为质量记录，不可删除；关闭需填写调查结论并由 QA 电子签名。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: (v as string) || undefined }); }} />
          <Select allowClear placeholder="不良事件" style={{ width: 130 }} value={adverse}
            options={[{ value: 'true', label: '仅不良事件' }, { value: 'false', label: '非不良事件' }]}
            onChange={(v) => { setAdverse(v); setQuery({ is_adverse_event: v }); }} />
          <Input.Search key={qParam} allowClear placeholder="编号 / 序列号 / 批号 / 内容" defaultValue={qParam} style={{ width: 260 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table<Rec>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
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
