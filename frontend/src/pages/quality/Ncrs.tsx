import {
  Alert, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Steps, Table, Tooltip, Typography, message,
} from 'antd';
import { AuditOutlined, CheckCircleOutlined, PlusOutlined, ReloadOutlined, SolutionOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import RemoteSelect, { CustomerSelect, MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';

const STATUS_TABS = [
  { value: '', label: '全部' },
  { value: 'OPEN', label: '待处置' },
  { value: 'DISPOSITIONED', label: '已处置' },
  { value: 'CLOSED', label: '已关闭' },
];

/** 各来源允许的处置方式及其后果说明（与后端规则一致） */
function dispositionChoices(source: string): { value: string; label: string; desc: string }[] {
  if (source === 'PROCESS') {
    return [
      { value: 'REWORK', label: '返工/返修', desc: '产品恢复为在制，需重新通过不合格工序（记录为返工）；批量报工的不良数量释放后可重新报工。' },
      { value: 'SCRAP', label: '报废', desc: '产品报废并计入工单报废数；工单“完工 + 报废 = 计划数”时自动完工。' },
    ];
  }
  if (source === 'IQC') {
    return [
      { value: 'USE_AS_IS', label: '让步接收', desc: '不合格库存转为“合格”，可被领用。需评估对产品安全有效性的影响。' },
      { value: 'REWORK', label: '挑选后重检', desc: '库存转回“待检”，系统自动生成新的检验单重新检验。' },
      { value: 'RETURN', label: '退货', desc: '不合格库存出库，退回供应商。' },
      { value: 'SCRAP', label: '报废', desc: '不合格库存报废出库。' },
    ];
  }
  if (source === 'CUSTOMER') {
    // 客户退货（RMA）关联的 NCR：关闭退货单时系统按此处置执行冻结库存
    return [
      { value: 'REWORK', label: '返工/返修', desc: '返修并重新检验合格后，关闭退货单时退货品转为合格库存。' },
      { value: 'SCRAP', label: '报废', desc: '关闭退货单时退货品报废出库，序列号标记为报废。' },
      { value: 'USE_AS_IS', label: '让步接收', desc: '经评审无质量问题（如客户误操作），关闭退货单时转为合格库存。' },
      { value: 'RETURN', label: '返还客户', desc: '原样返还客户，关闭退货单时出库，序列号恢复为已发货。' },
    ];
  }
  return [
    { value: 'REWORK', label: '返工/返修', desc: '返工或返修后重新检验。' },
    { value: 'SCRAP', label: '报废', desc: '按报废处理。' },
    { value: 'USE_AS_IS', label: '让步接收', desc: '经评审风险可接受，按现状使用/放行。' },
    { value: 'RETURN', label: '退货', desc: '退回供应商或客户。' },
  ];
}

const stop = (e: MouseEvent) => e.stopPropagation();

// ---------------- 评审处置 ----------------
function DispositionModal({ ncr, onClose, onDone }: { ncr: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [sign, signHolder] = useESign();
  const [saving, setSaving] = useState(false);
  const choices = ncr ? dispositionChoices(ncr.source) : [];
  const disp = Form.useWatch('disposition', form);

  const submit = async () => {
    const v = await form.validateFields();
    const label = choices.find((c) => c.value === v.disposition)?.label;
    try {
      const signature = await sign({ meaning: '不合格品评审处置', description: `${ncr!.no}：处置方式【${label}】。${choices.find((c) => c.value === v.disposition)?.desc ?? ''}`, defaultReason: v.remark });
      setSaving(true);
      await post(`/ncrs/${ncr!.id}/disposition`, { disposition: v.disposition, remark: v.remark, signature });
      message.success(`${ncr!.no} 已处置：${label}`);
      onDone();
      onClose();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!ncr} title={`评审处置 - ${ncr?.no ?? ''}`} width={620} okText="签名并处置" onOk={submit} confirmLoading={saving} onCancel={onClose}
      destroyOnHidden maskClosable={false} afterOpenChange={(o) => o && form.resetFields()}>
      {signHolder}
      {ncr && (
        <>
          <Typography.Paragraph>
            <StatusTag dict="ncr_source" value={ncr.source} /> {ncr.material_code} {ncr.material_name}
            {ncr.sn ? ` · SN ${ncr.sn}` : ''}{ncr.lot_no ? ` · 批号 ${ncr.lot_no}` : ''} · 数量 {fmtQty(ncr.qty)}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ background: '#fafafa', padding: 8, borderRadius: 6 }}>{ncr.description}</Typography.Paragraph>
          {ncr.source === 'PROCESS' && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="生产过程不合格品不允许让步放行（医疗器械安全要求），只能返工或报废。" />}
        </>
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="disposition" label="处置方式" rules={[{ required: true, message: '请选择处置方式' }]}>
          <Radio.Group style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {choices.map((c) => (
                <Radio key={c.value} value={c.value}>
                  <b>{c.label}</b> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.desc}</Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="remark" label="评审意见" rules={[{ required: disp === 'USE_AS_IS', message: '让步接收必须填写风险评估意见' }]}>
          <Input.TextArea rows={3} placeholder={disp === 'USE_AS_IS' ? '请说明风险评估结论（对安全有效性无影响的依据）' : '如：原因为测试夹具接触不良，返工后重测'} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 关闭 NCR ----------------
function CloseModal({ ncr, onClose, onDone }: { ncr: Rec | null; onClose: () => void; onDone: () => void }) {
  const [capaId, setCapaId] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={!!ncr} title={`关闭 ${ncr?.no ?? ''}`} okText="确认关闭" confirmLoading={saving} onCancel={onClose} destroyOnHidden
      afterOpenChange={(o) => o && setCapaId(ncr?.capa_id ?? undefined)}
      onOk={async () => {
        setSaving(true);
        try {
          await post(`/ncrs/${ncr!.id}/close`, { capa_id: capaId ?? null });
          message.success(`${ncr!.no} 已关闭`);
          onDone();
          onClose();
        } finally {
          setSaving(false);
        }
      }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="确认处置已执行完毕（返工已完成 / 已报废 / 已退货）后关闭。如需系统性整改，可关联 CAPA。" />
      <div style={{ marginBottom: 4 }}>关联 CAPA（可选）</div>
      <RemoteSelect url="/capas" labelOf={(r) => `${r.no} ${r.title}`} value={capaId} onChange={(v) => setCapaId(v ?? undefined)} style={{ width: '100%' }} placeholder="搜索 CAPA 编号或标题" />
    </Modal>
  );
}

// ---------------- 发起 CAPA ----------------
function CapaModal({ ncr, onClose }: { ncr: Rec | null; onClose: () => void }) {
  const nav = useNavigate();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={!!ncr} title={`由 ${ncr?.no ?? ''} 发起 CAPA`} okText="创建 CAPA" confirmLoading={saving} onCancel={onClose} destroyOnHidden width={620}
      afterOpenChange={(o) => o && form.setFieldsValue({
        title: `${ncr?.material_name ?? ''}${ncr?.op_name ? ` ${ncr.op_name}` : ''}不合格纠正预防`,
        description: `来源 ${ncr?.no}（${dictLabel('ncr_source', ncr?.source)}）：${ncr?.description ?? ''}`,
      })}
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const c = await post('/capas', { title: v.title, source: 'NCR', ncr_id: ncr!.id, description: v.description });
          message.success(`已创建 ${c.no}，请继续填写根本原因与纠正措施`);
          onClose();
          nav(`/quality/capas?id=${c.id}`);
        } finally {
          setSaving(false);
        }
      }}>
      <Form form={form} layout="vertical">
        <Form.Item name="title" label="CAPA 标题" rules={[{ required: true, message: '请填写标题' }]}><Input /></Form.Item>
        <Form.Item name="description" label="问题描述"><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 新建 NCR（客诉/其他） ----------------
function CreateNcrModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const source = Form.useWatch('source', form);

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

  return (
    <Modal open={open} title="新建不合格品报告（NCR）" width={680} okText="提交" confirmLoading={saving} onCancel={onClose} destroyOnHidden maskClosable={false}
      afterOpenChange={(o) => o && form.resetFields()}
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const n = await post('/ncrs', v);
          message.success(`已开具 ${n.no}，等待 QA 评审处置`);
          onDone();
          onClose();
        } finally {
          setSaving(false);
        }
      }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="来料检验和生产过程的不合格由系统自动开具；这里用于登记客户投诉、巡检发现等其他不合格。" />
      <Form form={form} layout="vertical" initialValues={{ source: 'CUSTOMER', severity: 'MAJOR', qty: 1 }}>
        <Space size={16} wrap>
          <Form.Item name="source" label="来源">
            <Radio.Group optionType="button" options={[{ value: 'CUSTOMER', label: '客户投诉' }, { value: 'OTHER', label: '其他' }]} />
          </Form.Item>
          <Form.Item name="severity" label="严重程度">
            <Select style={{ width: 140 }} options={dictOptions('severity')} />
          </Form.Item>
          <Form.Item name="qty" label="数量">
            <InputNumber min={0.0001} style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="sn" label="产品序列号" extra="输入后自动带出产品与批号">
            <Input style={{ width: 240 }} className="mono" onBlur={(e) => fillBySn(e.target.value)} onPressEnter={(e) => fillBySn((e.target as HTMLInputElement).value)} />
          </Form.Item>
          <Form.Item name="lot_no" label="批号">
            <Input style={{ width: 200 }} className="mono" />
          </Form.Item>
        </Space>
        <Form.Item name="material_id" label="物料/产品">
          <MaterialSelect />
        </Form.Item>
        {source === 'CUSTOMER' && (
          <Form.Item name="customer_id" label="投诉客户">
            <CustomerSelect />
          </Form.Item>
        )}
        <Form.Item name="description" label="不合格描述" rules={[{ required: true, message: '请描述不合格现象' }]}>
          <Input.TextArea rows={3} placeholder="现象、发现时间/地点、影响范围" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 详情抽屉 ----------------
function NcrDrawer({ ncr, onClose, onAction }: { ncr: Rec | null; onClose: () => void; onAction: (a: 'disp' | 'close' | 'capa') => void }) {
  const { can } = useAuth();
  if (!ncr) return <Drawer open={false} onClose={onClose} />;
  // 当前待办节点：待处置 → 评审处置；已处置 → 关闭；已关闭 → 全部完成
  const step = ncr.status === 'OPEN' ? 1 : 2;
  return (
    <Drawer
      open
      width={640}
      title={<Space>{ncr.no}<StatusTag dict="ncr_status" value={ncr.status} /></Space>}
      onClose={onClose}
      extra={can('qa') && (
        <Space>
          {ncr.status === 'OPEN' && <Button type="primary" icon={<AuditOutlined />} onClick={() => onAction('disp')}>评审处置</Button>}
          {ncr.status === 'DISPOSITIONED' && <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => onAction('close')}>关闭</Button>}
          {!ncr.capa_id && <Button icon={<SolutionOutlined />} onClick={() => onAction('capa')}>发起 CAPA</Button>}
        </Space>
      )}
    >
      <Steps size="small" current={step} status={ncr.status === 'CLOSED' ? 'finish' : 'process'} style={{ marginBottom: 20 }} items={[
        { title: '开具', description: fmtDateTime(ncr.created_at) },
        { title: '评审处置', description: ncr.disposition_by ? `${ncr.disposition_by}` : 'QA 电子签名' },
        { title: '关闭' },
      ]} />
      <Descriptions size="small" column={2} bordered items={[
        { key: 'src', label: '来源', children: <StatusTag dict="ncr_source" value={ncr.source} /> },
        { key: 'sev', label: '严重程度', children: <StatusTag dict="severity" value={ncr.severity} /> },
        { key: 'm', label: '物料/产品', span: 2, children: ncr.material_code ? `${ncr.material_code} ${ncr.material_name}` : '-' },
        {
          key: 'lot', label: '批号',
          children: ncr.lot_no && ncr.material_code
            ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(ncr.material_code)}&lot_no=${encodeURIComponent(ncr.lot_no)}`}>{ncr.lot_no}</Link>
            : ncr.lot_no || '-',
        },
        { key: 'sn', label: '序列号', children: ncr.sn ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(ncr.sn)}`}>{ncr.sn}</Link> : '-' },
        { key: 'wo', label: '工单', children: ncr.wo_no ? <Link to={`/mes/work-orders/${ncr.wo_id}`}>{ncr.wo_no}</Link> : '-' },
        { key: 'op', label: '发生工序', children: ncr.op_name ? `${ncr.op_seq ?? ''} ${ncr.op_name}` : '-' },
        { key: 'sup', label: '供应商', children: ncr.supplier_name || '-' },
        { key: 'insp', label: '检验单', children: ncr.inspection_id ? <Link to={`/quality/inspections/${ncr.inspection_id}`}>查看检验单</Link> : '-' },
        { key: 'qty', label: '数量', children: `${fmtQty(ncr.qty)} ${ncr.uom ?? ''}` },
        { key: 'by', label: '开具人', children: ncr.created_by || '-' },
        { key: 'desc', label: '不合格描述', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{ncr.description}</span> },
        { key: 'disp', label: '处置方式', children: <StatusTag dict="disposition" value={ncr.disposition} /> },
        { key: 'dby', label: '处置人/时间', children: ncr.disposition_by ? `${ncr.disposition_by} ${fmtDateTime(ncr.disposition_at)}` : '-' },
        { key: 'drm', label: '评审意见', span: 2, children: ncr.disposition_remark || '-' },
        { key: 'capa', label: '关联 CAPA', span: 2, children: ncr.capa_id ? <Link to={`/quality/capas?id=${ncr.capa_id}`}>查看 CAPA</Link> : '-' },
      ]} />
      {ncr.status === 'OPEN' && !can('qa') && <Alert style={{ marginTop: 16 }} type="info" showIcon message="NCR 由 QA 评审处置（需电子签名）。" />}
      {ncr.source === 'CUSTOMER' && (
        <Alert style={{ marginTop: 16 }} type="info" showIcon
          message={<span>客户来源的 NCR 可能关联 <Link to={`/wms/customer-returns?q=${encodeURIComponent(ncr.sn || ncr.lot_no || '')}`}>客户退货</Link> 或 <Link to={`/quality/complaints?q=${encodeURIComponent(ncr.sn || ncr.lot_no || '')}`}>客户投诉</Link>。</span>} />
      )}
      <div style={{ marginTop: 16 }}>
        <Attachments entity="qms_ncr" entityId={ncr.id} bare hint="缺陷照片、检测报告、客户反馈材料等。" canUpload={can('qc', 'qa', 'wms', 'mes')} />
      </div>
    </Drawer>
  );
}

export default function Ncrs() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const qParam = sp.get('q') || '';
  const [status, setStatus] = useState('');
  const { rows, loading, setQuery, reload, pagination } = usePaged('/ncrs', { q: qParam || undefined });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [dispFor, setDispFor] = useState<Rec | null>(null);
  const [closeFor, setCloseFor] = useState<Rec | null>(null);
  const [capaFor, setCapaFor] = useState<Rec | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // 从其他页面带 ?q= 跳转过来时更新搜索
  const lastQ = useRef(qParam);
  useEffect(() => {
    if (lastQ.current === qParam) return;
    lastQ.current = qParam;
    setQuery({ q: qParam || undefined });
  }, [qParam, setQuery]);

  const refresh = async () => {
    reload();
    if (current) setCurrent(await get(`/ncrs/${current.id}`));
  };

  const columns: any[] = [
    { title: 'NCR 编号', dataIndex: 'no', fixed: 'left', render: (v: string) => <Typography.Link>{v}</Typography.Link> },
    { title: '来源', dataIndex: 'source', render: (v: string) => <StatusTag dict="ncr_source" value={v} /> },
    { title: '严重度', dataIndex: 'severity', render: (v: string) => <StatusTag dict="severity" value={v} /> },
    { title: '物料/产品', dataIndex: 'material_name', render: (v: string, r: Rec) => (v ? <Tooltip title={r.material_code}>{v}</Tooltip> : '-') },
    { title: '批号', dataIndex: 'lot_no', render: (v: string) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '序列号', dataIndex: 'sn', render: (v: string) => (v ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`} onClick={stop}>{v}</Link> : '-') },
    { title: '工单', dataIndex: 'wo_no', render: (v: string, r: Rec) => (v ? <Link to={`/mes/work-orders/${r.wo_id}`} onClick={stop}>{v}</Link> : '-') },
    { title: '工序', dataIndex: 'op_name', render: (v: string) => v || '-' },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v: number) => fmtQty(v) },
    { title: '不合格描述', dataIndex: 'description', width: 280, ellipsis: { showTitle: true } },
    { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag dict="ncr_status" value={v} /> },
    { title: '处置', dataIndex: 'disposition', render: (v: string) => <StatusTag dict="disposition" value={v} /> },
    { title: '开具时间', dataIndex: 'created_at', render: (v: string) => fmtDateTime(v) },
    {
      title: '操作', key: 'op', fixed: 'right',
      render: (_: any, r: Rec) =>
        can('qa') && r.status === 'OPEN' ? (
          <Button size="small" type="primary" onClick={(e) => { stop(e); setDispFor(r); }}>评审处置</Button>
        ) : can('qa') && r.status === 'DISPOSITIONED' ? (
          <Button size="small" onClick={(e) => { stop(e); setCloseFor(r); }}>关闭</Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="不合格品 NCR"
        sub="来料检验不合格、工位测试不合格由系统自动开具；QA 电子签名评审处置。生产过程不合格品只能返工或报废。"
        extra={can('qc', 'qa') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建 NCR</Button>}
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: v || undefined }); }} />
          <Input.Search key={qParam} allowClear placeholder="NCR 编号 / 序列号 / 批号 / 描述" defaultValue={qParam} style={{ width: 280 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="来源" style={{ width: 120 }} options={dictOptions('ncr_source')} onChange={(v) => setQuery({ source: v })} />
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
          onRow={(r) => ({ onClick: () => setCurrent(r), style: { cursor: 'pointer' } })}
        />
      </Card>
      <NcrDrawer
        ncr={current}
        onClose={() => setCurrent(null)}
        onAction={(a) => (a === 'disp' ? setDispFor(current) : a === 'close' ? setCloseFor(current) : setCapaFor(current))}
      />
      <DispositionModal ncr={dispFor} onClose={() => setDispFor(null)} onDone={refresh} />
      <CloseModal ncr={closeFor} onClose={() => setCloseFor(null)} onDone={refresh} />
      <CapaModal ncr={capaFor} onClose={() => setCapaFor(null)} />
      <CreateNcrModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={reload} />
    </>
  );
}
