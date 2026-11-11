import { Alert, Form, Input, Modal, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../auth';

export interface Signature { password: string; reason?: string }
interface Opts {
  meaning: string;
  description?: string;
  reasonRequired?: boolean;
  defaultReason?: string;
  /** 理由输入框的标题与提示（如驳回时为“驳回原因”） */
  reasonLabel?: string;
  reasonPlaceholder?: string;
}

/**
 * 电子签名（21 CFR Part 11 / GMP）：关键操作需再次输入本人密码并声明签名含义。
 *
 *   const [sign, signHolder] = useESign();
 *   const signature = await sign({ meaning: '产品放行（DHR审核批准）' }); // 用户取消时抛出异常
 *   await post(url, { ..., signature });
 *   return <>{signHolder}...</>
 */
export function useESign(): [(o: Opts) => Promise<Signature>, JSX.Element] {
  const { user } = useAuth();
  const [opts, setOpts] = useState<Opts | null>(null);
  const [seq, setSeq] = useState(0);
  const [form] = Form.useForm();
  const resolver = useRef<{ resolve: (s: Signature) => void; reject: (e: any) => void } | null>(null);

  const sign = useCallback(
    (o: Opts) =>
      new Promise<Signature>((resolve, reject) => {
        resolver.current = { resolve, reject };
        // 每次签名都重新挂载一张空白表单（不保留上次输入的密码；默认理由见 initialValues）
        setSeq((n) => n + 1);
        setOpts(o);
      }),
    [],
  );

  const holder = (
    <Modal
      open={!!opts}
      title={<span><SafetyCertificateOutlined style={{ color: '#722ed1', marginRight: 8 }} />电子签名确认</span>}
      okText="签名并提交"
      cancelText="取消"
      destroyOnHidden
      onCancel={() => {
        setOpts(null);
        resolver.current?.reject(new Error('cancelled'));
      }}
      onOk={async () => {
        const v = await form.validateFields().catch(() => null);
        if (!v) return;
        setOpts(null);
        resolver.current?.resolve({ password: v.password, reason: v.reason });
      }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={<span>签名含义：<b>{opts?.meaning}</b></span>}
        description={opts?.description || '电子签名与手写签名具有同等效力，系统将记录签名人、时间与含义，且不可删除。'}
      />
      <Typography.Paragraph>签名人：<b>{user?.full_name}</b>（{user?.username}）</Typography.Paragraph>
      <Form key={seq} form={form} layout="vertical" preserve={false} initialValues={{ reason: opts?.defaultReason }}>
        <Form.Item name="password" label={user?.auth_source === 'KINGDEE' ? '请输入金蝶云星空登录密码' : '请输入登录密码'} rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password autoFocus autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="reason" label={opts?.reasonLabel || '签名理由/意见'} rules={[{ required: !!opts?.reasonRequired, whitespace: true, message: `请填写${opts?.reasonLabel || '理由'}` }]}>
          <Input.TextArea rows={2} placeholder={opts?.reasonPlaceholder || '如：记录完整，批准放行'} />
        </Form.Item>
      </Form>
    </Modal>
  );
  return [sign, holder];
}

/** 判断是否为用户取消签名（用于 catch 中忽略） */
export const isCancel = (e: any) => e?.message === 'cancelled';
