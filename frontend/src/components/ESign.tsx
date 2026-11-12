import { Alert, Form, Input, Modal, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import type { InputRef } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../auth';

export interface Signature { password: string; reason?: string }
interface Opts<T = unknown> {
  meaning: string;
  description?: string;
  reasonRequired?: boolean;
  defaultReason?: string;
  /** 理由输入框的标题与提示（如驳回时为“驳回原因”） */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /**
   * 推荐：在弹窗内直接提交业务请求。提交失败（如密码错误）时弹窗保持打开并显示原因，
   * 用户改正后可直接重试；成功后关闭弹窗并返回提交结果。
   */
  submit?: (sig: Signature) => Promise<T>;
}

const errText = (e: any): string => {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) return d.map((x: any) => x?.msg ?? String(x)).join('；');
  return d || e?.message || '提交失败';
};

/**
 * 电子签名（21 CFR Part 11 / GMP）：关键操作需再次输入本人密码并声明签名含义。
 * 打开时密码框自动获得焦点；在密码框按回车即提交；理由框按 Ctrl+Enter 提交。
 *
 *   const [sign, signHolder] = useESign();
 *   // 推荐：弹窗内提交，密码错误不关闭弹窗
 *   const res = await sign({ meaning: '产品放行（DHR审核批准）', submit: (signature) => post(url, { ..., signature }) });
 *   // 兼容：只取签名
 *   const signature = await sign({ meaning: '...' }); await post(url, { signature });
 *   // 用户取消时抛出异常，用 isCancel(e) 判断
 *   return <>{signHolder}...</>
 */
/** 签名函数：不带 submit 时返回签名；带 submit 时返回提交结果 */
export interface SignFn {
  <T>(o: Opts<T> & { submit: (sig: Signature) => Promise<T> }): Promise<T>;
  // 放在最后：Parameters<typeof sign> / ReturnType 取最后一个重载
  (o: Omit<Opts, 'submit'>): Promise<Signature>;
}

export function useESign(): [SignFn, JSX.Element] {
  const { user } = useAuth();
  const [opts, setOpts] = useState<Opts<any> | null>(null);
  const [seq, setSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const pwdRef = useRef<InputRef>(null);
  const resolver = useRef<{ resolve: (v: any) => void; reject: (e: any) => void } | null>(null);

  const sign = useCallback(
    <T,>(o: Opts<T>) =>
      new Promise<T>((resolve, reject) => {
        resolver.current = { resolve, reject };
        // 每次签名都重新挂载一张空白表单（不保留上次输入的密码；默认理由见 initialValues）
        setSeq((n) => n + 1);
        setError(null);
        setOpts(o);
      }),
    [],
  );

  const close = () => {
    setOpts(null);
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const sig: Signature = { password: v.password, reason: v.reason };
    if (!opts?.submit) {
      close();
      resolver.current?.resolve(sig);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await opts.submit(sig);
      close();
      resolver.current?.resolve(res);
    } catch (e) {
      setBusy(false);
      setError(errText(e));
      form.setFieldsValue({ password: '' });
      setTimeout(() => pwdRef.current?.focus(), 0);
    }
  };

  const holder = (
    <Modal
      open={!!opts}
      title={<span><SafetyCertificateOutlined style={{ color: '#722ed1', marginRight: 8 }} />电子签名确认</span>}
      okText="签名并提交（回车）"
      cancelText="取消"
      confirmLoading={busy}
      destroyOnHidden
      afterOpenChange={(o) => o && setTimeout(() => pwdRef.current?.focus(), 0)}
      onCancel={() => {
        if (busy) return;
        close();
        resolver.current?.reject(new Error('cancelled'));
      }}
      onOk={submit}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={<span>签名含义：<b>{opts?.meaning}</b></span>}
        description={opts?.description || '电子签名与手写签名具有同等效力，系统将记录签名人、时间与含义，且不可删除。'}
      />
      <Typography.Paragraph>签名人：<b>{user?.full_name}</b>（{user?.username}）</Typography.Paragraph>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Form key={seq} form={form} layout="vertical" preserve={false} initialValues={{ reason: opts?.defaultReason }}>
        <Form.Item name="password" label={user?.auth_source === 'KINGDEE' ? '请输入金蝶云星空登录密码' : '请输入登录密码'} rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password ref={pwdRef} autoFocus autoComplete="current-password" onPressEnter={(e) => { e.preventDefault(); submit(); }} />
        </Form.Item>
        <Form.Item name="reason" label={opts?.reasonLabel || '签名理由/意见'} extra="按 Ctrl+Enter 提交" rules={[{ required: !!opts?.reasonRequired, whitespace: true, message: `请填写${opts?.reasonLabel || '理由'}` }]}>
          <Input.TextArea
            rows={2}
            placeholder={opts?.reasonPlaceholder || '如：记录完整，批准放行'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
  return [sign as SignFn, holder];
}

/** 判断是否为用户取消签名（用于 catch 中忽略） */
export const isCancel = (e: any) => e?.message === 'cancelled';
