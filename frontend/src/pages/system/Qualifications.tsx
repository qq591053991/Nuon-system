/** 人员上岗资质（评审 P1-7）：培训考核合格后登记上岗资质；工位报工时系统校验操作员是否持有该工序的有效资质。 */
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';

const userLabel = (u: Rec) => `${u.full_name}（${u.username}）${u.department ? ` · ${u.department}` : ''}`;

/** 资质当前状态 */
function stateOf(r: Rec): { text: string; color: string } {
  if (!r.is_active) return { text: '已停用', color: 'default' };
  const t = dayjs().format('YYYY-MM-DD');
  if (r.certified_at > t) return { text: '未生效', color: 'gold' };
  if (r.expires_at && r.expires_at < t) return { text: '已过期', color: 'red' };
  if (r.level === 'TRAINEE') return { text: '培训中（不可独立上岗）', color: 'orange' };
  if (r.expires_at && dayjs(r.expires_at).diff(dayjs(), 'day') <= 30) return { text: '有效（即将到期）', color: 'gold' };
  return { text: '有效', color: 'green' };
}

export default function Qualifications() {
  const { can } = useAuth();
  const editable = can('qa', 'admin');
  const { rows, loading, setQuery, reload, pagination } = usePaged('/qualifications', {}, 50);
  const [users, setUsers] = useState<Rec[]>([]);
  const [codes, setCodes] = useState<Rec[]>([]);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    get('/qualifications/op-codes', undefined, true).then(setCodes).catch(() => setCodes([]));
    if (editable) get('/qualifications/users', undefined, true).then(setUsers).catch(() => setUsers([]));
  }, [editable]);

  const userOptions = useMemo(() => users.map((u) => ({ value: u.id, label: userLabel(u) })), [users]);
  const codeOptions = useMemo(() => codes.map((c) => ({ value: c.code, label: c.code === '*' ? '* 全部工序' : `${c.code} ${c.name}` })), [codes]);
  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);

  const openForm = (row: Rec | null) => {
    setEditing(row);
    setOpen(true);
  };

  /** 弹窗打开后填充表单（表单此时已挂载） */
  const initForm = (row: Rec | null) => {
    form.resetFields();
    form.setFieldsValue(row
      ? {
        user_id: row.user_id, op_code: row.op_code, level: row.level, certified_at: row.certified_at ? dayjs(row.certified_at) : null,
        expires_at: row.expires_at ? dayjs(row.expires_at) : null, trainer: row.trainer, certificate: row.certificate,
        is_active: row.is_active, remark: row.remark,
      }
      : { level: 'QUALIFIED', certified_at: dayjs(), expires_at: dayjs().add(1, 'year'), is_active: true });
  };

  const submit = async () => {
    const v = await form.validateFields();
    const body = {
      ...v,
      certified_at: toDate(v.certified_at),
      expires_at: toDate(v.expires_at),
      trainer: v.trainer ?? null,
      certificate: v.certificate ?? null,
      remark: v.remark ?? null,
      is_active: !!v.is_active,
    };
    setSaving(true);
    try {
      if (editing) await put(`/qualifications/${editing.id}`, body);
      else await post('/qualifications', body);
      message.success('已保存');
      setOpen(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: Rec) => {
    await put(`/qualifications/${r.id}`, { is_active: !r.is_active });
    message.success(r.is_active ? '已停用：该人员不能再在此工序报工' : '已启用');
    reload();
  };

  const columns: any[] = [
    {
      title: '人员', dataIndex: 'user_full_name', fixed: 'left',
      render: (v: string, r: Rec) => (
        <div>
          <b>{v}</b> <Typography.Text type="secondary">{r.username}</Typography.Text>
          {r.department && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.department}</Typography.Text></div>}
        </div>
      ),
    },
    {
      title: '工序', dataIndex: 'op_code',
      render: (v: string) => (v === '*' ? <Tag color="purple">* 全部工序</Tag> : <span><Tag>{v}</Tag>{codeName[v] ?? ''}</span>),
    },
    { title: '等级', dataIndex: 'level', render: (v: string) => <StatusTag dict="qual_level" value={v} /> },
    { title: '取证日期', dataIndex: 'certified_at', render: (v: string) => fmtDate(v) },
    { title: '有效期至', dataIndex: 'expires_at', render: (v: string) => (v ? fmtDate(v) : <Typography.Text type="secondary">长期</Typography.Text>) },
    {
      title: '状态', key: 'state',
      render: (_: any, r: Rec) => {
        const s = stateOf(r);
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    { title: '培训/考核人', dataIndex: 'trainer', render: (v: string) => v || '-' },
    { title: '证书/记录编号', dataIndex: 'certificate', render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: string) => v || '-' },
    { title: '登记', key: 'c', render: (_: any, r: Rec) => `${r.created_by ?? ''} ${fmtDateTime(r.created_at)}` },
  ];
  if (editable) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 150,
      render: (_: any, r: Rec) => (
        <Space size={4}>
          <Tooltip title="编辑"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openForm(r)} /></Tooltip>
          <Popconfirm title={r.is_active ? '停用该资质？停用后该人员不能在此工序报工。' : '重新启用该资质？'} onConfirm={() => toggle(r)}>
            <Button size="small" danger={r.is_active}>{r.is_active ? '停用' : '启用'}</Button>
          </Popconfirm>
        </Space>
      ),
    });
  }

  return (
    <>
      <PageHeader
        title="人员上岗资质"
        sub="培训 / 上岗资质矩阵：操作员经培训考核合格后，由质量部登记可上岗的工序。"
        extra={editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>登记资质</Button>}
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="GMP：人员须经培训考核合格后上岗。工位报工时系统校验操作员是否持有该工序（或“* 全部工序”）的有效资质；已过期、已停用或“培训中”的资质不能独立报工。资质记录保存审计追踪，取消资质请使用“停用”。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="姓名 / 账号 / 工序 / 证书编号" style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          {editable && (
            <Select allowClear showSearch optionFilterProp="label" placeholder="人员" style={{ width: 220 }} options={userOptions}
              onChange={(v) => setQuery({ user_id: v })} />
          )}
          <Select allowClear showSearch optionFilterProp="label" placeholder="工序代码" style={{ width: 200 }} options={codeOptions}
            onChange={(v) => setQuery({ op_code: v })} />
          <Select allowClear placeholder="等级" style={{ width: 150 }} options={dictOptions('qual_level')} onChange={(v) => setQuery({ level: v })} />
          <Space size={6}>
            <Switch onChange={(v) => setQuery({ valid: v ? 1 : undefined })} />
            <span>只看当前有效</span>
          </Space>
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal open={open} title={editing ? '编辑上岗资质' : '登记上岗资质'} width={720} onCancel={() => setOpen(false)} onOk={submit}
        confirmLoading={saving} destroyOnHidden maskClosable={false} afterOpenChange={(o) => o && initForm(editing)}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="user_id" label="人员" rules={[{ required: true, message: '请选择人员' }]}>
                <Select showSearch optionFilterProp="label" options={userOptions} placeholder="选择人员" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="op_code" label="工序代码" rules={[{ required: true, message: '请选择工序' }]} tooltip="取自工艺路线的工序代码；* 表示全部工序">
                <Select showSearch optionFilterProp="label" options={codeOptions} placeholder="选择工序（* = 全部工序）" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="level" label="等级" rules={[{ required: true, message: '请选择等级' }]}>
                <Select options={dictOptions('qual_level')} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="certified_at" label="取证日期" rules={[{ required: true, message: '请选择取证日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="expires_at" label="有效期至" tooltip="为空 = 长期有效；建议按复训周期设置">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="trainer" label="培训/考核人">
                <Input maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="certificate" label="证书/培训记录编号">
                <Input maxLength={128} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="is_active" label="启用" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label="备注">
                <Input.TextArea rows={2} maxLength={256} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
