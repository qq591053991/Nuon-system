/**
 * 人员上岗资质：培训考核合格后登记上岗资质；工位报工时系统校验操作员是否持有该工序的有效资质。
 * 只列有工位报工权限的人员（显示工牌号，可扫工牌）；登记/变更/作废均需 QA 电子签名；人员登记后不可修改（选错请作废后重登）。
 */
import { Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Switch, Tag, Tooltip, Typography, message } from 'antd';
import { EditOutlined, IdcardOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InputRef } from 'antd';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import ResponsiveTable from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime, toDate } from '../../utils/format';
import { putSilent } from '../quality/qshared';

const userLabel = (u: Rec) => `${u.full_name}${u.badge_no ? `（工牌 ${u.badge_no}）` : `（${u.username}）`}${u.department ? ` · ${u.department}` : ''}`;

/** 资质当前状态 */
function stateOf(r: Rec): { text: string; color: string } {
  if (!r.is_active) return { text: r.voided_at || String(r.remark || '').includes('作废') ? '已作废' : '已停用', color: 'default' };
  const t = dayjs().format('YYYY-MM-DD');
  if (r.certified_at > t) return { text: '未生效', color: 'gold' };
  if (r.expires_at && r.expires_at < t) return { text: '已过期', color: 'red' };
  if (r.level === 'TRAINEE') return { text: '培训中（不可独立上岗）', color: 'orange' };
  if (r.expires_at && dayjs(r.expires_at).diff(dayjs(), 'day') <= 30) return { text: '有效（即将到期）', color: 'gold' };
  return { text: '有效', color: 'green' };
}

export default function Qualifications() {
  const { can, user } = useAuth();
  const editable = can('qa', 'admin');
  const [sign, signHolder] = useESign();
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/qualifications', {}, 50);
  const [users, setUsers] = useState<Rec[]>([]);
  const [codes, setCodes] = useState<Rec[]>([]);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [open, setOpen] = useState(false);
  const [badge, setBadge] = useState('');
  const badgeRef = useRef<InputRef>(null);
  const [form] = Form.useForm();
  const userId = Form.useWatch('user_id', form);

  useEffect(() => {
    get('/qualifications/op-codes', undefined, true).then(setCodes).catch(() => setCodes([]));
    if (editable) get('/qualifications/users', undefined, true).then(setUsers).catch(() => setUsers([]));
  }, [editable]);

  const userOptions = useMemo(() => users.map((u) => ({ value: u.id, label: userLabel(u) })), [users]);
  const codeOptions = useMemo(() => codes.map((c) => ({ value: c.code, label: c.code === '*' ? '* 全部工序' : `${c.code} ${c.name}` })), [codes]);
  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const picked = users.find((u) => u.id === userId);

  const openForm = (row: Rec | null) => {
    setEditing(row);
    setBadge('');
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
      : { level: 'QUALIFIED', certified_at: dayjs(), expires_at: dayjs().add(1, 'year'), is_active: true, trainer: user?.full_name });
  };

  /** 扫工牌 / 输入工牌号回车 → 选中人员 */
  const scanBadge = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    const found: Rec[] = await get('/qualifications/users', { badge: c, all: 1 }, true).catch(() => []);
    setBadge('');
    if (!found.length) {
      message.error(`未找到工牌“${c}”对应的人员，请核对工牌或在下拉中按姓名选择`);
      return;
    }
    const u = found[0];
    if (!u.can_report) {
      message.error(`${u.full_name}（工牌 ${u.badge_no}）没有工位报工权限，不需要登记上岗资质`);
      return;
    }
    if (!users.some((x) => x.id === u.id)) setUsers((us) => [u, ...us]);
    form.setFieldsValue({ user_id: u.id });
    message.success(`已选择：${userLabel(u)}`);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const u = users.find((x) => x.id === v.user_id);
    const body = {
      ...v,
      certified_at: toDate(v.certified_at),
      expires_at: toDate(v.expires_at),
      trainer: v.trainer ?? null,
      certificate: v.certificate ?? null,
      remark: v.remark ?? null,
      is_active: !!v.is_active,
    };
    if (editing) delete body.user_id;
    const op = v.op_code === '*' ? '全部工序' : `${v.op_code} ${codeName[v.op_code] ?? ''}`;
    try {
      await sign({
        meaning: editing ? '上岗资质变更' : '上岗资质登记',
        description: `${editing ? editing.user_full_name : u ? userLabel(u) : ''}：${op}，${dictLabel('qual_level', v.level)}，有效期至 ${toDate(v.expires_at) ?? '长期'}。`,
        defaultReason: editing ? undefined : v.certificate ? `培训考核合格（${v.certificate}）` : '培训考核合格',
        submit: (signature) => (editing ? putSilent(`/qualifications/${editing.id}`, { ...body, signature }) : post('/qualifications', { ...body, signature }, true)),
      });
      message.success(editing ? '资质已变更' : '资质已登记');
      setOpen(false);
      reload();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  const voidIt = async (r: Rec) => {
    try {
      await sign({
        meaning: '上岗资质作废',
        description: `作废 ${r.user_full_name}（${r.badge_no ? `工牌 ${r.badge_no}` : r.username}）的【${r.op_code === '*' ? '全部工序' : r.op_code}】资质：作废后不能在该工序报工，记录保留可追溯。如选错了人员，作废后请为正确的人员重新登记。`,
        reasonRequired: true, reasonLabel: '作废原因', reasonPlaceholder: '如：选错人员 / 考核不合格撤销 / 调岗',
        submit: (signature) => post(`/qualifications/${r.id}/void`, { reason: signature.reason, signature }, true),
      });
      message.success('已作废');
      reload();
    } catch (e) {
      if (!isCancel(e)) throw e;
    }
  };

  const columns: any[] = [
    {
      title: '人员', dataIndex: 'user_id', fixed: 'left', sorter: true, mobile: 'title',
      render: (_: any, r: Rec) => (
        <div>
          <b>{r.user_full_name}</b> {r.badge_no ? <Tag icon={<IdcardOutlined />} style={{ marginInlineStart: 4 }}>{r.badge_no}</Tag> : <Typography.Text type="secondary">{r.username}</Typography.Text>}
          {r.department && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.department}</Typography.Text></div>}
        </div>
      ),
    },
    {
      title: '状态', key: 'state', mobile: 'subtitle',
      render: (_: any, r: Rec) => {
        const s = stateOf(r);
        const tip = r.voided_at ? `${r.voided_by ?? ''} ${fmtDateTime(r.voided_at)} 作废：${r.void_reason ?? ''}` : '';
        return <Tooltip title={tip}><Tag color={s.color}>{s.text}</Tag></Tooltip>;
      },
    },
    {
      title: '工序', dataIndex: 'op_code', sorter: true,
      render: (v: string) => (v === '*' ? <Tag color="purple">* 全部工序</Tag> : <span><Tag>{v}</Tag>{codeName[v] ?? ''}</span>),
    },
    { title: '等级', dataIndex: 'level', sorter: true, render: (v: string) => <StatusTag dict="qual_level" value={v} /> },
    { title: '取证日期', dataIndex: 'certified_at', sorter: true, render: (v: string) => fmtDate(v) },
    { title: '有效期至', dataIndex: 'expires_at', sorter: true, render: (v: string) => (v ? fmtDate(v) : <Typography.Text type="secondary">长期</Typography.Text>) },
    { title: '培训/考核人', dataIndex: 'trainer', render: (v: string) => v || '-' },
    { title: '证书/记录编号', dataIndex: 'certificate', render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: string) => v || '-' },
    { title: '作废原因', dataIndex: 'void_reason', render: (v: string, r: Rec) => (v ? `${v}（${r.voided_by ?? ''}）` : '-') },
    { title: '登记', dataIndex: 'created_at', sorter: true, render: (_: any, r: Rec) => `${r.created_by_name ?? r.created_by ?? ''} ${fmtDateTime(r.created_at)}` },
  ];
  if (editable) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 150,
      render: (_: any, r: Rec) => (
        <Space size={4}>
          <Tooltip title="变更（等级/有效期/工序，需签名；人员不可改）"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openForm(r)} /></Tooltip>
          {r.is_active && <Button size="small" danger icon={<StopOutlined />} onClick={() => voidIt(r)}>作废</Button>}
        </Space>
      ),
    });
  }

  return (
    <>
      {signHolder}
      <PageHeader
        title="人员上岗资质"
        sub="培训 / 上岗资质矩阵：操作员经培训考核合格后，由质量部登记可上岗的工序（电子签名）。"
        extra={
          <Space wrap>
            <ExportButton url="/qualifications" params={query} filename="人员上岗资质" columns={[
              { title: '姓名', key: 'user_full_name' }, { title: '工牌号', key: 'badge_no' }, { title: '账号', key: 'username' }, { title: '部门', key: 'department' },
              { title: '工序代码', key: 'op_code' }, { title: '工序名称', value: (r) => (r.op_code === '*' ? '全部工序' : codeName[r.op_code] ?? '') },
              { title: '等级', value: (r) => dictLabel('qual_level', r.level) }, { title: '状态', value: (r) => stateOf(r).text },
              { title: '取证日期', key: 'certified_at', type: 'date' }, { title: '有效期至', key: 'expires_at', type: 'date' },
              { title: '培训/考核人', key: 'trainer' }, { title: '证书/记录编号', key: 'certificate' }, { title: '备注', key: 'remark' },
              { title: '作废原因', key: 'void_reason' }, { title: '作废人', key: 'voided_by' }, { title: '作废时间', key: 'voided_at', type: 'datetime' },
              { title: '登记人', value: (r) => r.created_by_name ?? r.created_by }, { title: '登记时间', key: 'created_at', type: 'datetime' },
            ]} />
            {editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>登记资质</Button>}
          </Space>
        }
      />
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="GMP：人员须经培训考核合格后上岗。工位报工时系统校验操作员是否持有该工序（或“* 全部工序”）的有效资质；已过期、已作废或“培训中”的资质不能独立报工。资质记录登记、变更、作废均需电子签名并保存审计追踪；选错人员请“作废”后重新登记。" />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="姓名 / 账号 / 工序 / 证书编号" style={{ width: 240 }} onSearch={(q) => setQuery({ q })} />
          {editable && (
            <Select allowClear showSearch optionFilterProp="label" placeholder="人员（姓名/工牌）" style={{ width: 240 }} options={userOptions}
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
        <ResponsiveTable rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal open={open} title={editing ? `变更上岗资质 - ${editing.user_full_name}` : '登记上岗资质'} width={720} onCancel={() => setOpen(false)} onOk={submit}
        okText="签名并保存" destroyOnHidden maskClosable={false}
        afterOpenChange={(o) => { if (o) { initForm(editing); setTimeout(() => badgeRef.current?.focus(), 0); } }}>
        <Form form={form} layout="vertical">
          {!editing && (
            <Form.Item label="扫工牌" tooltip="用读卡器/扫码枪刷工牌，或输入工牌号后回车">
              <Input ref={badgeRef} prefix={<IdcardOutlined />} autoFocus value={badge} placeholder="刷工牌或输入工牌号回车（如 E1001）" onChange={(e) => setBadge(e.target.value)}
                onPressEnter={(e) => { e.preventDefault(); scanBadge(badge); }} />
            </Form.Item>
          )}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="user_id" label="人员" rules={[{ required: true, message: '请刷工牌或选择人员' }]}
                extra={editing ? '人员登记后不可修改；如选错了人员，请“作废”后重新登记' : '只列有工位报工权限的人员'}>
                <Select showSearch optionFilterProp="label" options={userOptions} placeholder="按姓名或工牌号搜索" disabled={!!editing} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="op_code" label="工序代码" rules={[{ required: true, message: '请选择工序' }]} tooltip="取自工艺路线的工序代码；* 表示全部工序">
                <Select showSearch optionFilterProp="label" options={codeOptions} placeholder="选择工序（* = 全部工序）" />
              </Form.Item>
            </Col>
            {picked && !editing && (
              <Col span={24}>
                <Alert type="success" showIcon style={{ marginBottom: 12 }} message={<span>将为 <b>{userLabel(picked)}</b> 登记资质，请核对是否为本人。</span>} />
              </Col>
            )}
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
                <Switch disabled={!editing} />
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
