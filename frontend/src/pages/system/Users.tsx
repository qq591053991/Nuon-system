import { Alert, Button, Card, Col, Form, Input, Modal, Result, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { CheckOutlined, EditOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { fmtDateTime } from '../../utils/format';

interface RoleDef { code: string; name: string; perms: string[] }
interface PermDef { code: string; name: string }

const ROLE_COLORS = ['magenta', 'volcano', 'orange', 'gold', 'green', 'cyan', 'blue', 'geekblue', 'purple', 'lime', 'red'];

/** 权限名称较长（含括号说明），表头只显示括号前部分 */
const shortPerm = (name: string) => name.split('（')[0];

function UserModal({ user, open, roles, onClose, onDone }: { user: Rec | null; open: boolean; roles: RoleDef[]; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { user: me } = useAuth();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(user
      ? { username: user.username, full_name: user.full_name, roles: user.role_list || [], department: user.department, email: user.email, is_active: user.is_active }
      : { roles: [], is_active: true });
  }, [open, user, form]);

  const submit = async () => {
    const v = await form.validateFields();
    const body = { ...v, password: v.password || null, is_active: !!v.is_active };
    if (user && user.username === me?.username && (!body.is_active || !body.roles.includes('admin'))) {
      const ok = await new Promise<boolean>((resolve) => Modal.confirm({
        title: '确认修改自己的账号？',
        content: '您正在停用自己的账号或移除自己的系统管理员角色，保存后可能无法再管理用户。',
        okText: '仍然保存',
        cancelText: '返回',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }));
      if (!ok) return;
    }
    setSaving(true);
    try {
      if (user) await put(`/system/users/${user.id}`, body);
      else await post('/system/users', body);
      message.success(user ? '用户已更新' : `用户 ${v.username} 已创建`);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={user ? `编辑用户 - ${user.username}` : '新增用户'}
      width={640}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
    >
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入账号' }, { pattern: /^[A-Za-z0-9_.-]+$/, message: '仅限字母、数字、下划线、点、横线' }]}>
              <Input disabled={!!user} placeholder="如 zhangsan" autoComplete="off" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="full_name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
              <Input placeholder="电子签名时显示的姓名" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="password"
              label={user ? '重置密码' : '初始密码'}
              rules={[{ required: !user, message: '请设置初始密码' }, { min: 6, message: '密码至少 6 位' }]}
              extra={user ? '留空则不修改密码' : '请通知用户首次登录后自行修改'}
            >
              <Input.Password autoComplete="new-password" placeholder={user ? '留空不修改' : '至少 6 位'} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="is_active" label="账号状态" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="roles" label="角色" rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一个角色' }]} extra="权限 = 所选角色权限的并集，见下方“角色权限矩阵”。">
              <Select
                mode="multiple"
                placeholder="选择角色"
                optionFilterProp="label"
                options={roles.map((r) => ({ value: r.code, label: `${r.name}（${r.code}）` }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="department" label="部门">
              <Input placeholder="如 质量部" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
              <Input />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function UsersAdmin() {
  const [roleData, setRoleData] = useState<{ roles: RoleDef[]; permissions: PermDef[] }>({ roles: [], permissions: [] });
  const { rows, loading, setQuery, reload, pagination } = usePaged('/system/users', {}, 50);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    get('/system/roles').then(setRoleData);
  }, []);

  const roleMap = useMemo(() => new Map(roleData.roles.map((r, i) => [r.code, { ...r, color: ROLE_COLORS[i % ROLE_COLORS.length] }])), [roleData]);

  const columns: TableColumnsType<Rec> = [
    { title: '账号', dataIndex: 'username', width: 120, render: (v) => <b className="mono">{v}</b> },
    { title: '姓名', dataIndex: 'full_name', width: 110 },
    {
      title: '角色', dataIndex: 'role_list', width: 260,
      render: (v: string[] | undefined) => (
        <Space size={[4, 4]} wrap>
          {(v || []).map((c) => {
            const r = roleMap.get(c);
            return <Tag key={c} color={r?.color} style={{ marginInlineEnd: 0 }}>{r?.name || c}</Tag>;
          })}
        </Space>
      ),
    },
    { title: '部门', dataIndex: 'department', width: 110, render: (v) => v || '-' },
    { title: '邮箱', dataIndex: 'email', width: 180, render: (v) => v || '-' },
    { title: '状态', dataIndex: 'is_active', width: 80, render: (v) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>) },
    { title: '创建时间', dataIndex: 'created_at', width: 140, render: (v) => fmtDateTime(v) },
    {
      title: '操作', key: '_op', width: 80, fixed: 'right',
      render: (_, r) => <Button size="small" type="link" icon={<EditOutlined />} onClick={() => { setEditing(r); setOpen(true); }}>编辑</Button>,
    },
  ];

  const matrixColumns: TableColumnsType<RoleDef> = [
    {
      title: '角色', key: 'role', fixed: 'left', width: 200,
      render: (_, r) => (
        <Space size={6}>
          <Tag color={roleMap.get(r.code)?.color} style={{ marginInlineEnd: 0 }}>{r.name}</Tag>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.code}</Typography.Text>
        </Space>
      ),
    },
    ...roleData.permissions.map((p) => ({
      title: <Tooltip title={p.name}><span style={{ whiteSpace: 'nowrap' }}>{shortPerm(p.name)}</span></Tooltip>,
      key: p.code,
      width: 90,
      align: 'center' as const,
      render: (_: unknown, r: RoleDef) => (r.perms.includes(p.code) ? <CheckOutlined style={{ color: '#389e0d', fontSize: 16 }} /> : <span style={{ color: '#e8e8e8' }}>—</span>),
    })),
    {
      title: '人数', key: 'cnt', width: 70, align: 'right',
      render: (_, r) => rows.filter((u) => (u.role_list || []).includes(r.code)).length || '-',
    },
  ];

  return (
    <>
      <PageHeader
        title="用户与角色"
        sub="按岗位分配角色；权限 = 角色权限的并集。停用离职人员账号，不要删除（审计追踪需保留其历史操作）。"
        extra={<Button type="primary" icon={<UserAddOutlined />} onClick={() => { setEditing(null); setOpen(true); }}>新增用户</Button>}
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          <Space wrap style={{ marginBottom: 16 }}>
            <Input.Search allowClear placeholder="账号 / 姓名" style={{ width: 220 }} onSearch={(q) => setQuery({ q: q.trim() })} />
            <Button icon={<ReloadOutlined />} onClick={reload} />
          </Space>
          <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
        </Card>
        <Card title="角色权限矩阵" size="small">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="角色与权限由系统预置，符合职责分离原则（如：仓管不能做质量判定，QA 才能放行产品）。如需调整请联系实施顾问。"
          />
          <Table rowKey="code" size="small" columns={matrixColumns} dataSource={roleData.roles} pagination={false} scroll={{ x: 'max-content' }} bordered />
        </Card>
      </Space>
      <UserModal user={editing} open={open} roles={roleData.roles} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />
    </>
  );
}

export default function Users() {
  const { can } = useAuth();
  if (!can('admin')) {
    return <Result status="403" title="403" subTitle="仅系统管理员可管理用户与角色。" />;
  }
  return <UsersAdmin />;
}
