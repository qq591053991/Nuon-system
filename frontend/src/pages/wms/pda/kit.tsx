/**
 * PDA 作业页共用：竖排页面框架、提示音、结果横幅、扫码字段（回车跳下一项）、日期文本解析、库位解析与放置校验、回车确认框。
 * 设计目标：一手拿货一手拿 PDA（360×780），扫码 = 键入 + 回车，不依赖鼠标和小按钮。
 */
import { Button, Input, Modal, Typography, type InputRef } from 'antd';
import { ArrowLeftOutlined, CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, ScanOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { forwardRef, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';

// ---------------- 提示音 ----------------
let audio: AudioContext | null = null;
/** 提示音：ok 短促高音；err 两声低音（扫错时不用看屏幕也知道） */
export function beep(kind: 'ok' | 'err' | 'warn' = 'ok') {
  try {
    audio ||= new (window.AudioContext || (window as any).webkitAudioContext)();
    const tones = kind === 'ok' ? [[1200, 0.08]] : kind === 'warn' ? [[660, 0.15]] : [[260, 0.18], [200, 0.25]];
    let t = audio.currentTime;
    for (const [f, d] of tones) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = kind === 'ok' ? 'sine' : 'square';
      o.frequency.value = f;
      g.gain.value = 0.15;
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + d);
      t += d + 0.05;
    }
  } catch {
    /* 浏览器不支持时静默 */
  }
}

/** 后端错误文本 */
export const errText = (e: any): string => {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) return d.map((x: any) => x?.msg ?? String(x)).join('；');
  return d || e?.message || '操作失败';
};

// ---------------- 页面框架 ----------------
export function PdaPage({ title, sub, back = '/wms/pda', extra, children, footer, dirtyText }: {
  title: ReactNode; sub?: ReactNode; back?: string | null; extra?: ReactNode; children: ReactNode; footer?: ReactNode;
  /** 有未提交内容时的提示（点返回会先确认；内容已暂存本机） */
  dirtyText?: string | null;
}) {
  const navTo = useNavigate();
  const nav = async (to: string) => {
    if (dirtyText && !(await confirmEnter('还有未提交的内容', <div>{dirtyText}。<br />已暂存在本机，回到本页可恢复。确定离开？</div>, '离开', false, 'cancel'))) return;
    navTo(to);
  };
  return (
    <div className="pda-page" style={{ maxWidth: 560, margin: '0 auto', paddingBottom: footer ? 84 : 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {back !== null && (
          <Button size="large" icon={<ArrowLeftOutlined />} onClick={() => nav(back)} aria-label="返回" style={{ flex: 'none' }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{title}</div>
          {sub && <Typography.Text type="secondary" style={{ fontSize: 13 }}>{sub}</Typography.Text>}
        </div>
        {extra}
      </div>
      {children}
      {footer && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '10px 12px', background: 'rgba(255,255,255,0.96)', borderTop: '1px solid #eee', zIndex: 20 }}>
          <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', gap: 8 }}>{footer}</div>
        </div>
      )}
    </div>
  );
}

// ---------------- 结果横幅 ----------------
export interface Feedback { kind: 'ok' | 'err' | 'warn' | 'info'; text: ReactNode }

/** 最近一次扫码/提交的结果（大字、颜色区分；出错同时响提示音） */
export function useFeedback() {
  const [fb, setFb] = useState<Feedback | null>(null);
  const show = useCallback((kind: Feedback['kind'], text: ReactNode, sound = true) => {
    setFb({ kind, text });
    if (sound && kind !== 'info') beep(kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err');
  }, []);
  const clear = useCallback(() => setFb(null), []);
  return { fb, show, clear };
}

const FB_STYLE: Record<Feedback['kind'], CSSProperties> = {
  ok: { background: '#f6ffed', border: '2px solid #52c41a', color: '#237804' },
  err: { background: '#fff1f0', border: '2px solid #ff4d4f', color: '#a8071a' },
  warn: { background: '#fffbe6', border: '2px solid #faad14', color: '#ad6800' },
  info: { background: '#e6f4ff', border: '1px solid #91caff', color: '#003eb3' },
};

export function FeedbackBar({ fb }: { fb: Feedback | null }) {
  if (!fb) return null;
  const icon = fb.kind === 'ok' ? <CheckCircleFilled /> : fb.kind === 'err' ? <CloseCircleFilled /> : <ExclamationCircleFilled />;
  return (
    <div role="status" className={`pda-fb pda-fb-${fb.kind}`} style={{ ...FB_STYLE[fb.kind], borderRadius: 8, padding: '10px 12px', margin: '8px 0', fontSize: 16, lineHeight: 1.4, display: 'flex', gap: 8 }}>
      <span style={{ flex: 'none', marginTop: 2 }}>{icon}</span>
      <div style={{ minWidth: 0, wordBreak: 'break-all' }}>{fb.text}</div>
    </div>
  );
}

// ---------------- 字段 ----------------
/** 大号输入（PDA）：回车触发 onEnter；label 在上，提示在下 */
export const PdaField = forwardRef<InputRef, {
  label: ReactNode; value: string; onChange: (v: string) => void; onEnter: () => void; placeholder?: string; hint?: ReactNode;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'none'; disabled?: boolean; active?: boolean; suffix?: ReactNode; scan?: boolean; name?: string;
}>(function PdaField({ label, value, onChange, onEnter, placeholder, hint, inputMode, disabled, active, suffix, scan, name }, ref) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, color: active ? '#1677ff' : '#595959', fontWeight: active ? 600 : 400, marginBottom: 4 }}>{label}</div>
      <Input
        ref={ref}
        name={name}
        size="large"
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        placeholder={placeholder}
        prefix={scan ? <ScanOutlined style={{ color: '#5b3cc4' }} /> : undefined}
        suffix={suffix}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onPressEnter={(e) => { e.preventDefault(); onEnter(); }}
        style={{ fontSize: 18, height: 48, borderColor: active ? '#1677ff' : undefined, boxShadow: active ? '0 0 0 2px rgba(22,119,255,.15)' : undefined }}
      />
      {hint && <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>{hint}</div>}
    </div>
  );
});

/** 大号主按钮（≥ 48px） */
export function BigButton(p: { children: ReactNode; onClick: () => void; type?: 'primary' | 'default'; danger?: boolean; disabled?: boolean; loading?: boolean; icon?: ReactNode; block?: boolean }) {
  return (
    <Button size="large" type={p.type ?? 'primary'} danger={p.danger} disabled={p.disabled} loading={p.loading} icon={p.icon} block={p.block ?? true}
      onClick={p.onClick} style={{ height: 52, fontSize: 18, fontWeight: 600 }}>
      {p.children}
    </Button>
  );
}

// ---------------- 解析 ----------------
/** 日期文本 → YYYY-MM-DD：支持 261020、20261020、2026-10-20、2026/10/20、2026.10.20；空 → null；非法 → undefined */
export function parseDateText(s: string): string | null | undefined {
  const t = (s ?? '').trim();
  if (!t) return null;
  let d: dayjs.Dayjs | null = null;
  if (/^\d{6}$/.test(t)) d = dayjs(`20${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}`);
  else if (/^\d{8}$/.test(t)) d = dayjs(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`);
  else if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t)) d = dayjs(t.replace(/[/.]/g, '-'));
  if (!d || !d.isValid()) return undefined;
  if (d.year() < 2000 || d.isAfter(dayjs().add(1, 'day'))) return undefined;
  return d.format('YYYY-MM-DD');
}

/** GS1 日期 YYMMDD → YYYY-MM-DD */
export const gs1Date = (s?: string) => (s && /^\d{6}$/.test(s) ? parseDateText(s) ?? null : null);

export interface PlaceResult { ok: boolean; errors: string[]; warnings: string[]; location: Rec | null }

/** 库位编码解析 + 放置校验（自有/客供与仓库不符 → 错误；湿敏物料非防潮柜 → 警告） */
export const checkPlace = (material_id: number, code: string, owner_customer_id?: number | null): Promise<PlaceResult> =>
  post('/wms/placement-check', { material_id, location_code: code, ...(owner_customer_id !== undefined ? { owner_customer_id } : {}) }, true);

/**
 * 确认框：默认焦点在“确认”上（回车即确认，Esc 返回）；focus='cancel' 时焦点在“返回”上
 * （用于“不核对就过账”这类不该被扫码枪回车误确认的操作）。
 */
export function confirmEnter(title: ReactNode, content: ReactNode, okText = '确认（回车）', danger = false, focus: 'ok' | 'cancel' = 'ok'): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title, content, okText, cancelText: focus === 'cancel' ? '返回（回车）' : '返回', autoFocusButton: focus, okButtonProps: { danger, size: 'large' }, cancelButtonProps: { size: 'large' },
      onOk: () => resolve(true), onCancel: () => resolve(false),
    });
  });
}

// ---------------- 未提交内容暂存本机（B-N2） ----------------
/** 本机暂存：按“作业 + 账号”分键，只存在这台 PDA 的浏览器里；读写失败（隐私模式等）时静默 */
export interface Draft<T> { saved_at: string; data: T }
const draftKey = (kind: string, user?: string | null) => `nuon.pda.draft.${kind}.${user || '-'}`;
export function loadDraft<T>(kind: string, user?: string | null): Draft<T> | null {
  try {
    const raw = localStorage.getItem(draftKey(kind, user));
    return raw ? (JSON.parse(raw) as Draft<T>) : null;
  } catch {
    return null;
  }
}
export function saveDraft<T>(kind: string, user: string | null | undefined, data: T | null) {
  try {
    if (data === null) localStorage.removeItem(draftKey(kind, user));
    else localStorage.setItem(draftKey(kind, user), JSON.stringify({ saved_at: new Date().toISOString(), data }));
  } catch {
    /* 本机存储不可用时不影响作业 */
  }
}
export const clearDraft = (kind: string, user?: string | null) => saveDraft(kind, user, null);

/** 有未提交内容时：关闭/刷新页面弹浏览器提示（内容已暂存本机，回来可恢复） */
export function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
}

/** “x 分钟前”之类的暂存时间 */
export const savedAgo = (iso?: string) => (iso ? dayjs(iso).format('MM-DD HH:mm') : '');

/** 让元素获得焦点（等待渲染） */
export const focusLater = (ref: { current: { focus: () => void; select?: () => void } | null }, select = false) =>
  setTimeout(() => { ref.current?.focus(); if (select) (ref.current as any)?.select?.(); }, 30);

/** 数字文本 → number（空 → null，非法 → NaN） */
export const numText = (s: string): number | null => (s.trim() === '' ? null : Number(s.trim()));
