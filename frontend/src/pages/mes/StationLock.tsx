/**
 * 工位终端锁屏：刷工牌（读卡器模拟键盘输入工牌号 + 回车）→ 大按键 PIN 键盘 → 切换为该操作员。
 * - C-F12：刷卡的回车不再传到 PIN 页（不会一进去就报“请输入 4 位以上 PIN”）；本终端记住各工牌 PIN 位数，输满自动提交；
 * - C-F13：空闲锁定后，同一操作员同一班次只需刷工牌即可恢复（服务端核对工牌），未提交的数据保留；
 * - C-F14：解锁时即按本工位工序校验上岗资质（由 onUnlock 返回错误）；
 * - C-F07 / C-N3：退出工位终端需班组长刷工牌 + PIN 授权（由 onExit 处理）；
 * - must_change_pin：管理员生成 / 重置的 PIN 首次使用后须本人重设——刷卡 + 原 PIN 后引导两次输入新 PIN（POST /auth/change-pin）。
 */
import { Alert, Button, Input, Space, Typography, type InputRef } from 'antd';
import { ArrowLeftOutlined, CreditCardOutlined, LockOutlined, LogoutOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { badgeLogin, httpStatus, pinLength, rememberPinLength, stationPost, type StationOperator, type StationSession } from './stationApi';
import { errDetail } from './spec';

const PIN_MAX = 8;
const PIN_MIN = 4;

const LOCK_CSS = `
.station-lock { position: fixed; inset: 0; z-index: 1500; background: radial-gradient(circle at 50% 30%, #2b2357 0%, #14112b 70%);
  color: #fff; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 16px; }
.station-lock .lock-card { width: 100%; max-width: 440px; text-align: center; }
.station-lock .lock-title { font-size: 34px; font-weight: 800; letter-spacing: 4px; margin: 4px 0 2px; color: #fff; }
.station-lock .lock-sub { font-size: 17px; color: rgba(255,255,255,.75); }
.station-lock .lock-clock { font-size: 18px; color: rgba(255,255,255,.6); font-variant-numeric: tabular-nums; }
.station-lock .badge-input input { font-size: 24px; height: 60px; text-align: center; letter-spacing: 2px; }
.station-lock .pin-dots { display: flex; justify-content: center; gap: 14px; margin: 12px 0 14px; min-height: 24px; }
.station-lock .pin-dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255,255,255,.7); }
.station-lock .pin-dot.on { background: #fff; }
.station-lock .pin-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.station-lock .pin-key { height: 64px; font-size: 30px; font-weight: 700; border-radius: 12px; }
.station-lock .pin-key.fn { font-size: 20px; }
.station-lock .pin-ok { height: 60px; font-size: 22px; font-weight: 700; margin-top: 12px; border-radius: 12px; }
.station-lock .pin-ok.ant-btn-primary:disabled { background: rgba(255,255,255,.18); color: rgba(255,255,255,.55); border-color: transparent; }
.station-lock .lock-foot { margin-top: 18px; color: rgba(255,255,255,.55); font-size: 13px; }
.station-lock .lock-foot .ant-btn-link { color: rgba(255,255,255,.8); height: 44px; font-size: 15px; }
.station-lock .resume { margin-top: 14px; padding: 10px 14px; border-radius: 10px; background: rgba(183,166,255,.16); border: 1px solid rgba(183,166,255,.45); font-size: 16px; }
`;

interface Props {
  /** 锁定原因（交班 / 空闲超时 / 令牌失效） */
  reason?: string | null;
  /** 办公端登录账号（终端账号），仅显示 */
  terminalUser?: string | null;
  /** 本工位工序（显示） */
  stationText?: string | null;
  /** 空闲锁定的会话：本人刷工牌即可恢复 */
  resume?: { full_name: string; badge_no?: string | null; pending?: string | null } | null;
  /** 刷卡 + PIN 登录成功；返回错误文字则拒绝解锁（如无本工位上岗资质） */
  onUnlock: (s: StationSession) => Promise<string | null | void>;
  /** 本人刷卡恢复；返回错误文字则改走 PIN 登录 */
  onResume: (badge: string) => Promise<string | null>;
  onExit: () => void;
}

export default function StationLock({ reason, terminalUser, stationText, resume, onUnlock, onResume, onExit }: Props) {
  /** badge 刷卡 → pin 输入 PIN →（须改 PIN 时）new1 / new2 两次输入新 PIN */
  const [step, setStep] = useState<'badge' | 'pin' | 'new1' | 'new2'>('badge');
  /** 须改 PIN：已通过原 PIN 校验的登录结果 */
  const changing = useRef<{ token: string; user: StationOperator; old: string; first?: string } | null>(null);
  const [badge, setBadge] = useState('');
  const [pin, setPinState] = useState('');
  const pinRef = useRef('');
  const setPin = useCallback((p: string) => {
    pinRef.current = p;
    setPinState(p);
  }, []);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(dayjs());
  const badgeRef = useRef<InputRef>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 1000);
    return () => clearInterval(t);
  }, []);

  // 刷卡步骤：读卡器相当于键盘输入，始终保持焦点在工牌输入框（弹窗打开时除外）
  useEffect(() => {
    if (step !== 'badge') return;
    const focus = () => badgeRef.current?.focus();
    focus();
    const t = setInterval(() => {
      if (document.activeElement?.tagName !== 'INPUT' && !document.querySelector('.ant-modal-wrap')) focus();
    }, 800);
    return () => clearInterval(t);
  }, [step]);

  const backToBadge = useCallback((msg?: string | null) => {
    setPin('');
    setBadge('');
    setStep('badge');
    setError(msg ?? null);
    changing.current = null;
  }, [setPin]);

  const finish = useCallback(async (token: string, user: StationOperator) => {
    const t = Date.now();
    const msg = await onUnlock({ token, user: { ...user, badge_no: user.badge_no ?? badge.trim() }, since: t, last: t });
    if (msg) backToBadge(msg);
  }, [badge, onUnlock, backToBadge]);

  /** 设置新 PIN：第一次输入 → 再输一次确认 → 提交 */
  const submitNew = useCallback(async (p: string) => {
    const c = changing.current;
    if (!c || busyRef.current) return;
    if (p.length < PIN_MIN) {
      setError(`新 PIN 须为 ${PIN_MIN}–${PIN_MAX} 位数字`);
      return;
    }
    if (step === 'new1') {
      if (/^(\d)\1+$/.test(p)) {
        setPin('');
        setError('PIN 不能是相同的数字（如 1111），请重新输入');
        return;
      }
      if (p === c.old) {
        setPin('');
        setError('新 PIN 不能与原 PIN 相同');
        return;
      }
      c.first = p;
      setPin('');
      setError(null);
      setStep('new2');
      return;
    }
    if (p !== c.first) {
      c.first = undefined;
      setPin('');
      setStep('new1');
      setError('两次输入的新 PIN 不一致，请重新设置');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await stationPost(c.token, '/auth/change-pin', { old_pin: c.old, new_pin: p });
      rememberPinLength(badge, p.length);
      changing.current = null;
      await finish(c.token, { ...c.user, must_change_pin: false } as StationOperator);
    } catch (e) {
      c.first = undefined;
      setPin('');
      setStep('new1');
      setError(errDetail(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [step, badge, finish, setPin]);

  const submit = useCallback(async (p: string) => {
    if (step === 'new1' || step === 'new2') return submitNew(p);
    if (busyRef.current) return;
    if (p.length < PIN_MIN) {
      setError(`PIN 至少 ${PIN_MIN} 位`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await badgeLogin(badge.trim(), p);
      if (!r?.access_token || !r.user) throw new Error('登录响应无效');
      if (!(r.user.permissions || []).includes('mes')) {
        backToBadge(`${r.user.full_name} 没有产线报工权限，不能在工位终端操作`);
        return;
      }
      if ((r.user as StationOperator & { must_change_pin?: boolean }).must_change_pin) {
        // 管理员生成 / 重置的 PIN：首次使用须本人重设
        changing.current = { token: r.access_token, user: r.user, old: p };
        setPin('');
        setStep('new1');
        return;
      }
      rememberPinLength(badge, p.length);
      await finish(r.access_token, r.user);
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
      busyRef.current = false;
      setBusy(false);
    }
  }, [badge, step, submitNew, finish, backToBadge, setPin]);

  /** 数字键：输满本工牌已知的 PIN 位数时自动提交（设置新 PIN 时不自动提交） */
  const addDigit = useCallback((d: string) => {
    if (busyRef.current) return;
    setError(null);
    const p = pinRef.current;
    if (p.length >= PIN_MAX) return;
    const np = p + d;
    setPin(np);
    const n = step === 'pin' ? pinLength(badge) : null;
    if (n && np.length === n) submit(np);
  }, [badge, step, submit, setPin]);

  // PIN 步骤：支持实体键盘数字 / 退格 / 回车（刷卡那一下的回车已在工牌框内拦截，不会传到这里）
  useEffect(() => {
    if (step === 'badge') return;
    const onKey = (e: KeyboardEvent) => {
      // 弹窗（班组长授权）里的输入不归 PIN 键盘处理
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || document.querySelector('.ant-modal-wrap .ant-modal')) return;
      if (/^[0-9]$/.test(e.key)) addDigit(e.key);
      else if (e.key === 'Backspace') setPin(pinRef.current.slice(0, -1));
      else if (e.key === 'Escape') backToBadge();
      else if (e.key === 'Enter') {
        if (pinRef.current.length) submit(pinRef.current);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, submit, addDigit, backToBadge, setPin]);

  const onBadgeEnter = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation(); // 不让这一下回车传到 PIN 页的键盘监听（C-F12 误报“请输入 4 位以上 PIN”）
    const b = badge.trim();
    if (!b) return;
    setError(null);
    if (resume && resume.badge_no && resume.badge_no.trim().toUpperCase() === b.toUpperCase()) {
      setBusy(true);
      try {
        const msg = await onResume(b);
        if (!msg) return;
        setError(`${msg}，请输入 PIN`);
      } finally {
        setBusy(false);
      }
    }
    setPin('');
    setStep('pin');
  };

  const press = (k: string) => {
    setError(null);
    if (k === 'C') setPin('');
    else if (k === '<') setPin(pinRef.current.slice(0, -1));
    else addDigit(k);
  };

  const masked = badge.length > 4 ? `${'*'.repeat(Math.max(0, badge.length - 4))}${badge.slice(-4)}` : badge;
  const known = pinLength(badge);

  return (
    <div className="station-lock" role="dialog" aria-modal="true" aria-label="工位终端已锁定">
      <style>{LOCK_CSS}</style>
      <div className="lock-card">
        <div className="lock-clock">{now.format('YYYY-MM-DD HH:mm:ss')}{stationText ? ` · ${stationText}` : ''}</div>
        {step === 'badge' ? (
          <>
            <CreditCardOutlined style={{ fontSize: 64, color: '#b7a6ff', marginTop: 16 }} />
            <div className="lock-title">请刷工牌</div>
            <div className="lock-sub">工位终端已锁定，刷工牌{resume ? '' : '并输入 PIN '}后开始作业</div>
            {resume && (
              <div className="resume">
                <b>{resume.full_name}</b>：刷本人工牌即可继续，无需 PIN
                {resume.pending ? <div style={{ fontSize: 14, opacity: 0.85 }}>已保留：{resume.pending}</div> : null}
              </div>
            )}
            {reason && <Alert style={{ marginTop: 12, textAlign: 'left' }} type="warning" showIcon icon={<LockOutlined />} message={reason} />}
            {error && <Alert style={{ marginTop: 10, textAlign: 'left' }} type="error" showIcon message={<b>{error}</b>} />}
            <Input
              ref={badgeRef}
              className="badge-input"
              size="large"
              autoFocus
              autoComplete="off"
              disabled={busy}
              style={{ marginTop: 20 }}
              placeholder="刷卡或输入工牌号后回车"
              value={badge}
              onChange={(e) => {
                setBadge(e.target.value);
                setError(null);
              }}
              onPressEnter={onBadgeEnter}
            />
          </>
        ) : (
          <>
            <LockOutlined style={{ fontSize: 44, color: '#b7a6ff', marginTop: 8 }} />
            <div className="lock-title" style={{ fontSize: 28 }}>
              {step === 'pin' ? '请输入 PIN' : step === 'new1' ? '请设置新 PIN' : '请再输一次新 PIN'}
            </div>
            <div className="lock-sub">
              {step === 'pin' ? (
                <>工牌 <b className="mono" style={{ color: '#fff' }}>{masked}</b>{known ? ` · 输满 ${known} 位自动确认` : ' · 输完按回车或【确认】'}</>
              ) : step === 'new1' ? (
                <>{changing.current?.user.full_name}：PIN 由管理员生成，首次使用须改成只有您知道的 {PIN_MIN}–{PIN_MAX} 位数字，输完按回车</>
              ) : '再输一次确认，输完按回车'}
            </div>
            {error && <Alert style={{ marginTop: 10, textAlign: 'left' }} type="error" showIcon message={<b>{error}</b>} />}
            <div className="pin-dots">
              {Array.from({ length: Math.max(known ?? PIN_MIN, pin.length) }).map((_, i) => (
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
            <Button block type="primary" className="pin-ok" loading={busy} disabled={pin.length < PIN_MIN} onClick={() => submit(pin)}>{step === 'pin' ? '确认' : step === 'new1' ? '下一步' : '确认新 PIN'}</Button>
            <Button type="link" icon={<ArrowLeftOutlined />} style={{ marginTop: 4, color: 'rgba(255,255,255,.85)', height: 44 }} onClick={() => backToBadge()}>重新刷卡</Button>
          </>
        )}
        <div className="lock-foot">
          <Space split="·" wrap style={{ justifyContent: 'center' }}>
            <span>记录归属刷卡的操作员（GMP / 21 CFR Part 11）</span>
            {terminalUser && <span>终端账号：{terminalUser}</span>}
            <Button type="link" size="small" icon={<LogoutOutlined />} onClick={onExit}>退出工位终端（需班组长授权）</Button>
          </Space>
          <Typography.Paragraph style={{ color: 'rgba(255,255,255,.45)', fontSize: 12, margin: '4px 0 0' }}>
            忘记 PIN 或工牌丢失请联系班组长 / 系统管理员
          </Typography.Paragraph>
        </div>
      </div>
    </div>
  );
}
