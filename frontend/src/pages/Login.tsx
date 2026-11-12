import { Alert, Button, Card, Form, Input, Segmented, Select, Tooltip, Typography, message, type InputRef } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { get } from '../api/http';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LAST_USER_KEY, passwordDaysLeft, useAuth } from '../auth';
import './workbench/shell.css';

interface LoginOptions {
  /** 演示模式（G2：DEMO_MODE 或仍有使用公开演示密码的预置账号）；未提供时按 false 处理 */
  demo?: boolean;
  demo_accounts?: { username: string; full_name: string; role_names: string[] }[];
  demo_password?: string | null;
  kingdee_enabled?: boolean;
  kingdee_name?: string;
}

const readLastUser = () => {
  try {
    return localStorage.getItem(LAST_USER_KEY) || '';
  } catch {
    return '';
  }
};

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const [opts, setOpts] = useState<LoginOptions>({});
  const [source, setSource] = useState<'LOCAL' | 'KINGDEE'>('LOCAL');
  const lastUser = useRef(readLastUser());
  const userRef = useRef<InputRef>(null);
  const pwdRef = useRef<InputRef>(null);
  const kingdee = !!opts.kingdee_enabled;
  const kdName = opts.kingdee_name || '金蝶云星空';

  useEffect(() => {
    get<LoginOptions>('/auth/options', undefined, true).then(setOpts).catch(() => undefined);
    // 记住了上次的账号：光标直接放在密码框
    setTimeout(() => (lastUser.current ? pwdRef.current : userRef.current)?.focus(), 50);
  }, []);

  const demoOptions = (opts.demo_accounts ?? []).map((a) => ({ value: a.username, label: `${a.role_names.join('/') || a.full_name}（${a.username}）` }));

  return (
    <div className="login-bg">
      <div className="login-hero">
        <img src="/logo.svg" alt="" width={56} />
        <h1>Nuon 智造云</h1>
        <p>光疗医疗器械代工（OEM/ODM）一体化平台</p>
        <ul>
          <li>ERP · MES · WMS · QMS 一套系统，一份数据</li>
          <li>符合 GMP / ISO 13485：电子签名、审计追踪、DHR、UDI</li>
          <li>扫码作业，从来料到出货一键追溯</li>
        </ul>
      </div>
      <Card className="login-card" variant="borderless">
        <Typography.Title level={3} style={{ marginTop: 0 }}>登录 Nuon 智造云</Typography.Title>
        {sp.get('idle') === '1' && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="由于长时间未操作，系统已自动退出登录，请重新登录。" />
        )}
        <Segmented
          block
          style={{ marginBottom: 16 }}
          value={source}
          onChange={(v) => setSource(v as 'LOCAL' | 'KINGDEE')}
          options={[
            { value: 'LOCAL', label: '本系统账号' },
            {
              value: 'KINGDEE',
              disabled: !kingdee,
              label: kingdee ? `${kdName}账号` : (
                <Tooltip title={`${kdName}登录未启用：需管理员在服务器上配置金蝶地址与数据中心并开启（KINGDEE_ENABLED=1）后才能使用`}>
                  <span>金蝶账号</span>
                </Tooltip>
              ),
            },
          ]}
        />
        {source === 'KINGDEE' && (
          <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`使用您在${kdName}的用户名和密码登录`} description="首次登录会自动开通本系统账号，需管理员分配岗位后才能使用业务功能。" />
        )}
        {!kingdee && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8 }}>
            {kdName}账号登录未启用，请使用本系统账号；如需开通请联系系统管理员。
          </Typography.Paragraph>
        )}
        <Form form={form} size="large" initialValues={{ username: lastUser.current }} onFinish={async (v) => {
          setLoading(true);
          try {
            const u = await login(v.username, v.password);
            if (u.must_change_password) {
              message.warning(u.password_change_reason === 'INITIAL' ? '首次登录，请先设置您自己的密码' : '您的密码已过期，请先修改密码');
              nav('/', { replace: true });
              return;
            }
            const days = passwordDaysLeft(u);
            if (days !== null && days <= 7) message.warning(`您的密码将在 ${days} 天后到期，请尽快修改`);
            nav(sp.get('redirect') || '/', { replace: true });
          } finally {
            setLoading(false);
          }
        }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input ref={userRef} prefix={<UserOutlined />} placeholder={source === 'KINGDEE' ? `用户名（${kdName}）` : '用户名'} autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password ref={pwdRef} prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>登 录</Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          忘记密码或账号被锁定？请联系系统管理员重置/解锁。
        </Typography.Paragraph>
        {opts.demo === true && (
          <div style={{ marginTop: 20 }}>
            <Typography.Text type="secondary">演示账号{opts.demo_password ? `（密码均为 ${opts.demo_password}）` : ''}：</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="快速选择演示角色"
              options={demoOptions}
              onChange={(u) => {
                form.setFieldsValue({ username: u, password: opts.demo_password ?? undefined });
                pwdRef.current?.focus();
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
