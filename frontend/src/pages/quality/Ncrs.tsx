import {
  Alert, Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Spin, Steps, Tag, Tooltip, Typography, message,
} from 'antd';
import { AuditOutlined, CheckCircleOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SolutionOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import RemoteSelect, { CustomerSelect, MaterialSelect } from '../../components/RemoteSelect';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDateTime, fmtQty, toDate } from '../../utils/format';
import { DateRangeFilter, DueTag, QPrintButton, QPrintSignatures, useUrlFilters } from './qshared';
import { PrintHeader } from '../../components/Print';

const STATUS_TABS = [
  { value: 'OPEN', label: '待处置' },
  { value: 'DISPOSITIONED', label: '已处置待关闭' },
  { value: 'CLOSED', label: '已关闭' },
  { value: '', label: '全部' },
];
const DUE_TEXT = '处置期限按严重度：致命 3 天、严重 7 天、轻微 14 天';

/** 各来源允许的处置方式及其后果说明（与后端规则一致） */
/** 处置名称统一用字典名（与列表、签名台账一致），场景说明放在 hint */
function dispositionChoices(ncr: Rec): { value: string; label: string; hint?: string; desc: string }[] {
  const source = ncr.source;
  if (source === 'PROCESS') {
    return [
      { value: 'REWORK', label: '返工/返修', desc: '产品恢复为在制，需在不合格工序重新测试合格（记录为返工）；复测合格后才能关闭本 NCR。' },
      { value: 'SCRAP', label: '报废', desc: '产品报废并计入工单报废数；工单“完工 + 报废 = 计划数”时自动完工。' },
    ];
  }
  if (source === 'IQC') {
    return [
      { value: 'USE_AS_IS', label: '让步接收', desc: '不合格库存转为“合格”，可被领用。需评估对产品安全有效性的影响。' },
      { value: 'REWORK', label: '返工/返修', hint: '挑选后重检', desc: '库存转回“待检”，系统自动生成新的检验单；重检完成后才能关闭本 NCR。' },
      { value: 'RETURN', label: '退货', desc: '生成退供应商单，库存保持“不合格”隔离、暂不扣账；仓管实物出库确认后才扣减库存（采购可在“退供应商”中跟进）。' },
      { value: 'SCRAP', label: '报废', desc: '不合格库存立即报废出库。' },
    ];
  }
  if (source === 'CUSTOMER' && ncr.customer_return_no) {
    // 客户退货（RMA）关联的 NCR：关闭退货单时系统按此处置执行冻结库存
    return [
      { value: 'REWORK', label: '返工/返修', desc: `返修并重新检验合格后，关闭退货单 ${ncr.customer_return_no} 时退货品转为合格库存。` },
      { value: 'SCRAP', label: '报废', desc: `关闭退货单 ${ncr.customer_return_no} 时退货品报废出库，序列号标记为报废。` },
      { value: 'USE_AS_IS', label: '让步接收', desc: `经评审无质量问题（如客户误操作），关闭退货单 ${ncr.customer_return_no} 时转为合格库存。` },
      { value: 'RETURN', label: '退货', hint: '返还客户', desc: `原样返还客户，关闭退货单 ${ncr.customer_return_no} 时出库，序列号恢复为已发货。` },
    ];
  }
  if (source === 'CUSTOMER') {
    // 客诉开具、无实物退回的 NCR：处置针对客户手中的产品与后续措施
    return [
      { value: 'REWORK', label: '返工/返修', hint: '返修或更换', desc: '安排对客户产品返修或更换（现场或寄回）；完成后在调查记录中注明并关闭本 NCR。' },
      { value: 'USE_AS_IS', label: '让步接收', hint: '无需处理产品', desc: '经调查非产品质量问题（如使用不当），产品维持现状；向客户说明并在客诉中回复。' },
      { value: 'SCRAP', label: '报废', desc: '产品已无法修复，作报废处理（如需寄回，请登记客户退货）。' },
      { value: 'RETURN', label: '退货', hint: '退回客户', desc: '检测后原样退回客户。' },
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

// ---------------- 评审处置（选处置 → 签名弹窗输入密码回车即提交） ----------------
function DispositionModal({ ncr, onClose, onDone }: { ncr: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [sign, signHolder] = useESign();
  const choices = ncr ? dispositionChoices(ncr) : [];
  const disp = Form.useWatch('disposition', form);

  const submit = async () => {
    const v = await form.validateFields();
    const c = choices.find((x) => x.value === v.disposition);
    try {
      await sign({
        meaning: `不合格品评审处置：${dictLabel('disposition', v.disposition)}`,
        description: `${ncr!.no}：处置方式【${c?.label}${c?.hint ? `（${c.hint}）` : ''}】${v.disposition === 'REWORK' && v.require_part_change ? '，要求更换零件（工位重测前须先登记返工换件）' : ''}。${c?.desc ?? ''}`,
        defaultReason: v.remark,
        submit: (signature) => post(`/ncrs/${ncr!.id}/disposition`, {
          disposition: v.disposition, remark: v.remark, require_part_change: v.disposition === 'REWORK' && !!v.require_part_change, signature,
        }, true),
      });
      message.success(`${ncr!.no} 已处置：${c?.label}${v.disposition === 'RETURN' && ncr!.source === 'IQC' ? '，已生成退供应商单待仓管出库' : ''}`);
      onDone();
      onClose();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  return (
    <Modal open={!!ncr} title={`评审处置 - ${ncr?.no ?? ''}`} width={640} okText="签名并处置" onOk={submit} onCancel={onClose}
      destroyOnHidden maskClosable={false} afterOpenChange={(o) => o && form.resetFields()}>
      {signHolder}
      {ncr && (
        <>
          <Typography.Paragraph>
            <StatusTag dict="ncr_source" value={ncr.source} /> <StatusTag dict="severity" value={ncr.severity} /> {ncr.material_code} {ncr.material_name}
            {ncr.sn ? ` · SN ${ncr.sn}` : ''}{ncr.lot_no ? ` · 批号 ${ncr.lot_no}` : ''} · 数量 {fmtQty(ncr.qty)}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ background: '#fafafa', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{ncr.description}</Typography.Paragraph>
          {ncr.source === 'PROCESS' && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="生产过程不合格品不允许让步放行（医疗器械安全要求），只能返工或报废。" />}
        </>
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="disposition" label="处置方式" rules={[{ required: true, message: '请选择处置方式' }]}>
          <Radio.Group style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {choices.map((c) => (
                <Radio key={c.value} value={c.value}>
                  <b>{c.label}</b>{c.hint && <b>（{c.hint}）</b>} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.desc}</Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>
        {disp === 'REWORK' && (ncr?.source === 'PROCESS' || ncr?.sn) && (
          <Form.Item name="require_part_change" valuePropName="checked" style={{ marginTop: -8 }}
            extra="勾选后，工位重新测试前必须先在【返工换件】中登记拆下/装上的零件（单台追溯）；不勾选则可直接重测。">
            <Checkbox><b>需更换零件</b></Checkbox>
          </Form.Item>
        )}
        <Form.Item name="remark" label="评审意见" rules={[{ required: disp === 'USE_AS_IS', message: '让步接收必须填写风险评估意见' }]}>
          <Input.TextArea rows={3} placeholder={disp === 'USE_AS_IS' ? '请说明风险评估结论（对安全有效性无影响的依据）' : '如：原因为测试夹具接触不良，返工后重测'} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 关闭 NCR（单条或批量，一次签名） ----------------
function CloseModal({ ncrs, onClose, onDone }: { ncrs: Rec[] | null; onClose: () => void; onDone: () => void }) {
  const [capaId, setCapaId] = useState<number | undefined>();
  const [sign, signHolder] = useESign();
  const list = ncrs ?? [];
  const blocked = list.filter((n) => n.close_block);
  const submit = async () => {
    if (blocked.length) return;
    const nos = list.map((n) => n.no).join('、');
    try {
      await sign({
        meaning: 'NCR关闭',
        description: `确认 ${nos} 的处置已执行完毕（返工已复测合格 / 已报废 / 已退货出库），批准关闭${capaId ? '，并关联所选 CAPA' : ''}。`,
        defaultReason: '处置已完成，验证有效',
        submit: (signature) => (list.length === 1
          ? post(`/ncrs/${list[0].id}/close`, { capa_id: capaId ?? null, signature }, true)
          : post('/ncrs/close-batch', { ids: list.map((n) => n.id), capa_id: capaId ?? null, signature }, true)),
      });
      message.success(`已关闭 ${list.length} 条 NCR`);
      onDone();
      onClose();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };
  return (
    <Modal open={!!ncrs} title={list.length > 1 ? `批量关闭 ${list.length} 条 NCR` : `关闭 ${list[0]?.no ?? ''}`} okText="签名并关闭" onCancel={onClose} destroyOnHidden
      okButtonProps={{ disabled: blocked.length > 0 }} onOk={submit}
      afterOpenChange={(o) => o && setCapaId(list.length === 1 ? list[0]?.capa_id ?? undefined : undefined)}>
      {signHolder}
      {blocked.length > 0 ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="以下 NCR 暂不能关闭" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{blocked.map((n) => <li key={n.id}>{n.no}：{n.close_block}</li>)}</ul>} />
      ) : (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="确认处置已执行完毕后关闭，关闭需电子签名。如需系统性整改，可关联 CAPA。" />
      )}
      {list.length > 1 && <Typography.Paragraph type="secondary">{list.map((n) => n.no).join('、')}</Typography.Paragraph>}
      <div style={{ marginBottom: 4 }}>关联 CAPA（可选）</div>
      <RemoteSelect url="/capas" labelOf={(r) => `${r.no} ${r.title}`} matchKeys={['no']} noun="CAPA" value={capaId} onChange={(v) => setCapaId(v ?? undefined)} style={{ width: '100%' }} placeholder="搜索 CAPA 编号或标题" allowClear />
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
          message.success(`已创建 ${c.no}（默认完成期限 30 天），请继续填写负责人、根本原因与纠正措施`);
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
  const severity = Form.useWatch('severity', form);

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
          message.success(`已开具 ${n.no}，处置期限 ${n.due_on}，等待 QA 评审处置`);
          onDone();
          onClose();
        } finally {
          setSaving(false);
        }
      }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="来料检验和生产过程的不合格由系统自动开具；这里用于登记客户投诉、巡检发现等其他不合格。" />
      <Form form={form} layout="vertical" initialValues={{ source: 'OTHER', severity: 'MAJOR', qty: 1 }}>
        <Space size={16} wrap>
          <Form.Item name="source" label="来源">
            <Radio.Group optionType="button" options={[{ value: 'OTHER', label: '巡检/其他' }, { value: 'CUSTOMER', label: '客户投诉' }]} />
          </Form.Item>
          <Form.Item name="severity" label="严重程度" extra={`处置期限 ${({ CRITICAL: 3, MAJOR: 7, MINOR: 14 } as Rec)[severity || 'MAJOR']} 天`}>
            <Select style={{ width: 140 }} options={dictOptions('severity')} />
          </Form.Item>
          <Form.Item name="qty" label="数量">
            <InputNumber min={0.0001} style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="sn" label="产品序列号" extra="输入或扫码后自动带出产品与批号">
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
function NcrDrawer({ ncr, loading, onClose, onAction, onChanged }: {
  ncr: Rec | null; loading: boolean; onClose: () => void; onAction: (a: 'disp' | 'close' | 'capa') => void; onChanged: () => void;
}) {
  const { can } = useAuth();
  const [dueEdit, setDueEdit] = useState(false);
  if (!ncr) return <Drawer open={loading} onClose={onClose} width={680}><Spin /></Drawer>;
  // 当前待办节点：待处置 → 评审处置；已处置 → 关闭；已关闭 → 全部完成
  const step = ncr.status === 'OPEN' ? 1 : 2;
  const linked = [
    ...(ncr.inspection_id ? [{ entity: 'qms_inspection', entityId: ncr.inspection_id, label: `检验单 ${ncr.inspection_no ?? ''}` }] : []),
    ...(ncr.complaint_id ? [{ entity: 'qms_complaint', entityId: ncr.complaint_id, label: `客诉 ${ncr.complaint_no ?? ''}` }] : []),
    ...(ncr.customer_return_id ? [{ entity: 'wms_customer_return', entityId: ncr.customer_return_id, label: `退货单 ${ncr.customer_return_no ?? ''}` }] : []),
  ];
  const saveDue = async (d: dayjs.Dayjs | null) => {
    if (!d) return;
    await put(`/ncrs/${ncr.id}/due-date`, { due_date: toDate(d) });
    message.success('处置期限已调整');
    setDueEdit(false);
    onChanged();
  };
  return (
    <Drawer
      open
      width={680}
      title={<Space wrap>{ncr.no}<StatusTag dict="ncr_status" value={ncr.status} /><StatusTag dict="severity" value={ncr.severity} /></Space>}
      onClose={onClose}
      extra={(
        <Space>
          <QPrintButton drawer title={`不合格品报告 ${ncr.no}`} text="打印" />
          {can('qa') && ncr.status === 'OPEN' && <Button type="primary" icon={<AuditOutlined />} onClick={() => onAction('disp')}>评审处置</Button>}
          {can('qa') && ncr.status === 'DISPOSITIONED' && (
            <Tooltip title={ncr.close_block || ''}>
              <Button type="primary" icon={<CheckCircleOutlined />} disabled={!!ncr.close_block} onClick={() => onAction('close')}>关闭</Button>
            </Tooltip>
          )}
          {can('qa') && !ncr.capa_id && <Button icon={<SolutionOutlined />} onClick={() => onAction('capa')}>发起 CAPA</Button>}
        </Space>
      )}
    >
      <PrintHeader title="不合格品报告（NCR）" no={ncr.no} />
      <Steps size="small" current={step} status={ncr.status === 'CLOSED' ? 'finish' : 'process'} style={{ marginBottom: 16 }} items={[
        { title: '开具', description: fmtDateTime(ncr.created_at) },
        { title: '评审处置', description: ncr.disposition_by ? `${ncr.disposition_by}` : `期限 ${ncr.due_on}` },
        { title: '关闭', description: ncr.closed_by ? `${ncr.closed_by} ${fmtDateTime(ncr.closed_at)}` : 'QA 电子签名' },
      ]} />
      {ncr.overdue && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`已超过处置期限 ${-ncr.days_left} 天（期限 ${ncr.due_on}），请尽快评审处置`} />}
      {ncr.status === 'DISPOSITIONED' && ncr.close_block && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`暂不能关闭：${ncr.close_block}`} />}
      {ncr.status === 'DISPOSITIONED' && !ncr.close_block && can('qa') && <Alert type="success" showIcon style={{ marginBottom: 12 }} message="处置已执行完毕，可以关闭（电子签名）" />}
      {ncr.supplier_return_no && (
        <Alert type={ncr.supplier_return_status === 'SHIPPED' ? 'success' : 'info'} showIcon style={{ marginBottom: 12 }}
          message={<span>退供应商单 <Link to={`/quality/supplier-returns?id=${ncr.supplier_return_id}`}>{ncr.supplier_return_no}</Link>：{dictLabel('supplier_return_status', ncr.supplier_return_status)}</span>} />
      )}
      <Descriptions size="small" column={2} bordered items={[
        { key: 'src', label: '来源', children: <StatusTag dict="ncr_source" value={ncr.source} /> },
        {
          key: 'due', label: '处置期限',
          children: dueEdit
            ? <DatePicker size="small" autoFocus defaultValue={dayjs(ncr.due_on)} disabledDate={(d) => d.isBefore(dayjs(), 'day')} onChange={saveDue} onBlur={() => setDueEdit(false)} />
            : <Space size={4}><DueTag r={ncr} />{can('qa') && ncr.status === 'OPEN' && <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setDueEdit(true)} />}</Space>,
        },
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
        { key: 'sup', label: ncr.source === 'CUSTOMER' ? '客户' : '供应商', children: (ncr.source === 'CUSTOMER' ? ncr.customer_name : ncr.supplier_name) || '-' },
        { key: 'insp', label: '检验单', children: ncr.inspection_id ? <Link to={`/quality/inspections/${ncr.inspection_id}`}>{ncr.inspection_no ?? '查看检验单'}</Link> : ncr.complaint_no ? <Link to={`/quality/complaints?id=${ncr.complaint_id}`}>客诉 {ncr.complaint_no}</Link> : '-' },
        { key: 'qty', label: '数量', children: `${fmtQty(ncr.qty)} ${ncr.uom ?? ''}` },
        { key: 'by', label: '开具人', children: ncr.created_by_name || ncr.created_by || '-' },
        { key: 'desc', label: '不合格描述', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{ncr.description}</span> },
        {
          key: 'disp', label: '处置方式',
          children: <Space size={4} wrap><StatusTag dict="disposition" value={ncr.disposition} />{ncr.require_part_change && <Tag color="orange">已要求换件</Tag>}</Space>,
        },
        { key: 'dby', label: '处置人/时间', children: ncr.disposition_by ? `${ncr.disposition_by} ${fmtDateTime(ncr.disposition_at)}` : '-' },
        { key: 'drm', label: '评审意见', span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{ncr.disposition_remark || '-'}</span> },
        { key: 'capa', label: '关联 CAPA', span: 2, children: ncr.capa_id ? <Link to={`/quality/capas?id=${ncr.capa_id}`}>{ncr.capa_no ?? '查看 CAPA'}</Link> : '-' },
      ]} />
      {ncr.status === 'OPEN' && !can('qa') && <Alert style={{ marginTop: 16 }} type="info" showIcon message="NCR 由 QA 评审处置（需电子签名）。" />}
      {ncr.source === 'CUSTOMER' && !ncr.complaint_no && !ncr.customer_return_no && (
        <Alert style={{ marginTop: 16 }} type="info" showIcon
          message={<span>客户来源的 NCR 可能关联 <Link to={`/wms/customer-returns?q=${encodeURIComponent(ncr.sn || ncr.lot_no || '')}`}>客户退货</Link> 或 <Link to={`/quality/complaints?q=${encodeURIComponent(ncr.sn || ncr.lot_no || '')}`}>客户投诉</Link>。</span>} />
      )}
      <div style={{ marginTop: 16 }}>
        <Attachments entity="qms_ncr" entityId={ncr.id} bare linked={linked} hint="缺陷照片、检测报告、客户反馈材料等；来源检验单/客诉的附件一并显示。" canUpload={can('qc', 'qa', 'wms', 'mes')} />
        <QPrintSignatures roles={['开具', 'QA 评审处置', '关闭确认']} />
      </div>
    </Drawer>
  );
}

export default function Ncrs() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const url = useUrlFilters(['q', 'status', 'overdue', 'closable', 'source', 'severity', 'wo_id', 'capa_id']);
  const initStatus = url.status ?? (url.closable ? 'DISPOSITIONED' : url.q || url.overdue || url.wo_id || url.capa_id ? '' : 'OPEN');
  const [status, setStatus] = useState(initStatus);
  const [overdue, setOverdue] = useState(!!url.overdue);
  const [closableOnly, setClosableOnly] = useState(!!url.closable);
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/ncrs', { ...url, status: initStatus || undefined });
  const [current, setCurrent] = useState<Rec | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [dispFor, setDispFor] = useState<Rec | null>(null);
  const [closeFor, setCloseFor] = useState<Rec[] | null>(null);
  const [capaFor, setCapaFor] = useState<Rec | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Rec[]>([]);

  // 从其他页面带 ?q= 跳转过来时更新搜索
  const qParam = sp.get('q') || '';
  const lastQ = useRef(qParam);
  useEffect(() => {
    if (lastQ.current === qParam) return;
    lastQ.current = qParam;
    setQuery({ q: qParam || undefined });
  }, [qParam, setQuery]);

  const open = useCallback(async (id: number) => {
    setDrawerLoading(true);
    try {
      setCurrent(await get(`/ncrs/${id}`));
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  // 支持 /quality/ncrs?id=xx 直接打开（全局搜索、检验单、DHR 跳转）
  const idParam = Number(sp.get('id')) || null;
  useEffect(() => {
    if (idParam) open(idParam);
  }, [idParam, open]);

  const closeDrawer = () => {
    setCurrent(null);
    if (idParam) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const refresh = async () => {
    reload();
    setSelected([]);
    if (current) open(current.id);
  };

  const columns: any[] = [
    { title: 'NCR 编号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title', render: (v: string) => <Typography.Link>{v}</Typography.Link> },
    { title: '状态', dataIndex: 'status', sorter: true, mobile: 'subtitle', render: (v: string) => <StatusTag dict="ncr_status" value={v} /> },
    { title: '处置期限', dataIndex: 'due_date', sorter: true, render: (_: any, r: Rec) => <DueTag r={r} /> },
    {
      title: '处置 / 关闭条件', dataIndex: 'disposition',
      render: (v: string, r: Rec) => (
        <Space size={4} wrap>
          <StatusTag dict="disposition" value={v} />
          {r.require_part_change && <Tag color="orange" style={{ marginInlineEnd: 0 }}>需换件</Tag>}
          {r.status === 'DISPOSITIONED' && (r.close_block
            ? <Tooltip title={r.close_block}><Tag color="gold" style={{ marginInlineEnd: 0 }}>{r.disposition === 'RETURN' ? '待出库' : r.disposition === 'REWORK' ? '待复测' : '未满足'}</Tag></Tooltip>
            : <Tag color="green" style={{ marginInlineEnd: 0 }}>可关闭</Tag>)}
        </Space>
      ),
    },
    { title: '严重度', dataIndex: 'severity', sorter: true, render: (v: string) => <StatusTag dict="severity" value={v} /> },
    { title: '来源', dataIndex: 'source', sorter: true, render: (v: string) => <StatusTag dict="ncr_source" value={v} /> },
    { title: '物料/产品', dataIndex: 'material_name', render: (v: string, r: Rec) => (v ? <Tooltip title={r.material_code}>{v}</Tooltip> : '-') },
    { title: '批号 / 序列号', key: 'lot', render: (_: any, r: Rec) => (r.sn ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(r.sn)}`} onClick={stop}>{r.sn}</Link> : r.lot_no ? <span className="mono">{r.lot_no}</span> : '-') },
    { title: '工单/工序', key: 'wo', render: (_: any, r: Rec) => (r.wo_no ? <span><Link to={`/mes/work-orders/${r.wo_id}`} onClick={stop}>{r.wo_no}</Link>{r.op_name ? ` · ${r.op_name}` : ''}</span> : '-') },
    { title: '数量', dataIndex: 'qty', align: 'right', sorter: true, render: (v: number) => fmtQty(v) },
    { title: '不合格描述', dataIndex: 'description', width: 260, ellipsis: { showTitle: true } },
    { title: '开具时间', dataIndex: 'created_at', sorter: true, render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(v)}</span> },
    {
      title: '操作', key: '_op', fixed: 'right',
      render: (_: any, r: Rec) =>
        can('qa') && r.status === 'OPEN' ? (
          <Button size="small" type="primary" onClick={async (e) => { stop(e); setDispFor(await get(`/ncrs/${r.id}`)); }}>评审处置</Button>
        ) : can('qa') && r.status === 'DISPOSITIONED' ? (
          <Tooltip title={r.close_block || ''}>
            <Button size="small" disabled={!!r.close_block} onClick={(e) => { stop(e); setCloseFor([r]); }}>关闭</Button>
          </Tooltip>
        ) : null,
    },
  ];

  const closable = selected.filter((r) => r.status === 'DISPOSITIONED' && !r.close_block);

  return (
    <>
      <PageHeader
        title="不合格品 NCR"
        sub="来料检验不合格、工位测试不合格由系统自动开具；QA 电子签名评审处置并关闭。生产过程不合格品只能返工或报废，返工须复测合格后才能关闭。"
        extra={
          <Space wrap>
            <ExportButton url="/ncrs" params={query} filename="不合格品NCR" columns={[
              { title: 'NCR 编号', key: 'no' }, { title: '状态', value: (r) => dictLabel('ncr_status', r.status) },
              { title: '处置期限', key: 'due_on', type: 'date' }, { title: '超期', value: (r) => (r.overdue ? `超期 ${-r.days_left} 天` : '') },
              { title: '严重度', value: (r) => dictLabel('severity', r.severity) }, { title: '来源', value: (r) => dictLabel('ncr_source', r.source) },
              { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '批号', key: 'lot_no' }, { title: '序列号', key: 'sn' },
              { title: '工单', key: 'wo_no' }, { title: '工序', key: 'op_name' }, { title: '供应商', key: 'supplier_name' }, { title: '客户', key: 'customer_name' },
              { title: '数量', key: 'qty', type: 'number' }, { title: '不合格描述', key: 'description', width: 50 },
              { title: '处置', value: (r) => dictLabel('disposition', r.disposition) }, { title: '处置人', key: 'disposition_by' }, { title: '处置时间', key: 'disposition_at', type: 'datetime' },
              { title: '评审意见', key: 'disposition_remark' }, { title: '关闭人', key: 'closed_by' }, { title: '关闭时间', key: 'closed_at', type: 'datetime' },
              { title: '开具人', key: 'created_by' }, { title: '开具时间', key: 'created_at', type: 'datetime' },
            ]} />
            {can('qc', 'qa') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建 NCR</Button>}
          </Space>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setSelected([]); setQuery({ status: v || undefined }); }} />
          <Tooltip title="处置已执行完毕（返工已复测、退货已出库、重检已完成），可以签名关闭">
            <Checkbox checked={closableOnly} onChange={(e) => { setClosableOnly(e.target.checked); setQuery({ closable: e.target.checked ? 1 : undefined }); }}>
              <span style={{ color: closableOnly ? '#389e0d' : undefined }}>只看可关闭</span>
            </Checkbox>
          </Tooltip>
          <Tooltip title={DUE_TEXT}>
            <Checkbox checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setQuery({ overdue: e.target.checked ? 1 : undefined }); }}>
              <span style={{ color: overdue ? '#cf1322' : undefined }}>只看超期</span>
            </Checkbox>
          </Tooltip>
          <Select allowClear mode="multiple" maxTagCount="responsive" placeholder="严重度" style={{ width: 160 }} defaultValue={url.severity ? String(url.severity).split(',') : undefined}
            options={dictOptions('severity')} onChange={(v: string[]) => setQuery({ severity: v?.length ? v.join(',') : undefined })} />
          <Select allowClear placeholder="来源" style={{ width: 110 }} defaultValue={url.source} options={dictOptions('ncr_source')} onChange={(v) => setQuery({ source: v })} />
          <DateRangeFilter placeholder={['开具起', '开具止']} onChange={(v) => setQuery(v)} />
          <Input.Search key={qParam} allowClear placeholder="编号 / 序列号 / 批号 / 描述" defaultValue={qParam} style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        {can('qa') && (status === 'DISPOSITIONED' || status === '') && (
          <Space style={{ marginBottom: 12 }} wrap>
            <Button type="primary" icon={<CheckCircleOutlined />} disabled={!closable.length} onClick={() => setCloseFor(closable)}>
              批量关闭{closable.length ? `（${closable.length}）` : ''}
            </Button>
            <Typography.Text type="secondary">勾选“可关闭”的 NCR，一次电子签名全部关闭；返工未复测、退货未出库的不能勾选。</Typography.Text>
          </Space>
        )}
        <ResponsiveTable<Rec>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          onChange={onTableChange}
          scroll={{ x: 'max-content' }}
          rowSelection={can('qa') && (status === 'DISPOSITIONED' || status === '') ? {
            selectedRowKeys: selected.map((r) => r.id),
            onChange: (_k, rs) => setSelected(rs as Rec[]),
            getCheckboxProps: (r: Rec) => ({ disabled: r.status !== 'DISPOSITIONED' || !!r.close_block }),
          } : undefined}
          onRow={(r) => ({
            // 点勾选框只勾选，不打开详情
            onClick: (e) => { if (!(e.target as HTMLElement).closest('.ant-table-selection-column')) open(r.id); },
            style: { cursor: 'pointer', background: r.overdue ? '#fff1f0' : undefined },
          })}
        />
      </Card>
      <NcrDrawer
        ncr={current}
        loading={drawerLoading}
        onClose={closeDrawer}
        onChanged={refresh}
        onAction={(a) => (a === 'disp' ? setDispFor(current) : a === 'close' ? setCloseFor(current ? [current] : null) : setCapaFor(current))}
      />
      <DispositionModal ncr={dispFor} onClose={() => setDispFor(null)} onDone={refresh} />
      <CloseModal ncrs={closeFor} onClose={() => setCloseFor(null)} onDone={refresh} />
      <CapaModal ncr={capaFor} onClose={() => setCapaFor(null)} />
      <CreateNcrModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={reload} />
    </>
  );
}
