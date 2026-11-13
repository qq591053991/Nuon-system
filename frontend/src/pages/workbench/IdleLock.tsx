/**
 * 空闲锁屏（R1，E-29 / WH-22）：N 分钟无操作锁屏而不是退出——页面和未提交的内容原样保留。
 *  - 本人输入登录密码解锁；有工牌的员工也可刷工牌 + PIN 解锁（手持终端上更快）；
 *  - 换人使用请点“换人登录”（退出后重新登录，原页面内容不再保留）；
 *  - 锁屏前 60 秒提醒，可“继续使用”；多个标签页共享操作时间与锁屏状态；刷新页面仍保持锁屏；
 *  - 解锁失败计入连续失败次数（与登录共用，达到上限锁定账号）。
 * 工位终端（/mes/station）有自己的锁屏，不使用本组件。
 */
import { Alert, Avatar, Button, Input, Modal, Segmented, Space, Typography, type InputRef } from 'antd';
import { ClockCircleOutlined, IdcardOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { post, TOKEN_KEY } from '../../api/http';
import { useAuth } from '../../auth';

const ACTIVITY_KEY = 'nuon_last_activity';
/** 锁屏状态（值 = 被锁的账号），多标签页共享，刷新后仍锁 */
export const LOCK_KEY = 'nuon_screen_locked';
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const WARN_SECONDS = 60;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 存储不可用时仅本页生效 */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export default function IdleLock({ minutes }: { minutes: number }) {
  const { user, logout } = useAuth();
  const username = user?.username ?? '';
  const [locked, setLocked] = useState(() => !!username && store.get(LOCK_KEY) === username);
  const [left, setLeft] = useState<number | null>(null);
  const last = useRef(Date.now());
  const warning = useRef(false);

  const touch = useCallback(() => {
    last.current = Date.now();
    store.set(ACTIVITY_KEY, String(last.current));
  }, []);

  const lock = useCallback(() => {
    warning.current = false;
    setLeft(null);
    store.set(LOCK_KEY, username);
    setLocked(true);
  }, [username]);

  // 其他标签页锁屏/解锁时同步
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key !== LOCK_KEY) return;
      if (e.newValue === username) setLocked(true);
      else if (!e.newValue) {
        setLocked(false);
        touch();
      }
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, [username, touch]);

  useEffect(() => {
    if (!(minutes > 0) || locked || !username) return;
    const limit = minutes * 60_000;
    const onActivity = () => {
      if (!warning.current && Date.now() - last.current > 1000) touch();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { capture: true, passive: true }));
    touch();
    const timer = setInterval(() => {
      const shared = Number(store.get(ACTIVITY_KEY));
      if (shared > last.current) last.current = shared; // 其他标签页有操作
      const idle = Date.now() - last.current;
      if (idle >= limit) {
        clearInterval(timer);
        lock();
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
  }, [minutes, locked, username, lock, touch]);

  const unlocked = () => {
    store.del(LOCK_KEY);
    setLocked(false);
    touch();
  };

  return (
    <>
      <Modal
        open={left !== null && !locked}
        title={<span><ClockCircleOutlined style={{ color: '#fa8c16', marginRight: 8 }} />长时间未操作</span>}
        closable={false}
        maskClosable={false}
        keyboard={false}
        okText="继续使用"
        cancelText="立即锁屏"
        onOk={() => {
          warning.current = false;
          touch();
          setLeft(null);
        }}
        onCancel={lock}
      >
        <Typography.Paragraph>
          您已约 {minutes} 分钟没有操作，系统将在 <b style={{ color: '#cf1322', fontSize: 16 }}>{left}</b> 秒后锁屏。
        </Typography.Paragraph>
        <Typography.Text type="secondary">锁屏不会丢失正在填写的内容，本人输入密码（或刷工牌）即可继续。</Typography.Text>
      </Modal>
      {locked && <LockScreen onUnlocked={unlocked} onSwitch={() => { store.del(LOCK_KEY); logout(); }} />}
    </>
  );
}

function LockScreen({ onUnlocked, onSwitch }: { onUnlocked: () => void; onSwitch: () => void }) {
  const { user } = useAuth();
  const hasBadge = !!user?.badge_no;
  const [mode, setMode] = useState<'password' | 'badge'>('password');
  const [password, setPassword] = useState('');
  const [badge, setBadge] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pwdRef = useRef<InputRef>(null);
  const badgeRef = useRef<InputRef>(null);
  const pinRef = useRef<InputRef>(null);

  // 锁屏时焦点必须在解锁框里（底下的页面可能在加载后抢焦点）：前 3 秒反复确认；之后任何按键都把焦点拉回来
  useEffect(() => {
    const inLock = () => !!document.activeElement?.closest('.idle-lock');
    const focus = () => { if (!inLock()) (mode === 'password' ? pwdRef : badgeRef).current?.focus(); };
    const timers = [120, 400, 900, 1600, 3000].map((ms) => setTimeout(focus, ms));
    const onKey = () => focus();
    window.addEventListener('keydown', onKey, true);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [mode]);

  const submit = async () => {
    if (busy) return;
    const body = mode === 'password' ? { password } : { badge_no: badge.trim(), pin };
    if (mode === 'password' && !password) return setError('请输入登录密码');
    if (mode === 'badge' && (!badge.trim() || !pin)) return setError(!badge.trim() ? '请刷工牌（或输入工牌号）' : '请输入 PIN');
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ access_token: string }>('/auth/unlock', body, true);
      try {
        localStorage.setItem(TOKEN_KEY, r.access_token);
      } catch {
        /* ignore */
      }
      setPassword('');
      setPin('');
      onUnlocked();
    } catch (e: any) {
      setError(e?.response?.data?.detail || '解锁失败，请重试');
      setPassword('');
      setPin('');
      setTimeout(() => (mode === 'password' ? pwdRef : pinRef).current?.focus(), 50);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      className="idle-lock"
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={null}
      width={400}
      zIndex={2000}
      styles={{ mask: { backdropFilter: 'blur(10px)', background: 'rgba(22, 15, 44, 0.82)' } }}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space size={12}>
          <Avatar size={48} icon={<UserOutlined />} style={{ background: '#722ed1' }} />
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}><LockOutlined /> 屏幕已锁定</Typography.Title>
            <Typography.Text type="secondary">{user?.full_name}（{user?.username}）· 正在填写的内容已保留</Typography.Text>
          </div>
        </Space>
        {hasBadge && (
          <Segmented block value={mode} onChange={(v) => { setMode(v as 'password' | 'badge'); setError(null); }}
            options={[{ value: 'password', label: '输入密码' }, { value: 'badge', label: <span><IdcardOutlined /> 刷工牌 + PIN</span> }]} />
        )}
        {mode === 'password' ? (
          <Input.Password ref={pwdRef} size="large" prefix={<LockOutlined />} placeholder="本人登录密码" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} onPressEnter={submit} />
        ) : (
          <>
            <Input ref={badgeRef} size="large" prefix={<IdcardOutlined />} placeholder="刷工牌（或输入工牌号）" value={badge} autoComplete="off"
              onChange={(e) => setBadge(e.target.value)} onPressEnter={() => pinRef.current?.focus()} />
            <Input.Password ref={pinRef} size="large" placeholder="PIN" inputMode="numeric" maxLength={8} value={pin} autoComplete="off"
              onChange={(e) => setPin(e.target.value)} onPressEnter={submit} />
          </>
        )}
        {error && <Alert type="error" showIcon message={error} />}
        <Button type="primary" size="large" block loading={busy} onClick={submit}>解锁继续</Button>
        <div style={{ textAlign: 'center' }}>
          <Button type="link" onClick={() => Modal.confirm({
            title: '换人登录？',
            content: '将退出当前账号，锁屏前未保存的内容不会保留。',
            okText: '退出并换人',
            cancelText: '返回',
            zIndex: 2100,
            onOk: onSwitch,
          })}
          >
            不是 {user?.full_name}？换人登录
          </Button>
        </div>
      </Space>
    </Modal>
  );
}
