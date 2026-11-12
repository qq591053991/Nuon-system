import { Alert, Avatar, Badge, Button, ConfigProvider, Drawer, Dropdown, Empty, Form, Input, Layout, List, Menu, Modal, Popover, Result, Spin, Tag, Typography, message } from 'antd';
import {
  BellOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuOutlined, MenuUnfoldOutlined, RightOutlined, SafetyOutlined, UserOutlined,
} from '@ant-design/icons';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post, type Rec } from '../api/http';
import { clearLoginPassword, passwordDaysLeft, peekLoginPassword, useAuth } from '../auth';
import { useNarrow } from '../components/ResponsiveTable';
import GlobalSearch from '../pages/workbench/GlobalSearch';
import IdleLock from '../pages/workbench/IdleLock';
import { useGo } from '../pages/workbench/links';
import '../pages/workbench/shell.css';
import { menu, type MenuDef } from '../routes';

const { Header, Sider, Content } = Layout;

/** 窄屏（手机/PDA）断点：< 768 侧栏改抽屉、顶栏精简、控件加大 */
const NARROW = 768;

/** 我的待办（按岗位，点进去带筛选）；窄屏用底部抽屉，不会被裁掉 */
function Todos({ narrow }: { narrow: boolean }) {
  const go = useGo();
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    if (!user?.roles.length) return;
    get('/todos', undefined, true).then(setItems).catch(() => undefined);
  }, [loc.pathname, user]);
  const total = items.reduce((s, i) => s + i.count, 0);
  const list = (
    <List
      style={{ width: narrow ? '100%' : 340 }}
      size={narrow ? 'large' : 'small'}
      dataSource={items}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办，干得漂亮！" /> }}
      renderItem={(i) => (
        <List.Item
          className="todo-item"
          onClick={() => {
            setOpen(false);
            go(i.path);
          }}
        >
          <span style={{ flex: 1 }}>{i.title}</span>
          <Tag color={i.level === 'error' ? 'red' : i.level === 'warning' ? 'orange' : 'blue'} style={{ minWidth: 32, textAlign: 'center' }}>{i.count}</Tag>
          <RightOutlined style={{ color: '#bbb', fontSize: 12 }} />
        </List.Item>
      )}
    />
  );
  const bell = (
    <Badge count={total} size="small" offset={[-6, 6]}>
      <Button type="text" aria-label="我的待办" className="hdr-btn" icon={<BellOutlined style={{ fontSize: 20 }} />} onClick={() => narrow && setOpen(true)} />
    </Badge>
  );
  if (narrow) {
    return (
      <>
        {bell}
        <Drawer title={`我的待办（${total}）`} placement="bottom" height="72%" open={open} onClose={() => setOpen(false)} styles={{ body: { padding: 0 } }}>
          {list}
        </Drawer>
      </>
    );
  }
  return (
    <Popover placement="bottomRight" title="我的待办" trigger="click" open={open} onOpenChange={setOpen} content={list}>
      {bell}
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

/**
 * 修改密码；forced = 必须修改后才能继续使用（不可关闭，只能修改或退出）。
 * 刚登录就被要求改密时，原密码已在登录时验证过，不再让用户输第二遍。
 */
function ChangePassword({ open, forced, reason, policy, onClose, onDone, onLogout }: {
  open: boolean;
  forced?: boolean;
  reason?: 'INITIAL' | 'EXPIRED' | null;
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
  const known = forced ? peekLoginPassword() : null;
  const initial = reason === 'INITIAL';
  return (
    <Modal
      open={open}
      title={forced
        ? <span><LockOutlined style={{ color: '#fa8c16', marginRight: 8 }} />{initial ? '首次登录，请设置您自己的密码' : '密码已过期，请修改密码'}</span>
        : '修改密码'}
      closable={!forced}
      maskClosable={false}
      keyboard={!forced}
      okText="确认修改"
      cancelText={forced ? '退出登录' : '取消'}
      confirmLoading={saving}
      onCancel={forced ? onLogout : onClose}
      destroyOnHidden
      onOk={() => form.submit()}
    >
      {forced && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={initial
            ? '您当前使用的是管理员设置的初始密码。为保证电子签名“仅本人知晓”，请先设置只有您自己知道的新密码。'
            : `根据账号安全策略，密码每 ${policy?.max_age_days ?? 90} 天须更换一次。修改密码后才能继续使用系统。`}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={async (v) => {
          setSaving(true);
          try {
            await post('/auth/change-password', { old_password: known ?? v.old_password, new_password: v.new_password });
            clearLoginPassword();
            message.success('密码已修改');
            onDone();
          } finally {
            setSaving(false);
          }
        }}
      >
        {known ? (
          <Typography.Paragraph type="secondary">原密码：已在登录时验证，无需再次输入。</Typography.Paragraph>
        ) : (
          <Form.Item name="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}><Input.Password autoComplete="current-password" autoFocus /></Form.Item>
        )}
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
          <Input.Password autoComplete="new-password" autoFocus={!!known} />
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
          <Input.Password autoComplete="new-password" onPressEnter={() => form.submit()} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 本机空闲锁屏时间（分钟，只能比系统策略更短；公用电脑可单独设短） */
const DEVICE_IDLE_KEY = 'nuon_device_idle_minutes';

const readDeviceIdle = () => {
  try {
    return Number(localStorage.getItem(DEVICE_IDLE_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** 密码到期前 7 天提醒（每天提醒一次，可关闭） */
function PasswordExpiryBanner({ onChange }: { onChange: () => void }) {
  const { user } = useAuth();
  const days = passwordDaysLeft(user);
  const key = `nuon_pwd_tip_${user?.username}_${new Date().toISOString().slice(0, 10)}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (days === null || days > 7 || days <= 0 || hidden || user?.must_change_password) return null;
  return (
    <Alert
      className="no-print"
      type="warning"
      showIcon
      closable
      style={{ marginBottom: 12 }}
      message={`您的登录密码将在 ${days} 天后（${user!.password_expires_at!.slice(0, 10)}）到期，到期后须先改密才能使用。`}
      action={<Button size="small" type="primary" onClick={onChange}>现在修改</Button>}
      onClose={() => {
        setHidden(true);
        try {
          localStorage.setItem(key, '1');
        } catch {
          /* ignore */
        }
      }}
    />
  );
}

/** 按权限裁剪菜单：分组上的 perm 作为子项默认值；子项全部无权时整组隐藏 */
function useMenuItems(can: (...p: string[]) => boolean, noRole: boolean) {
  return useMemo(() => {
    if (noRole) return [{ key: '/', icon: menu[0].icon, label: menu[0].label }];
    const conv = (m: MenuDef, parentPerm?: string[]): any => {
      const perm = m.perm ?? parentPerm;
      if (m.children) {
        const children = m.children.map((c) => conv(c, perm)).filter(Boolean);
        return children.length ? { key: m.key, icon: m.icon, label: m.label, children } : null;
      }
      return perm && !can(...perm) ? null : { key: m.key, icon: m.icon, label: m.label };
    };
    return menu.map((m) => conv(m)).filter(Boolean);
  }, [can, noRole]);
}

export default function MainLayout() {
  const loc = useLocation();
  // 工位终端：全屏工位模式，不渲染外壳（侧栏/顶栏/全局搜索），由工位页自己管理锁屏与登录
  if (loc.pathname === '/mes/station' || loc.pathname.startsWith('/mes/station/')) {
    return (
      <Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
        <Outlet />
      </Suspense>
    );
  }
  return <Shell />;
}

function Shell() {
  const { user, logout, can, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const narrow = useNarrow(NARROW);
  const [collapsed, setCollapsed] = useState(window.innerWidth < 1000);
  const [drawer, setDrawer] = useState(false);
  const [pwd, setPwd] = useState(false);
  const [deviceIdle, setDeviceIdle] = useState(readDeviceIdle);
  const options = useAuthOptions();
  const mustChange = !!user?.must_change_password;
  const noRole = !user?.roles.length;
  const items = useMenuItems(can, noRole);

  const sysIdle = options.idle_minutes ?? 0;
  const idleMinutes = deviceIdle > 0 && (sysIdle <= 0 || deviceIdle < sysIdle) ? deviceIdle : sysIdle;

  // 当前路由对应的菜单项（详情页高亮其列表菜单；带参数的菜单项如 /finance?tab=AP 按参数匹配）
  const selected = useMemo(() => {
    const all: string[] = [];
    const walk = (ms: MenuDef[]) => ms.forEach((m) => (m.children ? walk(m.children) : all.push(m.key)));
    walk(menu);
    const p = loc.pathname;
    const have = new URLSearchParams(loc.search);
    const score = (k: string) => {
      const [kp, kq] = k.split('?');
      if (kq !== undefined) {
        if (kp !== p) return -1;
        for (const [a, b] of new URLSearchParams(kq)) if (have.get(a) !== b) return -1;
        return 3000 + k.length;
      }
      if (k === p) return 2000 + k.length;
      return k !== '/' && p.startsWith(k + '/') ? k.length : -1;
    };
    const best = all.map((k) => [k, score(k)] as const).filter(([, v]) => v >= 0).sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? all.find((k) => k.split('?')[0] === p);
    return best ? [best] : [];
  }, [loc.pathname, loc.search]);
  const openKeys = useMemo(() => menu.filter((m) => m.children?.some((c) => selected.includes(c.key))).map((m) => m.key), [selected]);

  // 从待办/KPI/搜索跳转（state.wb）时重新挂载页面，使列表页按新的 URL 参数重新筛选；页面自己改 URL（无 wb）时不重挂
  const wbKey = useRef('');
  const wb = (loc.state as { wb?: number } | null)?.wb;
  if (wb && String(wb) !== wbKey.current) wbKey.current = String(wb);

  // 窄屏切换路由后自动收起抽屉
  useEffect(() => setDrawer(false), [loc.pathname, loc.search]);

  const idleItems = [0, 5, 10, 15].filter((m) => m === 0 || sysIdle <= 0 || m < sysIdle).map((m) => ({
    key: `idle-${m}`,
    label: m === 0 ? `按系统策略（${sysIdle > 0 ? `${sysIdle} 分钟` : '不自动锁屏'}）` : `${m} 分钟`,
    onClick: () => {
      try {
        if (m) localStorage.setItem(DEVICE_IDLE_KEY, String(m));
        else localStorage.removeItem(DEVICE_IDLE_KEY);
      } catch {
        /* ignore */
      }
      setDeviceIdle(m);
      message.success(m ? `本机无操作 ${m} 分钟自动锁屏` : '本机按系统策略自动锁屏');
    },
  }));

  const userMenu = {
    items: [
      ...(narrow ? [{ key: 'who', disabled: true, label: <div><b>{user?.full_name}</b><div style={{ fontSize: 12, color: '#888' }}>{user?.role_names.join(' / ')}</div></div> }, { type: 'divider' as const }] : []),
      user?.auth_source === 'KINGDEE'
        ? { key: 'pwd', icon: <LockOutlined />, label: '修改密码（请在金蝶云星空中修改）', disabled: true }
        : { key: 'pwd', icon: <LockOutlined />, label: '修改密码', onClick: () => setPwd(true) },
      { key: 'idle', icon: <SafetyOutlined />, label: `本机自动锁屏：${idleMinutes > 0 ? `${idleMinutes} 分钟` : '不启用'}`, children: idleItems },
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout },
    ],
  };

  const brand = (full: boolean) => (
    <div className="brand" onClick={() => nav('/')}>
      <img src="/logo.svg" alt="" />
      {full && <div><div className="brand-title">Nuon 智造云</div><div className="brand-sub">光疗器械代工一体化平台</div></div>}
    </div>
  );
  const sideMenu = (
    <Menu
      theme="dark"
      mode="inline"
      items={mustChange ? [] : items}
      selectedKeys={selected}
      defaultOpenKeys={collapsed && !narrow ? [] : openKeys}
      key={openKeys.join()}
      onClick={(e) => {
        setDrawer(false);
        // 点菜单总是打开一个“干净”的页面（即使当前就在该页、带着筛选）
        nav(e.key, { state: { wb: Date.now() } });
      }}
    />
  );

  return (
    <Layout className={narrow ? 'shell shell-narrow' : 'shell'} style={{ minHeight: '100vh' }}>
      {!narrow && (
        <Sider collapsible collapsed={collapsed} trigger={null} width={224} theme="dark" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto' }}>
          {brand(!collapsed)}
          {sideMenu}
        </Sider>
      )}
      {narrow && (
        <Drawer
          className="nav-drawer"
          placement="left"
          width={272}
          open={drawer}
          onClose={() => setDrawer(false)}
          closable={false}
          styles={{ body: { padding: 0, background: '#1d1537' }, header: { display: 'none' } }}
        >
          {brand(true)}
          {sideMenu}
        </Drawer>
      )}
      <Layout style={{ minWidth: 0 }}>
        <Header className="app-header">
          {narrow ? (
            <Button type="text" aria-label="菜单" className="hdr-btn" icon={<MenuOutlined style={{ fontSize: 20 }} />} onClick={() => setDrawer(true)} disabled={mustChange} />
          ) : (
            <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
          )}
          {!mustChange && !noRole && <GlobalSearch narrow={narrow} />}
          {!narrow && <div style={{ flex: 1 }} />}
          {(mustChange || noRole) && narrow && <div style={{ flex: 1 }} />}
          {!mustChange && <Todos narrow={narrow} />}
          <Dropdown menu={userMenu} trigger={narrow ? ['click'] : ['hover']}>
            {narrow ? (
              <Button type="text" aria-label="我的账号" className="hdr-btn" icon={<Avatar size={30} icon={<UserOutlined />} style={{ background: '#722ed1' }} />} />
            ) : (
              <div className="user-chip">
                <Avatar size="small" icon={<UserOutlined />} style={{ background: '#722ed1' }} />
                <span className="user-chip-name">{user?.full_name}</span>
                <Typography.Text type="secondary" className="user-chip-role">{user?.role_names.join('/')}</Typography.Text>
              </div>
            )}
          </Dropdown>
        </Header>
        <Content className="app-content">
          <ConfigProvider componentSize={narrow ? 'large' : undefined}>
            {mustChange ? (
              <Result
                status="warning"
                title={user?.password_change_reason === 'INITIAL' ? '请先设置您自己的密码' : '密码已过期'}
                subTitle={user?.password_change_reason === 'INITIAL'
                  ? '您使用的是管理员设置的初始密码，修改密码后才能使用系统。'
                  : '根据账号安全策略，请先修改密码后再继续使用系统。'}
                extra={<Button type="primary" onClick={() => setPwd(true)}>修改密码</Button>}
              />
            ) : (
              <>
                <PasswordExpiryBanner onChange={() => setPwd(true)} />
                <Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
                  <div key={wbKey.current} className="route-wrap">
                    <Outlet />
                  </div>
                </Suspense>
              </>
            )}
          </ConfigProvider>
        </Content>
      </Layout>
      <ChangePassword
        open={pwd || mustChange}
        forced={mustChange}
        reason={user?.password_change_reason}
        policy={options.password_policy}
        onClose={() => setPwd(false)}
        onLogout={logout}
        onDone={() => {
          setPwd(false);
          refresh();
        }}
      />
      <IdleLock minutes={idleMinutes} />
    </Layout>
  );
}
