import {
  Alert, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Row, Segmented, Select, Space, Spin, Steps, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import { CheckCircleOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';
import { QPrintButton, QPrintSignatures, useUrlFilters } from './qshared';
import { PrintHeader } from '../../components/Print';

const STATUS_TABS = [
  { value: 'OPEN,IN_PROGRESS,VERIFYING', label: '未关闭' },
  { value: '', label: '全部' },
  { value: 'OPEN', label: '新建' },
  { value: 'IN_PROGRESS', label: '进行中' },
  { value: 'VERIFYING', label: '有效性验证' },
  { value: 'CLOSED', label: '已关闭' },
];
const FLOW = ['OPEN', 'IN_PROGRESS', 'VERIFYING', 'CLOSED'];

const TEXT_FIELDS: { name: string; label: string; placeholder: string }[] = [
  { name: 'description', label: '问题描述', placeholder: '发生了什么、在哪里、影响范围（产品/批次/数量）' },
  { name: 'root_cause', label: '根本原因', placeholder: '5Why / 鱼骨图分析结论：人、机、料、法、环、测' },
  { name: 'correction', label: '纠正（立即处置）', placeholder: '对已发生问题的处置，如：隔离、返工、筛选在库品' },
  { name: 'corrective_action', label: '纠正措施', placeholder: '消除根本原因、防止再发生的措施，如：修改 SOP、增加防呆、供应商整改' },
  { name: 'preventive_action', label: '预防措施', placeholder: '举一反三：其他产品/工序是否存在同类风险及其预防' },
  { name: 'effectiveness', label: '有效性验证', placeholder: '验证方法、数据与结论，如：后续 3 批 FPY 由 92% 提升至 99%，未再发生' },
];

const overdue = (r: Rec) => r.due_date && r.status !== 'CLOSED' && dayjs(r.due_date).isBefore(dayjs(), 'day');
/** CAPA 默认完成期限（天，按来源，与后端一致）：客诉/NCR 30 天、审核发现 60 天、其他 30 天 */
const DUE_BY_SOURCE: Record<string, number> = { COMPLAINT: 30, NCR: 30, AUDIT: 60, OTHER: 30 };
const DUE_DAYS = 30;
const dueBySource = (src?: string) => dayjs().add(DUE_BY_SOURCE[src || 'OTHER'] ?? DUE_DAYS, 'day');

/** 负责人下拉（启用账号，按姓名/账号/部门搜索；保存负责人账号） */
function useOwners() {
  const [owners, setOwners] = useState<Rec[]>([]);
  useEffect(() => {
    get<Rec[]>('/capas/owners', undefined, true).then(setOwners).catch(() => setOwners([]));
  }, []);
  return owners.map((u) => ({ value: u.id as number, label: `${u.full_name}（${u.username}）${u.department ? ` · ${u.department}` : ''}` }));
}

function CapaDrawer({ open, capaId, onClose, onSaved }: { open: boolean; capaId: number | null; onClose: () => void; onSaved: (id: number) => void }) {
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  const [form] = Form.useForm();
  const [capa, setCapa] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const ownerOptions = useOwners();

  const load = async (id: number) => {
    setLoading(true);
    try {
      const d = await get(`/capas/${id}`);
      setCapa(d);
      // 旧记录没有完成期限时按来源带出默认期限（保存时写入）
      if (can('qa') && d.status !== 'CLOSED') form.setFieldsValue({ ...d, due_date: d.due_date ? dayjs(d.due_date) : dueBySource(d.source) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setCapa(null);
    if (can('qa')) {
      form.resetFields();
      if (!capaId) form.setFieldsValue({ source: 'OTHER', due_date: dueBySource('OTHER') });
    }
    if (capaId) load(capaId);
  }, [open, capaId]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = can('qa') && (!capa || capa.status !== 'CLOSED');
  const body = (v: Rec) => {
    const { owner: _o, ...rest } = v;
    return { ...rest, owner_user_id: v.owner_user_id ?? null, due_date: toDate(v.due_date) };
  };

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (capa) {
        await put(`/capas/${capa.id}`, body(v));
        message.success('已保存');
        await load(capa.id);
        onSaved(capa.id);
      } else {
        const c = await post('/capas', body(v));
        message.success(`已创建 ${c.no}，请继续分析根本原因并制定措施`);
        onSaved(c.id); // 父组件切换到新 id，抽屉自动加载
      }
    } finally {
      setSaving(false);
    }
  };

  const openNcrs: Rec[] = (capa?.ncrs ?? []).filter((n: Rec) => n.status === 'OPEN');

  const changeStatus = async (to: string) => {
    if (!capa) return;
    const v = await form.validateFields();
    if (to === 'VERIFYING' && (!v.root_cause || !v.corrective_action)) {
      message.warning('请先填写“根本原因”和“纠正措施”');
      return;
    }
    if (to === 'CLOSED' && !v.effectiveness) {
      message.warning('请先填写“有效性验证”结论');
      return;
    }
    if (to === 'CLOSED' && openNcrs.length) {
      message.warning(`关联的 ${openNcrs.map((n) => n.no).join('、')} 尚未评审处置，不能关闭 CAPA`);
      return;
    }
    setSaving(true);
    try {
      const saved = await put(`/capas/${capa.id}`, body(v));
      if (saved.status !== to) {
        if (to === 'CLOSED') {
          await sign({
            meaning: 'CAPA关闭批准', description: `${capa.no}：确认纠正预防措施已实施且验证有效，批准关闭。`, defaultReason: '措施已实施，验证有效',
            submit: (signature) => post(`/capas/${capa.id}/status`, { status: to, effectiveness: v.effectiveness, signature }, true),
          });
        } else await post(`/capas/${capa.id}/status`, { status: to, effectiveness: v.effectiveness });
      }
      message.success({ IN_PROGRESS: '已进入处理', VERIFYING: '已提交有效性验证', CLOSED: 'CAPA 已关闭' }[to] || '状态已更新');
      await load(capa.id);
      onSaved(capa.id);
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSaving(false);
    }
  };

  const st = capa?.status;
  const actions = editable && (
    <Space wrap>
      <Button icon={<SaveOutlined />} loading={saving} onClick={save}>{capa ? '保存' : '创建'}</Button>
      {st === 'OPEN' && <Button type="primary" icon={<SendOutlined />} loading={saving} onClick={() => changeStatus('IN_PROGRESS')}>开始处理</Button>}
      {st === 'IN_PROGRESS' && <Button type="primary" icon={<SendOutlined />} loading={saving} onClick={() => changeStatus('VERIFYING')}>提交有效性验证</Button>}
      {st === 'VERIFYING' && <Button icon={<RollbackOutlined />} loading={saving} onClick={() => changeStatus('IN_PROGRESS')}>退回整改</Button>}
      {st === 'VERIFYING' && (
        <Tooltip title={openNcrs.length ? `关联的 ${openNcrs.map((n) => n.no).join('、')} 尚未评审处置` : ''}>
          <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} disabled={openNcrs.length > 0} onClick={() => changeStatus('CLOSED')}>批准关闭（电子签名）</Button>
        </Tooltip>
      )}
    </Space>
  );

  return (
    <Drawer
      open={open}
      width={760}
      onClose={onClose}
      destroyOnHidden
      title={capa ? <Space>{capa.no}<StatusTag dict="capa_status" value={capa.status} /></Space> : capaId ? '加载中…' : '新建 CAPA'}
      extra={<Space wrap>{capa && <QPrintButton drawer title={`CAPA ${capa.no}`} text="打印" />}{actions}</Space>}
    >
      {signHolder}
      {capa && <PrintHeader title="纠正预防措施（CAPA）" no={capa.no} />}
      {capa && editable && (
        <div className="print-only">
          <Descriptions size="small" column={2} bordered items={[
            { key: 't', label: '标题', span: 2, children: capa.title },
            { key: 's', label: '来源', children: dictLabel('capa_source', capa.source) },
            { key: 'st', label: '状态', children: dictLabel('capa_status', capa.status) },
            { key: 'o', label: '负责人', children: capa.owner || '-' },
            { key: 'd', label: '完成期限', children: fmtDate(capa.due_date) },
            ...TEXT_FIELDS.map((f) => ({ key: f.name, label: f.label, span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{capa[f.name] || '-'}</span> })),
          ]} />
        </div>
      )}
      <Spin spinning={loading}>
        {capa && (
          <Steps size="small" style={{ marginBottom: 16 }} current={FLOW.indexOf(capa.status)} status={capa.status === 'CLOSED' ? 'finish' : 'process'} items={[
            { title: '新建', description: fmtDate(capa.created_at) },
            { title: '原因分析与整改' },
            { title: '有效性验证' },
            { title: '关闭', description: capa.closed_by ? `${capa.closed_by} ${fmtDate(capa.closed_at)}` : 'QA 电子签名' },
          ]} />
        )}
        {capa && st === 'VERIFYING' && openNcrs.length > 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`关联的 ${openNcrs.map((n) => n.no).join('、')} 尚未评审处置：请先在 NCR 中评审处置后再关闭 CAPA。`} />
        )}
        {capa && st !== 'CLOSED' && (
          <Alert type="info" showIcon style={{ marginBottom: 16 }} message={
            st === 'OPEN' ? '下一步：分析根本原因并填写纠正措施，点击【开始处理】。'
              : st === 'IN_PROGRESS' ? '下一步：措施实施后，点击【提交有效性验证】（需已填写根本原因和纠正措施）。'
                : '下一步：填写有效性验证结论，验证有效则【批准关闭】（电子签名），无效则【退回整改】。'
          } />
        )}
        {editable ? (
          <Form form={form} layout="vertical" className="no-print">
            <Row gutter={16}>
              <Col span={24}>
                <Form.Item name="title" label="标题" rules={[{ required: true, message: '请填写标题' }]}><Input /></Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item name="source" label="来源">
                  <Select options={dictOptions('capa_source')} onChange={(src) => {
                    // 期限未手工改过时按来源重设默认期限
                    if (!form.isFieldTouched('due_date')) form.setFieldsValue({ due_date: dueBySource(src) });
                  }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item name="owner_user_id" label="负责人" rules={[{ required: true, message: '请选择负责人' }]}>
                  <Select showSearch allowClear optionFilterProp="label" options={ownerOptions} placeholder="选择负责人" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={8}>
                <Form.Item name="due_date" label="完成期限" tooltip="按来源默认：客诉/NCR 30 天、审核发现 60 天" rules={[{ required: true, message: '请选择完成期限' }]}>
                  <DatePicker style={{ width: '100%' }} presets={[30, 60, 90].map((d) => ({ label: `${d} 天`, value: dayjs().add(d, 'day') }))} />
                </Form.Item>
              </Col>
              {TEXT_FIELDS.map((f) => (
                <Col span={24} key={f.name}>
                  <Form.Item name={f.name} label={f.label}
                    tooltip={f.name === 'effectiveness' ? '关闭 CAPA 前必须填写' : f.name === 'root_cause' || f.name === 'corrective_action' ? '提交有效性验证前必须填写' : undefined}>
                    <Input.TextArea rows={f.name === 'description' ? 3 : 2} placeholder={f.placeholder} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </Form>
        ) : capa ? (
          <Descriptions size="small" column={2} bordered items={[
            { key: 't', label: '标题', span: 2, children: capa.title },
            { key: 's', label: '来源', children: <StatusTag dict="capa_source" value={capa.source} /> },
            { key: 'o', label: '负责人', children: capa.owner || '-' },
            { key: 'd', label: '完成期限', children: fmtDate(capa.due_date) },
            { key: 'c', label: '关闭', children: capa.closed_by ? `${capa.closed_by} ${fmtDateTime(capa.closed_at)}` : '-' },
            ...TEXT_FIELDS.map((f) => ({ key: f.name, label: f.label, span: 2, children: <span style={{ whiteSpace: 'pre-wrap' }}>{capa[f.name] || '-'}</span> })),
          ]} />
        ) : null}
        {capa && (
          <Card size="small" title={`关联不合格品（${capa.ncrs?.length || 0}）`} style={{ marginTop: 16 }}>
            {capa.ncrs?.length ? (
              <Table<Rec> rowKey="id" size="small" pagination={false} dataSource={capa.ncrs} columns={[
                { title: 'NCR', dataIndex: 'no', render: (v, r) => <Link to={`/quality/ncrs?id=${r.id}`}>{v}</Link> },
                { title: '来源', dataIndex: 'source', render: (v) => <StatusTag dict="ncr_source" value={v} /> },
                { title: '物料', dataIndex: 'material_name', render: (v) => v || '-' },
                { title: '描述', dataIndex: 'description', width: 280, ellipsis: true },
                { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="ncr_status" value={v} /> },
              ]} />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无关联 NCR（可在 NCR 页面关闭时关联）" />}
          </Card>
        )}
        {capa && (
          <div style={{ marginTop: 16 }}>
            <Attachments entity="qms_capa" entityId={capa.id} bare title="附件（证据）" hint="根因分析（5Why/鱼骨图）、整改前后照片、修订后的 SOP、有效性验证数据等。" canUpload={can('qa')} />
          </div>
        )}
        {capa && <QPrintSignatures roles={['负责人', 'QA 验证', '质量负责人批准关闭']} />}
      </Spin>
    </Drawer>
  );
}

export default function Capas() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const url = useUrlFilters(['status', 'q', 'overdue']);
  const initStatus = url.status ?? (url.q ? '' : 'OPEN,IN_PROGRESS,VERIFYING');
  const [status, setStatus] = useState(initStatus);
  const [od, setOd] = useState(!!url.overdue);
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/capas', { ...url, status: initStatus || undefined });
  const [drawer, setDrawer] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });

  // 支持 /quality/capas?id=xx 直接打开
  const idParam = Number(sp.get('id')) || null;
  useEffect(() => {
    if (idParam) setDrawer({ open: true, id: idParam });
  }, [idParam]);

  const close = () => {
    setDrawer({ open: false, id: null });
    if (idParam) {
      const next = new URLSearchParams(sp);
      next.delete('id');
      setSp(next, { replace: true });
    }
  };

  const columns: any[] = [
    { title: 'CAPA 编号', dataIndex: 'no', fixed: 'left', sorter: true, mobile: 'title', render: (v: string) => <Typography.Link>{v}</Typography.Link> },
    { title: '状态', dataIndex: 'status', sorter: true, mobile: 'subtitle', render: (v: string) => <StatusTag dict="capa_status" value={v} /> },
    { title: '标题', dataIndex: 'title', width: 260, ellipsis: true },
    { title: '完成期限', dataIndex: 'due_date', sorter: true, render: (v: string, r: Rec) => (overdue(r) ? <Tag color="red">{fmtDate(v)} 已逾期</Tag> : fmtDate(v)) },
    { title: '负责人', dataIndex: 'owner', sorter: true, render: (v: string) => v || <Typography.Text type="danger">未指定</Typography.Text> },
    { title: '来源', dataIndex: 'source', sorter: true, render: (v: string) => <StatusTag dict="capa_source" value={v} /> },
    { title: '创建', dataIndex: 'created_at', sorter: true, render: (_: any, r: Rec) => <span style={{ whiteSpace: 'nowrap' }}>{r.created_by_name ?? r.created_by ?? ''} {fmtDate(r.created_at)}</span> },
    { title: '关闭', dataIndex: 'closed_at', sorter: true, render: (_: any, r: Rec) => (r.closed_by ? `${r.closed_by} ${fmtDate(r.closed_at)}` : '-') },
  ];

  return (
    <>
      <PageHeader
        title="纠正预防措施 CAPA"
        sub="针对严重或重复发生的不合格，分析根本原因、实施纠正/预防措施并验证有效性；关闭需 QA 电子签名（关联 NCR 须已评审处置）。"
        extra={
          <Space wrap>
            <ExportButton url="/capas" params={query} filename="CAPA" columns={[
              { title: 'CAPA 编号', key: 'no' }, { title: '状态', value: (r) => dictLabel('capa_status', r.status) }, { title: '标题', key: 'title' },
              { title: '来源', value: (r) => dictLabel('capa_source', r.source) }, { title: '负责人', key: 'owner' }, { title: '完成期限', key: 'due_date', type: 'date' },
              { title: '逾期', value: (r) => (overdue(r) ? '是' : '') }, { title: '问题描述', key: 'description' }, { title: '根本原因', key: 'root_cause' },
              { title: '纠正', key: 'correction' }, { title: '纠正措施', key: 'corrective_action' }, { title: '预防措施', key: 'preventive_action' },
              { title: '有效性验证', key: 'effectiveness' }, { title: '创建人', key: 'created_by' }, { title: '创建时间', key: 'created_at', type: 'datetime' },
              { title: '关闭人', key: 'closed_by' }, { title: '关闭时间', key: 'closed_at', type: 'datetime' },
            ]} />
            {can('qa') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ open: true, id: null })}>新建 CAPA</Button>}
          </Space>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={status} options={STATUS_TABS} onChange={(v) => { setStatus(v as string); setQuery({ status: v || undefined }); }} />
          <Checkbox checked={od} onChange={(e) => { setOd(e.target.checked); setQuery({ overdue: e.target.checked ? 1 : undefined }); }}>
            <span style={{ color: od ? '#cf1322' : undefined }}>只看逾期</span>
          </Checkbox>
          <Input.Search allowClear placeholder="编号 / 标题 / 负责人" defaultValue={url.q} style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
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
          onRow={(r) => ({ onClick: () => setDrawer({ open: true, id: r.id }), style: { cursor: 'pointer', background: overdue(r) ? '#fff1f0' : undefined } })}
        />
      </Card>
      <CapaDrawer
        open={drawer.open}
        capaId={drawer.id}
        onClose={close}
        onSaved={(id) => {
          reload();
          if (drawer.id !== id) setDrawer({ open: true, id });
        }}
      />
    </>
  );
}
