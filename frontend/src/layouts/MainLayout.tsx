import { AutoComplete, Avatar, Badge, Button, Dropdown, Form, Input, Layout, Menu, Modal, Popover, List, Spin, Tag, Typography, message } from 'antd';
import { BellOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get, post, type Rec } from '../api/http';
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
  const [items, setItems] = useState<Rec[]>([]);
  const loc = useLocation();
  useEffect(() => {
    get('/todos', undefined, true).then(setItems).catch(() => undefined);
  }, [loc.pathname]);
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

function ChangePassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  return (
    <Modal open={open} title="修改密码" onCancel={onClose} destroyOnHidden onOk={async () => {
      const v = await form.validateFields();
      await post('/auth/change-password', v);
      message.success('密码已修改');
      onClose();
    }}>
      <Form form={form} layout="vertical">
        <Form.Item name="old_password" label="原密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
        <Form.Item name="new_password" label="新密码（至少 6 位）" rules={[{ required: true, min: 6 }]}><Input.Password /></Form.Item>
      </Form>
    </Modal>
  );
}

export default function MainLayout() {
  const { user, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(window.innerWidth < 1000);
  const [pwd, setPwd] = useState(false);

  const items = useMemo(() => {
    const conv = (m: MenuDef): any =>
      m.perm && !can(...m.perm)
        ? null
        : { key: m.key, icon: m.icon, label: m.label, children: m.children?.map(conv).filter(Boolean) };
    return menu.map(conv).filter(Boolean);
  }, [can]);

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
          <Todos />
          <Dropdown
            menu={{
              items: [
                { key: 'pwd', icon: <LockOutlined />, label: '修改密码', onClick: () => setPwd(true) },
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
          <Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>
      <ChangePassword open={pwd} onClose={() => setPwd(false)} />
    </Layout>
  );
}
