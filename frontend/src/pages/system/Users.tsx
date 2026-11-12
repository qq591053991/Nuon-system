import {
  Alert, AutoComplete, Badge, Button, Card, Checkbox, Col, Form, Input, Modal, Popconfirm, Popover, Radio, Result, Row, Select, Space, Switch, Table, Tag,
  Tooltip, Typography, message, type InputRef, type TableColumnsType,
} from 'antd';
import {
  CheckOutlined, EditOutlined, FileExcelOutlined, IdcardOutlined, KeyOutlined, LockOutlined, ReloadOutlined, SafetyOutlined, StopOutlined,
  UnlockOutlined, UserAddOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { download, get, post, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { fmtDate, fmtDateTime } from '../../utils/format';
import { ImportFlow, type ImportResult } from './DataImport';

interface RoleDef { code: string; name: string; perms: string[] }
interface PermDef { code: string; name: string }
interface PwdPolicy { min_length: number; require_letter_digit: boolean; text: string }
interface Summary {
  total: number; active: number; inactive: number; locked: number; no_role: number; initial_password: number; failed: number;
  demo_password: { id: number; username: string; full_name: string }[]; demo_mode: boolean; demo_password_text: string | null;
  departments: { name: string; count: number }[]; role_counts: Record<string, number>;
}
/** 一次性显示的临时密码 */
interface IssuedPassword { username: string; full_name: string; temp_password?: string | null; temp_pin?: string | null; badge_no?: string | null; roles?: string; department?: string | null }

/**
 * 最近一次批量导入的初始密码清单：只保存在本页内存中（不落盘、刷新即清除），
 * 关闭导入弹窗后仍可再次查看/下载（E-N9：导入中途关掉弹窗也能拿到清单）。
 */
let lastImported: { at: string; list: IssuedPassword[] } | null = null;

const ROLE_COLORS = ['magenta', 'volcano', 'orange', 'gold', 'green', 'cyan', 'blue', 'geekblue', 'purple', 'lime', 'red'];

/** 权限名称较长（含括号说明），矩阵表头用简称（悬停看全称） */
const PERM_SHORT: Record<string, string> = {
  master: '主数据', engineering: '工程数据', sales: '销售', purchase: '采购', plan: '生产计划', wms: '仓储', mes: '车间报工',
  qc: '质量检验', qa: '质量保证', finance: '财务', admin: '系统管理', audit: '审计查阅',
};
const shortPerm = (code: string, name: string) => PERM_SHORT[code] ?? name.split('（')[0];

/** 临时密码只显示这一次：可复制、可下载 Excel 分发清单 */
function IssuedModal({ list, onClose }: { list: IssuedPassword[] | null; onClose: () => void }) {
  const one = list?.length === 1 ? list[0] : null;
  const pinOnly = !!list?.length && list.every((x) => !x.temp_password && x.temp_pin);
  return (
    <Modal
      open={!!list}
      title={<Space><KeyOutlined style={{ color: '#fa8c16' }} />{one
        ? `已为 ${one.full_name}（${one.username}）设置${one.temp_password ? '临时密码' : ''}${one.temp_password && one.temp_pin ? '和' : ''}${one.temp_pin ? '工位 PIN' : ''}`
        : `${pinOnly ? '工位 PIN' : '初始密码'}分发清单（${list?.length ?? 0} 人）`}</Space>}
      onCancel={onClose}
      maskClosable={false}
      width={one ? 520 : 820}
      footer={(
        <Space>
          {list && list.length > 0 && (
            <ExportButton
              rows={list}
              filename={`初始密码分发清单_${fmtDate(new Date().toISOString())}`}
              title="初始密码分发清单（首次登录须修改密码；请当面或单独发给本人，用后销毁）"
              text="下载 Excel 清单"
              columns={[
                { title: '登录账号', key: 'username', width: 14 }, { title: '姓名', key: 'full_name', width: 10 },
                { title: '角色', key: 'roles', width: 20 }, { title: '部门', key: 'department', width: 10 },
                { title: '临时密码', key: 'temp_password', width: 16 }, { title: '工牌号', key: 'badge_no', width: 10 }, { title: '工位PIN', key: 'temp_pin', width: 10 },
              ]}
            />
          )}
          <Button type="primary" onClick={onClose}>我已记下，关闭</Button>
        </Space>
      )}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={pinOnly
          ? '工位 PIN 只显示这一次。员工首次刷卡后系统会要求本人设置自己的 PIN，管理员不再知道。'
          : '临时密码 / PIN 只显示这一次，关闭后无法再查看（可重新“重置”）。员工首次登录（刷卡）时系统会要求本人修改，管理员不再知道。'}
      />
      {one ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {one.temp_password && (
            <div>
              <Typography.Text type="secondary">临时密码：</Typography.Text>
              <Typography.Text copyable={{ text: one.temp_password, tooltips: ['复制', '已复制'] }} className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: 1 }}>{one.temp_password}</Typography.Text>
            </div>
          )}
          {one.temp_pin && (
            <div>
              <Typography.Text type="secondary">工位 PIN（工牌 {one.badge_no}）：</Typography.Text>
              <Typography.Text copyable className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{one.temp_pin}</Typography.Text>
            </div>
          )}
        </Space>
      ) : (
        <Table
          rowKey="username"
          size="small"
          dataSource={list ?? []}
          pagination={(list?.length ?? 0) > 10 ? { pageSize: 10, size: 'small' } : false}
          columns={[
            { title: '账号', dataIndex: 'username', render: (v) => <b className="mono">{v}</b> },
            { title: '姓名', dataIndex: 'full_name' },
            { title: '角色', dataIndex: 'roles' },
            ...(pinOnly ? [] : [{ title: '临时密码', dataIndex: 'temp_password', render: (v: string) => (v ? <Typography.Text copyable className="mono">{v}</Typography.Text> : <Typography.Text type="secondary">金蝶账号/文件指定</Typography.Text>) }]),
            { title: '工牌 / PIN', key: 'pin', render: (_, r) => (r.badge_no ? <span className="mono">{r.badge_no}{r.temp_pin ? ` / ${r.temp_pin}` : ''}</span> : '-') },
          ]}
        />
      )}
    </Modal>
  );
}

function UserModal({ user, open, roles, policy, kingdee, departments, onClose, onDone }: {
  user: Rec | null; open: boolean; roles: RoleDef[]; policy?: PwdPolicy; kingdee: boolean; departments: string[];
  onClose: () => void; onDone: (saved: Rec, issued: IssuedPassword | null) => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const usernameRef = useRef<InputRef>(null);
  const fullNameRef = useRef<InputRef>(null);
  const { user: me } = useAuth();
  const source = Form.useWatch('auth_source', form) || 'LOCAL';
  const pwMode = Form.useWatch('pw_mode', form) || 'generate';
  const active = Form.useWatch('is_active', form);
  const isKingdee = source === 'KINGDEE';
  const deactivating = !!user && user.is_active && active === false;
  const needPassword = !isKingdee && (!user || user.auth_source === 'KINGDEE');

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(user
      ? {
          username: user.username, full_name: user.full_name, roles: user.role_list || [], department: user.department, email: user.email,
          is_active: user.is_active, auth_source: user.auth_source || 'LOCAL', badge_no: user.badge_no, pw_mode: 'keep', release_badge: true,
        }
      : { roles: [], is_active: true, auth_source: 'LOCAL', pw_mode: 'generate' });
  }, [open, user, form]);

  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const generate = !isKingdee && (v.pw_mode === 'generate' || v.pw_mode === 'reset');
    const body = {
      username: v.username, full_name: v.full_name, roles: v.roles || [], department: v.department || null, email: v.email || null,
      is_active: user ? !!v.is_active : true, auth_source: v.auth_source,
      password: !isKingdee && v.pw_mode === 'manual' ? v.password : null, generate_password: generate,
      badge_no: (v.badge_no || '').trim(), pin: v.pin || null, release_badge: deactivating ? !!v.release_badge : undefined,
      generate_pin: v.generate_pin && !v.pin ? true : undefined,
    };
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
      const saved: Rec = user ? await put(`/system/users/${user.id}`, body) : await post('/system/users', body);
      message.success(user ? `${saved.full_name} 已保存` : `用户 ${saved.username} 已创建`);
      onDone(saved, saved.temp_password || saved.temp_pin
        ? { username: saved.username, full_name: saved.full_name, temp_password: saved.temp_password, temp_pin: saved.temp_pin, badge_no: saved.badge_no }
        : null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={user ? `编辑用户 - ${user.full_name}（${user.username}）` : '新增用户'}
      width={720}
      style={{ top: 20 }}
      onCancel={onClose}
      onOk={submit}
      okText={user ? '保存' : '创建'}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      afterOpenChange={(o) => { if (o) (user ? fullNameRef : usernameRef).current?.focus(); }}
    >
      {user?.locked && (
        <Alert type="warning" showIcon icon={<LockOutlined />} style={{ marginBottom: 12 }} message={`该账号因密码/PIN 连续错误已锁定至 ${fmtDateTime(user.locked_until)}，保存即解锁（也可在列表中直接点“解锁”）。`} />
      )}
      <Form form={form} layout="vertical" size="middle">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="username" label={isKingdee ? '金蝶用户名' : '登录账号'} style={{ marginBottom: 12 }} rules={[{ required: true, message: '请输入账号' }, { pattern: /^[\w.\-一-龥]+$/, message: '仅限中文、字母、数字、下划线、点、横线' }]}>
              <Input ref={usernameRef} disabled={!!user} placeholder={isKingdee ? '与金蝶用户名一致' : '如 zhangsan'} autoComplete="off" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="full_name" label="姓名（电子签名显示）" style={{ marginBottom: 12 }} rules={[{ required: true, message: '请输入姓名' }]}>
              <Input ref={fullNameRef} placeholder="如 张三" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="roles" label="角色（可多选，权限 = 并集）" style={{ marginBottom: 12 }} rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一个角色' }]}>
              <Checkbox.Group style={{ width: '100%' }}>
                <Row gutter={[0, 4]}>
                  {roles.map((r) => (
                    <Col span={6} key={r.code}><Checkbox value={r.code}>{r.name}</Checkbox></Col>
                  ))}
                </Row>
              </Checkbox.Group>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="department" label="部门" style={{ marginBottom: 12 }}>
              <AutoComplete options={departments.map((d) => ({ value: d }))} placeholder="如 品质部" filterOption={(i, o) => String(o?.value ?? '').includes(i)} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="email" label="邮箱" style={{ marginBottom: 12 }} rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="badge_no" label="工牌号（工位刷卡，须有车间报工角色）" style={{ marginBottom: 12 }}>
              <Input prefix={<IdcardOutlined />} placeholder="如 E1001；清空即取消" autoComplete="off" maxLength={64} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="pin" label={user?.has_pin ? '重置工位 PIN（留空不改）' : '工位 PIN（4–8 位数字）'} style={{ marginBottom: 4 }} rules={[{ pattern: /^\d{4,8}$/, message: 'PIN 须为 4–8 位数字' }]}
              extra={<span style={{ fontSize: 12 }}>{user?.has_pin ? '' : '留空：填了工牌号时系统自动生成 4 位 PIN，保存后显示一次；'}本人首次刷卡后须改成自己的 PIN</span>}>
              <Input.Password inputMode="numeric" maxLength={8} autoComplete="new-password" placeholder={user?.has_pin ? '已设置' : '留空自动生成'} />
            </Form.Item>
            {user?.has_pin && user?.badge_no && (
              <Form.Item name="generate_pin" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Checkbox>由系统重新生成 PIN（保存后显示一次）</Checkbox>
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            <Form.Item name="auth_source" label="登录方式" style={{ marginBottom: 12 }}>
              <Radio.Group optionType="button" buttonStyle="solid" size="small">
                <Radio.Button value="LOCAL">本系统账号</Radio.Button>
                <Tooltip title={kingdee || user?.auth_source === 'KINGDEE' ? '使用金蝶云星空的账号密码登录，账号须与金蝶用户名一致' : '金蝶登录未启用：需在服务器配置 KINGDEE_ENABLED=1、KINGDEE_URL、KINGDEE_ACCT_ID 后重启'}>
                  <Radio.Button value="KINGDEE" disabled={!kingdee && user?.auth_source !== 'KINGDEE'}>金蝶云星空账号{!kingdee && '（未启用）'}</Radio.Button>
                </Tooltip>
              </Radio.Group>
            </Form.Item>
          </Col>
          {user && (
            <Col span={12}>
              <Space align="start" size={16}>
                <Form.Item name="is_active" label="账号状态" valuePropName="checked" style={{ marginBottom: 12 }}>
                  <Switch checkedChildren="启用" unCheckedChildren="停用" />
                </Form.Item>
                {deactivating && (
                  <Form.Item name="release_badge" valuePropName="checked" label=" " style={{ marginBottom: 12 }}>
                    <Checkbox>同时释放工牌、清除 PIN</Checkbox>
                  </Form.Item>
                )}
              </Space>
            </Col>
          )}
          {!isKingdee && (
            <Col span={24}>
              <Form.Item name="pw_mode" label={user && !needPassword ? '密码' : '初始密码'} style={{ marginBottom: 8 }}>
                <Radio.Group>
                  {user && !needPassword && <Radio value="keep">不修改</Radio>}
                  <Radio value={user && !needPassword ? 'reset' : 'generate'}>系统生成临时密码（推荐）</Radio>
                  <Radio value="manual">自己设置</Radio>
                </Radio.Group>
              </Form.Item>
              {pwMode === 'manual' && (
                <Form.Item
                  name="password"
                  style={{ marginBottom: 8 }}
                  rules={[
                    { required: true, message: '请输入密码' },
                    { min: policy?.min_length ?? 8, message: `密码至少 ${policy?.min_length ?? 8} 位` },
                    ...((policy?.require_letter_digit ?? true) ? [{ pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, message: '密码须同时包含字母和数字' }] : []),
                  ]}
                >
                  <Input.Password autoComplete="new-password" placeholder={policy?.text ?? '至少 8 位，且须同时包含字母和数字'} />
                </Form.Item>
              )}
              {pwMode !== 'keep' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <SafetyOutlined /> 管理员设置的密码，本人首次登录时须修改（电子签名密码仅本人知晓）。{pwMode !== 'manual' && '临时密码保存后显示一次。'}
                </Typography.Text>
              )}
            </Col>
          )}
        </Row>
      </Form>
    </Modal>
  );
}

/** 批量分配角色：追加 / 设为 / 移除 */
function RolePicker({ roles, onApply }: { roles: RoleDef[]; onApply: (mode: 'add_roles' | 'set_roles' | 'remove_roles', codes: string[]) => void }) {
  const [codes, setCodes] = useState<string[]>([]);
  const [mode, setMode] = useState<'add_roles' | 'set_roles' | 'remove_roles'>('add_roles');
  return (
    <Space direction="vertical" style={{ width: 420 }}>
      <Radio.Group size="small" value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" buttonStyle="solid"
        options={[{ value: 'add_roles', label: '追加角色' }, { value: 'set_roles', label: '设为（替换原角色）' }, { value: 'remove_roles', label: '移除角色' }]} />
      <Checkbox.Group value={codes} onChange={(v) => setCodes(v as string[])}>
        <Row gutter={[0, 4]}>{roles.map((r) => <Col span={8} key={r.code}><Checkbox value={r.code}>{r.name}</Checkbox></Col>)}</Row>
      </Checkbox.Group>
      <Button type="primary" size="small" disabled={!codes.length} onClick={() => onApply(mode, codes)}>应用到所选用户</Button>
    </Space>
  );
}

const STATUS_FILTERS: { value: string; label: string; key?: keyof Summary }[] = [
  { value: '', label: '全部' },
  { value: 'active', label: '启用', key: 'active' },
  { value: 'locked', label: '已锁定', key: 'locked' },
  { value: 'initial_password', label: '初始密码未改', key: 'initial_password' },
  { value: 'no_role', label: '待分配角色', key: 'no_role' },
  { value: 'inactive', label: '已停用', key: 'inactive' },
];

function UsersAdmin() {
  const [sp, setSp] = useSearchParams();
  const { user: me } = useAuth();
  const [roleData, setRoleData] = useState<{ roles: RoleDef[]; permissions: PermDef[] }>({ roles: [], permissions: [] });
  const [policy, setPolicy] = useState<PwdPolicy>();
  const [kingdee, setKingdee] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const init = { q: sp.get('q') || undefined, status: sp.get('status') || undefined, role: sp.get('role') || undefined, department: sp.get('department') || undefined };
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/system/users', init, 50);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [issued, setIssued] = useState<IssuedPassword[] | null>(null);
  const [importOpen, setImportOpen] = useState(sp.get('import') === '1');
  const [importBusy, setImportBusy] = useState<'check' | 'import' | null>(null);
  const [lastImport, setLastImport] = useState(lastImported);
  const [busy, setBusy] = useState(false);
  const [rolePop, setRolePop] = useState(false);
  const [q, setQ] = useState(init.q || '');

  const loadSummary = useCallback(() => {
    get<Summary>('/system/users/summary', undefined, true).then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    get('/system/roles').then(setRoleData);
    get('/auth/options', undefined, true).then((o) => { setPolicy(o.password_policy); setKingdee(!!o.kingdee_enabled); }).catch(() => undefined);
    loadSummary();
  }, [loadSummary]);

  const refresh = () => { reload(); loadSummary(); };
  const roleMap = useMemo(() => new Map(roleData.roles.map((r, i) => [r.code, { ...r, color: ROLE_COLORS[i % ROLE_COLORS.length] }])), [roleData]);
  const roleNames = (codes: string[] | undefined) => (codes || []).map((c) => roleMap.get(c)?.name || c).join('、');

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      message.success(ok);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const batch = async (action: string, extra: Rec = {}, okText = '已完成') => {
    // 勾选中包含自己：改密/重置会立即影响本人当前登录，二次确认
    if (['force_change', 'reset_password', 'reset_pin'].includes(action) && me && selected.includes(me.id)) {
      const ok = await new Promise<boolean>((resolve) => Modal.confirm({
        title: '勾选中包含您自己的账号',
        content: action === 'reset_pin'
          ? `将同时重置您自己（${me.username}）的工位 PIN。确定继续？`
          : `将同时${action === 'reset_password' ? '重置' : '要求修改'}您自己（${me.username}）的密码，您会被要求立即改密。建议取消勾选自己，之后在右上角“修改密码”单独修改。`,
        okText: '包括我自己，继续',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }));
      if (!ok) return;
      extra = { ...extra, confirm_self: true };
    }
    setBusy(true);
    try {
      const r = await post('/system/users/batch', { ids: selected, action, ...extra });
      message.success(`${okText}：${r.changed} 个账号${r.skipped?.length ? `（${r.skipped.length} 个无需处理）` : ''}`);
      if (r.passwords?.length) {
        const byId = new Map(rows.map((u) => [u.id, u]));
        setIssued(r.passwords.map((p: Rec) => ({ ...p, badge_no: p.badge_no ?? byId.get(p.id)?.badge_no, roles: roleNames(byId.get(p.id)?.role_list), department: byId.get(p.id)?.department })));
      }
      setSelected([]);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const resetPwd = async (r: Rec) => {
    const res = await post(`/system/users/${r.id}/reset-password`, {});
    setIssued([{ username: r.username, full_name: r.full_name, temp_password: res.temp_password }]);
    refresh();
  };
  const resetPin = async (r: Rec) => {
    const res = await post(`/system/users/${r.id}/reset-pin`, {});
    setIssued([{ username: r.username, full_name: r.full_name, temp_pin: res.temp_pin, badge_no: r.badge_no }]);
    refresh();
  };

  const statusCell = (r: Rec) => (
    <Space size={4} wrap={false}>
      {!r.is_active ? <Tag>已停用</Tag> : !(r.role_list || []).length ? <Tag color="orange">待分配角色</Tag> : <Tag color="green">启用</Tag>}
      {r.locked && (
        <Tooltip title={`密码/PIN 连续错误，锁定至 ${fmtDateTime(r.locked_until)}`}>
          <Tag color="red" icon={<LockOutlined />}>已锁定</Tag>
        </Tooltip>
      )}
      {r.is_active && r.demo_password && <Tooltip title="仍在使用公开的演示密码：上线前请“重置密码”（生成随机临时密码，当面发给本人）或“停用”"><Tag color="volcano" icon={<WarningOutlined />}>演示密码</Tag></Tooltip>}
      {r.is_active && !r.demo_password && r.initial_password && <Tooltip title="管理员设置的密码，本人首次登录时须修改"><Tag color="gold">初始密码未改</Tag></Tooltip>}
      {!r.locked && r.failed_login_count > 0 && <Tooltip title="连续登录失败次数（成功登录后清零）"><Tag color="volcano">失败 {r.failed_login_count} 次</Tag></Tooltip>}
    </Space>
  );

  const columns: TableColumnsType<Rec> = [
    { title: '账号', dataIndex: 'username', width: 120, fixed: 'left', sorter: true, render: (v) => <b className="mono">{v}</b> },
    { title: '姓名', dataIndex: 'full_name', width: 90, sorter: true },
    { title: '状态', key: 'state', width: 190, render: (_, r) => statusCell(r) },
    {
      title: '角色', dataIndex: 'role_list', width: 220,
      render: (v: string[] | undefined) => (
        <Space size={[4, 4]} wrap>
          {(v || []).map((c) => {
            const r = roleMap.get(c);
            return <Tag key={c} color={r?.color} style={{ marginInlineEnd: 0 }}>{r?.name || c}</Tag>;
          })}
        </Space>
      ),
    },
    { title: '部门', dataIndex: 'department', width: 90, sorter: true, render: (v) => v || '-' },
    {
      title: '工牌 / PIN', dataIndex: 'badge_no', width: 120,
      render: (v, r) => (v ? <Space size={4}><span className="mono">{v}</span>{r.has_pin ? <Tag color="green">PIN</Tag> : <Tag color="orange">无 PIN</Tag>}</Space> : '-'),
    },
    { title: '最近登录', dataIndex: 'last_login_at', width: 140, sorter: true, render: (v) => (v ? fmtDateTime(v) : <Typography.Text type="secondary">从未登录</Typography.Text>) },
    { title: '登录方式', dataIndex: 'auth_source', width: 96, render: (v) => (v === 'KINGDEE' ? <Tag color="blue">金蝶云星空</Tag> : <Tag>本系统</Tag>) },
    {
      title: '密码修改 / 到期', dataIndex: 'password_changed_at', width: 150,
      render: (v, r) => (r.auth_source === 'KINGDEE'
        ? <Typography.Text type="secondary">金蝶管理</Typography.Text>
        : <Tooltip title={r.password_expires_at ? `到期：${fmtDate(r.password_expires_at)}` : undefined}><span>{fmtDate(v) || '-'}</span></Tooltip>),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 140, sorter: true, render: (v) => fmtDateTime(v) },
    {
      title: '操作', key: '_op', width: 320, fixed: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => { setEditing(r); setOpen(true); }}>编辑</Button>
          {r.locked && <Button size="small" type="link" icon={<UnlockOutlined />} onClick={() => act(() => post(`/system/users/${r.id}/unlock`), `${r.full_name} 已解锁`)}>解锁</Button>}
          {r.auth_source !== 'KINGDEE' && r.is_active && (
            <Popconfirm title={`为 ${r.full_name} 生成临时密码？`} description="原密码立即失效（同时解锁）；本人首次登录须修改。" okText="生成" onConfirm={() => resetPwd(r)}>
              <Button size="small" type="link" icon={<KeyOutlined />}>重置密码</Button>
            </Popconfirm>
          )}
          {r.badge_no && r.is_active && (
            <Popconfirm title={`为 ${r.full_name} 重新生成工位 PIN？`} description="原 PIN 立即失效；本人首次刷卡后须改成自己的 PIN。" okText="生成" onConfirm={() => resetPin(r)}>
              <Button size="small" type="link" icon={<IdcardOutlined />}>重置 PIN</Button>
            </Popconfirm>
          )}
          {r.is_active ? (
            r.id !== me?.id && (
              <Popconfirm
                title={`停用 ${r.full_name}？`}
                description={r.badge_no || r.has_pin ? `同时释放工牌 ${r.badge_no || ''}、清除工位 PIN，工牌可分配给新人。` : '停用后不能登录；历史记录保留。'}
                okText="停用"
                okButtonProps={{ danger: true }}
                onConfirm={() => act(() => post(`/system/users/${r.id}/deactivate`, { release_badge: true }), `${r.full_name} 已停用`)}
              >
                <Button size="small" type="link" danger icon={<StopOutlined />}>停用</Button>
              </Popconfirm>
            )
          ) : (
            <Button size="small" type="link" onClick={() => act(() => post(`/system/users/${r.id}/activate`), `${r.full_name} 已启用`)}>启用</Button>
          )}
        </Space>
      ),
    },
  ];

  const matrixColumns: TableColumnsType<RoleDef> = [
    {
      title: '角色', key: 'role', fixed: 'left', width: 150,
      render: (_, r) => (
        <Space size={6}>
          <Tag color={roleMap.get(r.code)?.color} style={{ marginInlineEnd: 0 }}>{r.name}</Tag>
        </Space>
      ),
    },
    ...roleData.permissions.map((p) => ({
      title: <Tooltip title={p.name}><span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortPerm(p.code, p.name)}</span></Tooltip>,
      key: p.code,
      width: 66,
      align: 'center' as const,
      render: (_: unknown, r: RoleDef) => (r.perms.includes(p.code) ? <CheckOutlined style={{ color: '#389e0d', fontSize: 15 }} /> : <span style={{ color: '#e8e8e8' }}>—</span>),
    })),
    {
      title: '人数', key: 'cnt', width: 56, align: 'right',
      render: (_, r) => {
        const n = summary?.role_counts?.[r.code] ?? 0;
        return n ? <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setQuery({ role: r.code, status: 'active' })}>{n}</Button> : '-';
      },
    },
  ];

  const demo = summary?.demo_password ?? [];
  const selectedDemo = demo.filter((u) => selected.includes(u.id));
  const status = (query.status as string) || '';
  const changeStatus = (v: string) => {
    setQuery({ status: v || undefined });
    if (sp.get('status')) { sp.delete('status'); setSp(sp, { replace: true }); }
  };

  return (
    <>
      <PageHeader
        title="用户与角色"
        sub="按岗位分配角色；权限 = 角色权限的并集。离职人员请“停用”（自动释放工牌），不要删除——审计追踪需保留其历史操作。"
        extra={(
          <Space>
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => { setEditing(null); setOpen(true); }}>新增用户</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => setImportOpen(true)}>批量导入用户</Button>
            {lastImport && (
              <Tooltip title={`导入时间 ${lastImport.at}；仅保存在本页，刷新后清除`}>
                <Button icon={<KeyOutlined />} onClick={() => setIssued(lastImport.list)}>最近一次导入的密码清单（{lastImport.list.length} 人）</Button>
              </Tooltip>
            )}
          </Space>
        )}
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {demo.length > 0 && (
          <Alert
            type="error"
            showIcon
            icon={<WarningOutlined />}
            message={`有 ${demo.length} 个预置演示账号仍使用公开密码 ${summary?.demo_password_text ?? ''}（${demo.slice(0, 6).map((u) => u.username).join('、')}${demo.length > 6 ? ' 等' : ''}）`}
            description={(
              <>
                知道演示密码的人都能用这些账号登录、电子签名。上线前请勾选后点<b>“重置密码”</b>（生成随机临时密码，当面发给本人）或<b>“停用”</b>；
                不能用“要求下次登录改密”——任何知道演示密码的人都能抢先登录并改成自己的密码，冒用该账号的电子签名。全部处理后登录页的“演示账号”下拉自动隐藏。
                {demo.some((u) => u.id === me?.id) && <div style={{ marginTop: 4 }}>您自己的账号（{me?.username}）不会被勾选，请之后在右上角“修改密码”单独修改。</div>}
              </>
            )}
            action={(
              <Space direction="vertical">
                <Button size="small" onClick={() => { setSelected(demo.filter((u) => u.id !== me?.id).map((u) => u.id)); changeStatus('initial_password'); }}>勾选这些账号（不含自己）</Button>
              </Space>
            )}
          />
        )}
        {summary && summary.initial_password - demo.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`仍有 ${summary.initial_password - demo.length} 个账号使用管理员设置的初始密码（本人尚未登录改密）`}
            action={<Button size="small" onClick={() => changeStatus('initial_password')}>只看这些</Button>}
          />
        )}
        <Card styles={{ body: { paddingTop: 16 } }}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Radio.Group value={status} onChange={(e) => changeStatus(e.target.value)} optionType="button" size="middle">
              {STATUS_FILTERS.map((f) => {
                const n = f.key && summary ? (summary[f.key] as number) : null;
                const warn = (f.value === 'locked' || f.value === 'initial_password' || f.value === 'no_role') && n;
                return (
                  <Radio.Button key={f.value} value={f.value}>
                    {f.label}{n !== null && <Badge count={n} showZero={false} overflowCount={999} color={warn ? (f.value === 'locked' ? '#ff4d4f' : '#fa8c16') : '#bfbfbf'} style={{ marginLeft: 4, boxShadow: 'none' }} />}
                  </Radio.Button>
                );
              })}
            </Radio.Group>
            <Input.Search allowClear placeholder="账号 / 姓名 / 工牌 / 部门" style={{ width: 190 }} value={q} onChange={(e) => setQ(e.target.value)} onSearch={(v) => setQuery({ q: v.trim() || undefined })} />
            <Select allowClear placeholder="角色" style={{ width: 130 }} value={query.role} onChange={(v) => setQuery({ role: v })} options={roleData.roles.map((r) => ({ value: r.code, label: r.name }))} />
            <Select allowClear placeholder="部门" style={{ width: 110 }} value={query.department} onChange={(v) => setQuery({ department: v })}
              options={(summary?.departments ?? []).map((d) => ({ value: d.name, label: `${d.name}（${d.count}）` }))} />
            <Button icon={<ReloadOutlined />} onClick={refresh} />
            <ExportButton
              url="/system/users"
              params={query}
              filename="用户清单"
              columns={[
                { title: '账号', key: 'username' }, { title: '姓名', key: 'full_name' },
                { title: '状态', value: (r) => (!r.is_active ? '已停用' : r.locked ? '已锁定' : r.initial_password ? '初始密码未改' : '启用') },
                { title: '角色', value: (r) => roleNames(r.role_list) }, { title: '部门', key: 'department' }, { title: '工牌号', key: 'badge_no' },
                { title: '登录方式', value: (r) => (r.auth_source === 'KINGDEE' ? '金蝶云星空' : '本系统') },
                { title: '最近登录', key: 'last_login_at', type: 'datetime' }, { title: '创建时间', key: 'created_at', type: 'datetime' },
              ]}
            />
          </Space>
          {selected.length > 0 && (
            <Alert
              type="info"
              style={{ marginBottom: 12 }}
              message={(
                <Space wrap size={[8, 4]}>
                  <b>已选 {selected.length} 个账号：</b>
                  <Popover trigger="click" open={rolePop} onOpenChange={setRolePop} title="批量分配角色"
                    content={<RolePicker roles={roleData.roles} onApply={(mode, codes) => { setRolePop(false); void batch(mode, { roles: codes }, '角色已更新'); }} />}>
                    <Button size="small" loading={busy}>分配角色</Button>
                  </Popover>
                  <Popconfirm title={`停用所选 ${selected.length} 个账号？`} description="同时释放工牌、清除工位 PIN。" okText="停用" okButtonProps={{ danger: true }} onConfirm={() => batch('deactivate', { release_badge: true }, '已停用')}>
                    <Button size="small" danger>停用</Button>
                  </Popconfirm>
                  <Button size="small" onClick={() => batch('activate', {}, '已启用')}>启用</Button>
                  <Button size="small" onClick={() => batch('unlock', {}, '已解锁')}>解锁</Button>
                  {selectedDemo.length > 0 ? (
                    <Tooltip title={`所选中 ${selectedDemo.map((u) => u.username).join('、')} 仍在使用公开演示密码，“要求下次登录改密”会被知道演示密码的人抢先占用。请用“重置密码”或“停用”。`}>
                      <Button size="small" disabled>要求下次登录改密</Button>
                    </Tooltip>
                  ) : (
                    <Popconfirm title="要求所选账号下次登录时修改密码？" description="仅适用于密码只有本人知道的账号。" okText="确定" onConfirm={() => batch('force_change', {}, '已设置下次登录须改密')}>
                      <Button size="small">要求下次登录改密</Button>
                    </Popconfirm>
                  )}
                  <Popconfirm title={`为所选 ${selected.length} 个账号生成随机临时密码？`} description="原密码立即失效；生成后显示分发清单（只显示一次），本人首次登录须修改。" okText="生成" onConfirm={() => batch('reset_password', {}, '已重置密码')}>
                    <Button size="small" type={selectedDemo.length ? 'primary' : 'default'}>重置密码</Button>
                  </Popconfirm>
                  <Popconfirm title="为所选账号中有工牌的人重新生成工位 PIN？" description="原 PIN 立即失效；生成后显示 PIN 分发清单（只显示一次），本人首次刷卡后须改成自己的 PIN。" okText="生成" onConfirm={() => batch('reset_pin', {}, '已重置工位 PIN')}>
                    <Button size="small">重置工位 PIN</Button>
                  </Popconfirm>
                  <Button size="small" type="link" onClick={() => setSelected([])}>取消选择</Button>
                </Space>
              )}
            />
          )}
          <Table
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            loading={loading}
            pagination={pagination}
            onChange={onTableChange}
            scroll={{ x: 'max-content' }}
            rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]), preserveSelectedRowKeys: true, fixed: 'left', columnWidth: 40 }}
          />
        </Card>
        <Card title="角色权限矩阵" size="small">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="角色与权限由系统预置，符合职责分离原则：系统管理员只管账号、权限与审计，不含业务操作权限；质量签名（产品放行、NCR 处置、让步接收、CAPA 关闭、BOM/工艺批准）只能由 QA 角色完成，厂长也不能代签。如需调整请联系实施顾问。"
          />
          <Table rowKey="code" size="small" columns={matrixColumns} dataSource={roleData.roles} pagination={false} scroll={{ x: 'max-content' }} bordered />
        </Card>
      </Space>
      <UserModal
        user={editing}
        open={open}
        roles={roleData.roles}
        policy={policy}
        kingdee={kingdee}
        departments={(summary?.departments ?? []).map((d) => d.name)}
        onClose={() => setOpen(false)}
        onDone={(_, iss) => { setOpen(false); refresh(); if (iss?.temp_password || iss?.temp_pin) setIssued([iss]); }}
      />
      <IssuedModal list={issued} onClose={() => setIssued(null)} />
      <Modal
        open={importOpen}
        title="批量导入用户（Excel）"
        width={760}
        style={{ top: 24 }}
        footer={null}
        destroyOnHidden
        closable={importBusy !== 'import'}
        maskClosable={false}
        keyboard={importBusy !== 'import'}
        onCancel={() => { if (importBusy === 'import') return; setImportOpen(false); if (sp.get('import')) { sp.delete('import'); setSp(sp, { replace: true }); } }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="① 下载模板 → ② 每人一行填写账号、姓名、角色（中文名即可，多个用逗号）、部门、工牌号 → ③ 选择文件（自动预检查）→ ④ 确认导入 → ⑤ 下载初始密码分发清单。"
            description="初始密码留空由系统随机生成；有工牌号未填 PIN 时自动生成 4 位 PIN。所有人首次登录都须修改密码。任一行有错整个文件不导入。"
          />
          <Button icon={<FileExcelOutlined />} onClick={() => download('/import/templates/users', '用户账号导入模板.xlsx')}>① 下载用户导入模板</Button>
          <ImportFlow
            entity="users"
            title="用户"
            onBusyChange={setImportBusy}
            busyHint={<span>正在创建账号并生成初始密码（每人约 0.3–0.5 秒，40 人约 20 秒），<b>请勿关闭此窗口</b>；完成后自动弹出密码清单。</span>}
            onImported={(r: ImportResult) => {
              refresh();
              if (r.passwords?.length) {
                lastImported = { at: new Date().toLocaleString('zh-CN'), list: r.passwords as IssuedPassword[] };
                setLastImport(lastImported);
                setIssued(r.passwords as IssuedPassword[]);
              }
            }}
            renderSuccess={(r) => (
              <Button type="primary" icon={<KeyOutlined />} onClick={() => setIssued((r.passwords ?? []) as IssuedPassword[])}>查看 / 下载初始密码清单（{r.passwords?.length ?? 0} 人）</Button>
            )}
          />
        </Space>
      </Modal>
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
