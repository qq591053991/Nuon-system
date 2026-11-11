import { Alert, AutoComplete, Avatar, Badge, Button, Dropdown, Form, Input, Layout, Menu, Modal, Popover, List, Result, Spin, Tag, Typography, message } from 'antd';
import { BellOutlined, ClockCircleOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post, TOKEN_KEY, type Rec } from '../api/http';
import { useAuth } from '../auth';
import { menu, type MenuDef } from '../routes';

const { Header, Sider, Content } = Layout;

function searchTarget(r: Rec): string {
  switch (r.type) {
    case 'material': return `/master/materials?q=${encodeURIComponent(r.title.split(' ')[0])}`;
    case 'serial': return `/trace?sn=${encodeURIComponent(r.title)}`;
    case 'work_order': return `/mes/work-orders/${r.id}`;
    case 'sales_order': return `/sales/orders/${r.id}`;
    case 'purchase_order': return `/purchase/orders/${r.id}`;
    case 'ncr': return `/quality/ncrs?q=${encodeURIComponent(r.title)}`;
    case 'inspection': return `/quality/inspections/${r.id}`;
    case 'shipment': return `/wms/shipments?q=${encodeURIComponent(r.title)}`;
    case 'lot': return `/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(r.title)}`;
    default: return '/';
  }
}

/** 全局搜索：单号 / 序列号 / 批号 / 物料，一个框搞定 */
function GlobalSearch() {
  const nav = useNavigate();
  const [opts, setOpts] = useState<any[]>([]);
  const [val, setVal] = useState('');
  const timer = useRef<any>();
  const onSearch = (q: string) => {
    setVal(q);
    clearTimeout(timer.current);
    if (!q.trim()) return setOpts([]);
    timer.current = setTimeout(async () => {
      const rows: Rec[] = await get('/search', { q }, true).catch(() => []);
      const groups: Record<string, Rec[]> = {};
      rows.forEach((r) => (groups[r.type_text] ||= []).push(r));
      setOpts(Object.entries(groups).map(([label, items]) => ({
        label,
        options: items.map((r) => ({
          value: searchTarget(r) + '#' + Math.random(),
          label: (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{r.title}</span>
              <Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>{r.sub}</Typography.Text>
            </div>
          ),
        })),
      })));
    }, 250);
  };
  return (
    <AutoComplete
      style={{ width: 360, maxWidth: '40vw' }}
      options={opts}
      value={val}
      onSearch={onSearch}
      onSelect={(v: string) => {
        setVal('');
        setOpts([]);
        nav(v.split('#')[0]);
      }}
    >
      <Input prefix={<SearchOutlined style={{ color: '#999' }} />} placeholder="搜索单号 / 序列号 / 批号 / 物料（支持扫码枪）" allowClear />
    </AutoComplete>
  );
}

function Todos() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const loc = useLocation();
  useEffect(() => {
    if (!user?.roles.length) return;
    get('/todos', undefined, true).then(setItems).catch(() => undefined);
  }, [loc.pathname, user]);
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <Popover
      placement="bottomRight"
      title="我的待办"
      trigger="click"
      content={
        <List
          style={{ width: 300 }}
          size="small"
          dataSource={items}
          locale={{ emptyText: '暂无待办，干得漂亮！' }}
          renderItem={(i) => (
            <List.Item style={{ cursor: 'pointer' }} onClick={() => nav(i.path)}>
              <span>{i.title}</span>
              <Tag color="red">{i.count}</Tag>
            </List.Item>
          )}
        />
      }
    >
      <Badge count={total} size="small">
        <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} />
      </Badge>
    </Popover>
  );
}

/** 登录选项：空闲超时（分钟）与密码策略（后端 /auth/options） */
interface AuthOptions {
  idle_minutes?: number;
  password_policy?: { min_length: number; require_letter_digit: boolean; max_age_days: number; text: string };
}

function useAuthOptions() {
  const [opts, setOpts] = useState<AuthOptions>({});
  useEffect(() => {
    get<AuthOptions>('/auth/options', undefined, true).then(setOpts).catch(() => undefined);
  }, []);
  return opts;
}

/** 修改密码；forced = 密码已过期，必须修改后才能继续使用（不可关闭，只能修改或退出） */
function ChangePassword({ open, forced, policy, onClose, onDone, onLogout }: {
  open: boolean;
  forced?: boolean;
  policy?: AuthOptions['password_policy'];
  onClose: () => void;
  onDone: () => void;
  onLogout: () => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const min = policy?.min_length ?? 8;
  const letterDigit = policy?.require_letter_digit ?? true;
  const hint = policy?.text ?? `至少 ${min} 位，且须同时包含字母和数字`;
  return (
    <Modal
      open={open}
      title={forced ? <span><LockOutlined style={{ color: '#fa8c16', marginRight: 8 }} />密码已过期，请修改密码</span> : '修改密码'}
      closable={!forced}
      maskClosable={false}
      keyboard={!forced}
      okText="确认修改"
      cancelText={forced ? '退出登录' : '取消'}
      confirmLoading={saving}
      onCancel={forced ? onLogout : onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields().catch(() => null);
        if (!v) return;
        setSaving(true);
        try {
          await post('/auth/change-password', { old_password: v.old_password, new_password: v.new_password });
          message.success('密码已修改');
          onDone();
        } finally {
          setSaving(false);
        }
      }}
    >
      {forced && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`根据账号安全策略，密码每 ${policy?.max_age_days ?? 90} 天须更换一次。修改密码后才能继续使用系统。`}
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item
          name="new_password"
          label="新密码"
          extra={hint}
          rules={[
            { required: true, message: '请输入新密码' },
            { min, message: `至少 ${min} 位` },
            ...(letterDigit ? [{ pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, message: '须同时包含字母和数字' }] : []),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="再次输入新密码"
          dependencies={['new_password']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator: (_, v) => (!v || v === getFieldValue('new_password') ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致'))),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const ACTIVITY_KEY = 'nuon_last_activity';
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const WARN_SECONDS = 60;

/**
 * 空闲超时：minutes 分钟无键盘/鼠标/触摸操作自动退出登录，退出前 60 秒弹窗提醒。
 * 多个标签页共享最近操作时间（localStorage），任一标签页有操作即视为在用。
 */
function IdleLogout({ minutes, paused, onTimeout }: { minutes: number; paused?: boolean; onTimeout: () => void }) {
  const [left, setLeft] = useState<number | null>(null);
  const last = useRef(Date.now());
  const warning = useRef(false);

  const touch = useCallback(() => {
    last.current = Date.now();
    try {
      localStorage.setItem(ACTIVITY_KEY, String(last.current));
    } catch {
      /* 存储不可用时仅本页计时 */
    }
  }, []);

  useEffect(() => {
    if (!(minutes > 0) || paused) return;
    const limit = minutes * 60_000;
    const onActivity = () => {
      if (!warning.current && Date.now() - last.current > 1000) touch();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { capture: true, passive: true }));
    touch();
    const timer = setInterval(() => {
      try {
        const shared = Number(localStorage.getItem(ACTIVITY_KEY));
        if (shared > last.current) last.current = shared; // 其他标签页有操作
      } catch {
        /* ignore */
      }
      const idle = Date.now() - last.current;
      if (idle >= limit) {
        clearInterval(timer);
        onTimeout();
      } else if (idle >= limit - WARN_SECONDS * 1000) {
        warning.current = true;
        setLeft(Math.ceil((limit - idle) / 1000));
      } else if (warning.current) {
        warning.current = false;
        setLeft(null);
      }
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
      clearInterval(timer);
      warning.current = false;
      setLeft(null);
    };
  }, [minutes, paused, onTimeout, touch]);

  return (
    <Modal
      open={left !== null}
      title={<span><ClockCircleOutlined style={{ color: '#fa8c16', marginRight: 8 }} />长时间未操作</span>}
      closable={false}
      maskClosable={false}
      keyboard={false}
      okText="继续使用"
      cancelText="立即退出"
      onOk={() => {
        warning.current = false;
        touch();
        setLeft(null);
      }}
      onCancel={onTimeout}
    >
      <Typography.Paragraph>
        您已约 {minutes} 分钟没有操作。为保护数据安全，系统将在 <b style={{ color: '#cf1322', fontSize: 16 }}>{left}</b> 秒后自动退出登录。
      </Typography.Paragraph>
      <Typography.Text type="secondary">未保存的内容可能丢失，如仍在使用请点击“继续使用”。</Typography.Text>
    </Modal>
  );
}

export default function MainLayout() {
  const { user, logout, can, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(window.innerWidth < 1000);
  const [pwd, setPwd] = useState(false);
  const options = useAuthOptions();
  const mustChange = !!user?.must_change_password;

  // 空闲超时退出：工位终端页面有自己的（更短的）锁屏，不在此处退出
  const onIdle = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    location.href = `/login?idle=1&redirect=${encodeURIComponent(location.pathname + location.search)}`;
  }, []);

  const { user: me } = useAuth();
  const noRole = !me?.roles.length;
  const items = useMemo(() => {
    if (noRole) return [{ key: '/', icon: menu[0].icon, label: menu[0].label }];
    const conv = (m: MenuDef): any =>
      m.perm && !can(...m.perm)
        ? null
        : { key: m.key, icon: m.icon, label: m.label, children: m.children?.map(conv).filter(Boolean) };
    return menu.map(conv).filter(Boolean);
  }, [can, noRole]);

  // 当前路由对应的菜单项（详情页高亮其列表菜单）
  const selected = useMemo(() => {
    const all: string[] = [];
    const walk = (ms: MenuDef[]) => ms.forEach((m) => (m.children ? walk(m.children) : all.push(m.key)));
    walk(menu);
    const p = loc.pathname;
    return all.filter((k) => k === p || (k !== '/' && p.startsWith(k + '/'))).sort((a, b) => b.length - a.length).slice(0, 1);
  }, [loc.pathname]);
  const openKeys = useMemo(() => menu.filter((m) => m.children?.some((c) => selected.includes(c.key))).map((m) => m.key), [selected]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} trigger={null} width={224} theme="dark" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto' }}>
        <div className="brand" onClick={() => nav('/')}>
          <img src="/logo.svg" alt="" />
          {!collapsed && <div><div className="brand-title">Nuon 智造云</div><div className="brand-sub">光疗器械代工一体化平台</div></div>}
        </div>
        <Menu theme="dark" mode="inline" items={items} selectedKeys={selected} defaultOpenKeys={collapsed ? [] : openKeys} key={openKeys.join()} onClick={(e) => nav(e.key)} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
          <GlobalSearch />
          <div style={{ flex: 1 }} />
          {!mustChange && <Todos />}
          <Dropdown
            menu={{
              items: [
                me?.auth_source === 'KINGDEE'
                  ? { key: 'pwd', icon: <LockOutlined />, label: '修改密码（请在金蝶云星空中修改）', disabled: true }
                  : { key: 'pwd', icon: <LockOutlined />, label: '修改密码', onClick: () => setPwd(true) },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout },
              ],
            }}
          >
            <div className="user-chip">
              <Avatar size="small" icon={<UserOutlined />} style={{ background: '#722ed1' }} />
              <span>{user?.full_name}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{user?.role_names.join('/')}</Typography.Text>
            </div>
          </Dropdown>
        </Header>
        <Content className="app-content">
          {mustChange ? (
            <Result status="warning" title="密码已过期" subTitle="根据账号安全策略，请先修改密码后再继续使用系统。"
              extra={<Button type="primary" onClick={() => setPwd(true)}>修改密码</Button>} />
          ) : (
            <Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
              <Outlet />
            </Suspense>
          )}
        </Content>
      </Layout>
      <ChangePassword
        open={pwd || mustChange}
        forced={mustChange}
        policy={options.password_policy}
        onClose={() => setPwd(false)}
        onLogout={logout}
        onDone={() => {
          setPwd(false);
          if (mustChange) refresh();
        }}
      />
      <IdleLogout minutes={options.idle_minutes ?? 0} paused={loc.pathname.startsWith('/mes/station')} onTimeout={onIdle} />
    </Layout>
  );
}
