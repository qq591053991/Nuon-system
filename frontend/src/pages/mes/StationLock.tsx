/** 工位终端锁屏：刷工牌（读卡器模拟键盘输入工牌号 + 回车）→ 大按键 PIN 键盘 → 切换为该操作员。 */
import { Alert, Button, Input, Space, Typography, type InputRef } from 'antd';
import { ArrowLeftOutlined, CreditCardOutlined, LockOutlined, LogoutOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { badgeLogin, httpStatus, type StationSession } from './stationApi';
import { errDetail } from './spec';

const PIN_MAX = 8;
const PIN_MIN = 4;

const LOCK_CSS = `
.station-lock { position: fixed; inset: 0; z-index: 1500; background: radial-gradient(circle at 50% 30%, #2b2357 0%, #14112b 70%);
  color: #fff; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 24px; }
.station-lock .lock-card { width: 100%; max-width: 460px; text-align: center; }
.station-lock .lock-title { font-size: 36px; font-weight: 800; letter-spacing: 4px; margin: 8px 0 4px; color: #fff; }
.station-lock .lock-sub { font-size: 17px; color: rgba(255,255,255,.72); }
.station-lock .lock-clock { font-size: 20px; color: rgba(255,255,255,.6); font-variant-numeric: tabular-nums; }
.station-lock .badge-input input { font-size: 24px; height: 60px; text-align: center; letter-spacing: 2px; }
.station-lock .pin-dots { display: flex; justify-content: center; gap: 14px; margin: 18px 0 20px; min-height: 26px; }
.station-lock .pin-dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255,255,255,.7); }
.station-lock .pin-dot.on { background: #fff; }
.station-lock .pin-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.station-lock .pin-key { height: 78px; font-size: 32px; font-weight: 700; border-radius: 14px; }
.station-lock .pin-key.fn { font-size: 20px; }
.station-lock .pin-ok { height: 70px; font-size: 24px; font-weight: 700; margin-top: 16px; border-radius: 14px; }
.station-lock .lock-foot { margin-top: 28px; color: rgba(255,255,255,.55); font-size: 13px; }
.station-lock .lock-foot a, .station-lock .lock-foot .ant-btn-link { color: rgba(255,255,255,.75); }
`;

interface Props {
  /** 锁定原因（交班 / 空闲超时 / 令牌失效） */
  reason?: string | null;
  /** 办公端登录账号（终端账号），仅显示 */
  terminalUser?: string | null;
  onUnlock: (s: StationSession) => void;
  onExit: () => void;
}

export default function StationLock({ reason, terminalUser, onUnlock, onExit }: Props) {
  const [step, setStep] = useState<'badge' | 'pin'>('badge');
  const [badge, setBadge] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(dayjs());
  const badgeRef = useRef<InputRef>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 1000);
    return () => clearInterval(t);
  }, []);

  // 刷卡步骤：读卡器相当于键盘输入，始终保持焦点在工牌输入框
  useEffect(() => {
    if (step !== 'badge') return;
    const focus = () => badgeRef.current?.focus();
    focus();
    const t = setInterval(() => {
      if (document.activeElement?.tagName !== 'INPUT') focus();
    }, 800);
    return () => clearInterval(t);
  }, [step]);

  const backToBadge = useCallback((msg?: string | null) => {
    setPin('');
    setBadge('');
    setStep('badge');
    setError(msg ?? null);
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    if (pin.length < PIN_MIN) {
      setError(`请输入 ${PIN_MIN} 位以上 PIN`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await badgeLogin(badge.trim(), pin);
      if (!r?.access_token || !r.user) throw new Error('登录响应无效');
      if (!(r.user.permissions || []).includes('mes')) {
        backToBadge(`${r.user.full_name} 没有产线报工权限，不能在工位终端操作`);
        return;
      }
      const t = Date.now();
      onUnlock({ token: r.access_token, user: r.user, since: t, last: t });
    } catch (e) {
      const st = httpStatus(e);
      if (st === 404) backToBadge('工牌登录服务尚未部署（/api/auth/badge-login 不可用），请联系系统管理员升级后端。');
      else if (st === 0) {
        setPin('');
        setError('网络连接失败，请检查网络后重试');
      } else if (st === 401 || st === 400) {
        setPin('');
        setError(errDetail(e) || '工牌号或 PIN 错误');
      } else backToBadge(errDetail(e));
    } finally {
      setBusy(false);
    }
  }, [badge, pin, busy, onUnlock, backToBadge]);

  // PIN 步骤：支持实体键盘数字/退格/回车
  useEffect(() => {
    if (step !== 'pin') return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) setPin((p) => (p.length < PIN_MAX ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') backToBadge();
      else if (e.key === 'Enter') submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, submit, backToBadge]);

  const press = (k: string) => {
    setError(null);
    if (k === 'C') setPin('');
    else if (k === '<') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < PIN_MAX ? p + k : p));
  };

  const masked = badge.length > 4 ? `${'*'.repeat(Math.max(0, badge.length - 4))}${badge.slice(-4)}` : badge;

  return (
    <div className="station-lock" role="dialog" aria-modal="true" aria-label="工位终端已锁定">
      <style>{LOCK_CSS}</style>
      <div className="lock-card">
        <div className="lock-clock">{now.format('YYYY-MM-DD HH:mm:ss')}</div>
        {step === 'badge' ? (
          <>
            <CreditCardOutlined style={{ fontSize: 76, color: '#b7a6ff', marginTop: 20 }} />
            <div className="lock-title">请刷工牌</div>
            <div className="lock-sub">工位终端已锁定，刷工牌并输入 PIN 后开始作业</div>
            {reason && <Alert style={{ marginTop: 16, textAlign: 'left' }} type="warning" showIcon icon={<LockOutlined />} message={reason} />}
            {error && <Alert style={{ marginTop: 12, textAlign: 'left' }} type="error" showIcon message={error} />}
            <Input
              ref={badgeRef}
              className="badge-input"
              size="large"
              autoFocus
              autoComplete="off"
              style={{ marginTop: 24 }}
              placeholder="刷卡或输入工牌号后回车"
              value={badge}
              onChange={(e) => {
                setBadge(e.target.value);
                setError(null);
              }}
              onPressEnter={() => {
                if (!badge.trim()) return;
                setPin('');
                setError(null);
                setStep('pin');
              }}
            />
          </>
        ) : (
          <>
            <LockOutlined style={{ fontSize: 56, color: '#b7a6ff', marginTop: 16 }} />
            <div className="lock-title" style={{ fontSize: 30 }}>请输入 PIN</div>
            <div className="lock-sub">工牌 <b className="mono" style={{ color: '#fff' }}>{masked}</b></div>
            {error && <Alert style={{ marginTop: 12, textAlign: 'left' }} type="error" showIcon message={error} />}
            <div className="pin-dots">
              {Array.from({ length: Math.max(PIN_MIN, pin.length) }).map((_, i) => (
                <span key={i} className={`pin-dot${i < pin.length ? ' on' : ''}`} />
              ))}
            </div>
            <div className="pin-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
                <Button key={k} className="pin-key" onClick={() => press(k)} disabled={busy}>{k}</Button>
              ))}
              <Button className="pin-key fn" onClick={() => press('C')} disabled={busy}>清除</Button>
              <Button className="pin-key" onClick={() => press('0')} disabled={busy}>0</Button>
              <Button className="pin-key fn" onClick={() => press('<')} disabled={busy}>退格</Button>
            </div>
            <Button block type="primary" className="pin-ok" loading={busy} disabled={pin.length < PIN_MIN} onClick={submit}>确认</Button>
            <Button type="link" icon={<ArrowLeftOutlined />} style={{ marginTop: 8, color: 'rgba(255,255,255,.8)' }} onClick={() => backToBadge()}>重新刷卡</Button>
          </>
        )}
        <div className="lock-foot">
          <Space split="·" wrap style={{ justifyContent: 'center' }}>
            <span>记录将归属到刷卡的操作员（GMP / 21 CFR Part 11）</span>
            {terminalUser && <span>终端账号：{terminalUser}</span>}
            <Button type="link" size="small" icon={<LogoutOutlined />} onClick={onExit}>退出工位终端</Button>
          </Space>
          <Typography.Paragraph style={{ color: 'rgba(255,255,255,.45)', fontSize: 12, margin: '8px 0 0' }}>
            忘记 PIN 或工牌丢失请联系班组长 / 系统管理员
          </Typography.Paragraph>
        </div>
      </div>
    </div>
  );
}
