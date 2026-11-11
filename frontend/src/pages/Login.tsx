import { Button, Card, Form, Input, Typography, Select } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';

const DEMO = [
  ['admin', '系统管理员'], ['manager', '厂长'], ['sales', '销售'], ['buyer', '采购'], ['pmc', 'PMC计划'], ['engineer', '工艺工程师'],
  ['wh', '仓管员'], ['op1', '产线操作员'], ['qc', '质检员'], ['qa', 'QA质量工程师'], ['finance', '财务'],
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
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
      <Card className="login-card" bordered={false}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>登录</Typography.Title>
        <Form form={form} size="large" initialValues={{ username: 'admin' }} onFinish={async (v) => {
          setLoading(true);
          try {
            await login(v.username, v.password);
            nav(sp.get('redirect') || '/', { replace: true });
          } finally {
            setLoading(false);
          }
        }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>登 录</Button>
        </Form>
        <div style={{ marginTop: 24 }}>
          <Typography.Text type="secondary">演示账号（密码均为 Nuon@2026）：</Typography.Text>
          <Select style={{ width: '100%', marginTop: 8 }} placeholder="快速选择演示角色" options={DEMO.map(([u, n]) => ({ value: u, label: `${n}（${u}）` }))}
            onChange={(u) => form.setFieldsValue({ username: u, password: 'Nuon@2026' })} />
        </div>
      </Card>
    </div>
  );
}
