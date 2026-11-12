/**
 * 工位录入框（C-F01 [P0] 回车跳转随机失灵的根治）：
 *
 * 根因：旧版在每次渲染时执行 `inputs.current = []` 清空输入框引用表，再靠回调 ref 在提交阶段重新登记。
 * 空闲倒计时每秒 setState 一次，React 有时会“渲染但不提交”（状态值相同时的 bailout），此时引用表被清空却没有重新登记，
 * 回车找不到下一个框 → 焦点留在原框，后面的数字拼接到上一个值上（660.3 + 85 → 660.385）。
 *
 * 新做法：
 * - 回车跳转只按 DOM 顺序查找带 data-sfield 的录入框（findNext），不依赖任何渲染期间维护的引用表；
 * - 每个录入框自己保存文本与错误状态（非受控于父组件），父组件只通过 onValue 同步保存数值，录入时不触发整页重渲染；
 * - 数字框逐键过滤：只允许一个小数点、负号只能在开头、小数位不超过工艺设定；超出合理范围当场提示且不前进；
 * - 错误提示贴在输入框下方；跳到下一框时全选原内容（重录直接覆盖）。
 */
import { useEffect, useRef, useState } from 'react';
import { inSpec, isOkNg, num, specText, type SpecParam } from '../spec';
import { beep } from './feedback';

export interface FieldApi {
  focus: () => void;
  setError: (msg: string | null) => void;
}

/** 下一个录入框（按 DOM 顺序）；没有则返回 null */
export function findNext(root: HTMLElement | null, from: HTMLElement): HTMLElement | null {
  if (!root) return null;
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-sfield]'));
  const i = all.indexOf(from);
  return i >= 0 ? all[i + 1] ?? null : all[0] ?? null;
}

export function focusField(el: HTMLElement | null) {
  if (!el) return;
  el.focus();
  if (el instanceof HTMLInputElement) {
    try {
      el.select();
    } catch {
      /* 忽略 */
    }
  }
}

const hasNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && !Number.isNaN(v);

/** 合理范围文本 */
export const validText = (p: SpecParam) => `${hasNum(p.min_valid) ? num(p.min_valid) : '不限'} ~ ${hasNum(p.max_valid) ? num(p.max_valid) : '不限'}${p.unit ? ` ${p.unit}` : ''}`;

/** 录入过程中的文本是否允许（逐键过滤） */
export function allowPartial(p: SpecParam, text: string): boolean {
  if (text.length > 12) return false;
  const neg = !(hasNum(p.min_valid) && p.min_valid >= 0) ? '-?' : '';
  const d = p.decimals;
  const re = d === 0 ? new RegExp(`^${neg}\\d*$`) : hasNum(d) ? new RegExp(`^${neg}\\d*(\\.\\d{0,${d}})?$`) : new RegExp(`^${neg}\\d*(\\.\\d*)?$`);
  return re.test(text);
}

/** 回车时校验：返回数值或错误文字 */
export function checkValue(p: SpecParam, text: string): { value: number | null; error: string | null } {
  const t = text.trim();
  if (!t) return { value: null, error: '请录入测量值' };
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(t)) return { value: null, error: '数值不完整，请重新录入' };
  const v = Number(t);
  if ((hasNum(p.min_valid) && v < p.min_valid) || (hasNum(p.max_valid) && v > p.max_valid)) {
    return { value: null, error: `超出合理范围（${validText(p)}），可能录错了，请复测后重新录入` };
  }
  return { value: v, error: null };
}

interface NumProps {
  param: SpecParam;
  sound: boolean;
  /** 数值变化（每次按键同步，供提交时读取） */
  onValue: (code: string, v: number | null) => void;
  /** 回车且校验通过：跳到下一项（或提交） */
  onDone: (el: HTMLElement) => void;
  /** 扫码枪把条码扫进了测量框（出现字母）/ 按 Esc：把焦点交回扫码框 */
  onEscape: () => void;
  register: (code: string, api: FieldApi | null) => void;
}

/** 数值测试项录入框 */
export function NumField({ param: p, sound, onValue, onDone, onEscape, register }: NumProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const code = p.code!;

  useEffect(() => {
    register(code, { focus: () => focusField(ref.current), setError });
    return () => register(code, null);
  }, [code, register]);

  const v = text.trim() && /^-?(\d+(\.\d+)?|\.\d+)$/.test(text.trim()) ? Number(text) : null;
  const ok = inSpec(p, v);

  const change = (t: string) => {
    setText(t);
    setError(null);
    const n = t.trim() && /^-?(\d+(\.\d*)?|\.\d+)$/.test(t.trim()) ? Number(t) : null;
    onValue(code, n === null || Number.isNaN(n) ? null : n);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const r = checkValue(p, el.value);
      if (r.error) {
        setError(r.error);
        beep('error', sound);
        el.select();
        return;
      }
      setError(null);
      onValue(code, r.value);
      onDone(el);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (/[0-9.\-]/.test(e.key)) {
      const s = el.selectionStart ?? el.value.length;
      const en = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, s) + e.key + el.value.slice(en);
      if (!allowPartial(p, next)) {
        e.preventDefault();
        setError(
          e.key === '.' && el.value.includes('.')
            ? '只能有一个小数点'
            : e.key === '.' && p.decimals === 0
              ? '本项只能录入整数'
              : e.key === '-'
                ? '负号只能在最前面'
                : hasNum(p.decimals)
                  ? `最多 ${p.decimals} 位小数`
                  : '数值过长',
        );
      }
      return;
    }
    // 字母等：多半是扫码枪把条码扫进了测量框 → 焦点交回扫码框（本次按键随之进入扫码框）
    if (/[A-Za-z(\]]/.test(e.key)) {
      onEscape();
      return;
    }
    e.preventDefault();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text').trim();
    e.preventDefault();
    if (allowPartial(p, t)) change(t);
    else setError('粘贴的内容不是有效数值');
  };

  return (
    <div className={`station-param${error ? ' err' : ok === true ? ' ok' : ok === false ? ' ng' : ''}`}>
      <div className="sp-head">
        <b className="sp-name">{p.name}</b>
        {ok !== null && !error && <b style={{ color: ok ? '#389e0d' : '#cf1322' }}>{ok ? '✓ 合格' : '✗ 超差'}</b>}
      </div>
      <div className="sp-spec">
        规格 <b>{specText(p)}</b>
        {hasNum(p.target) ? `（目标 ${num(p.target)}）` : ''}
      </div>
      <div className="sp-input">
        <input
          ref={ref}
          data-sfield={code}
          className="sp-num"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="测量值"
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={(e) => e.currentTarget.select()}
        />
        {p.unit && <span className="sp-unit">{p.unit}</span>}
      </div>
      <div className="sp-err" role="alert">{error ?? ''}</div>
    </div>
  );
}

interface OkNgProps {
  param: SpecParam;
  sound: boolean;
  onValue: (code: string, v: number | null) => void;
  onDone: (el: HTMLElement) => void;
  onEscape: () => void;
  register: (code: string, api: FieldApi | null) => void;
}

/** OK/NG 判定型测试项：大按钮点选，或键盘 1 = OK、0 = NG（选后自动跳到下一项） */
export function OkNgField({ param: p, sound, onValue, onDone, onEscape, register }: OkNgProps) {
  const [v, setV] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const code = p.code!;

  useEffect(() => {
    register(code, { focus: () => focusField(ref.current), setError });
    return () => register(code, null);
  }, [code, register]);

  const choose = (n: number) => {
    setV(n);
    setError(null);
    onValue(code, n);
    if (ref.current) onDone(ref.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '1' || e.key === '+') {
      e.preventDefault();
      choose(1);
    } else if (e.key === '0' || e.key === '-') {
      e.preventDefault();
      choose(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (v === null) {
        setError('请判定：按 1 = OK，按 0 = NG');
        beep('error', sound);
      } else onDone(e.currentTarget);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    } else if (/^[A-Za-z(\]]$/.test(e.key)) {
      onEscape();
    } else if (e.key.length === 1) e.preventDefault();
  };

  return (
    <div className={`station-param${error ? ' err' : v === 1 ? ' ok' : v === 0 ? ' ng' : ''}`}>
      <div className="sp-head">
        <b className="sp-name">{p.name}</b>
        {v !== null && <b style={{ color: v === 1 ? '#389e0d' : '#cf1322' }}>{v === 1 ? '✓ 合格' : '✗ 不合格'}</b>}
      </div>
      <div className="sp-spec">OK / NG 判定（键盘 1 = OK，0 = NG）</div>
      <div className="sp-okng">
        <input
          ref={ref}
          data-sfield={code}
          readOnly
          className="sp-okng-val"
          value={v === null ? '' : v === 1 ? 'OK' : 'NG'}
          placeholder="待判定"
          onKeyDown={onKeyDown}
        />
        <button type="button" tabIndex={-1} className={`sp-btn ok${v === 1 ? ' on' : ''}`} onClick={() => choose(1)}>OK</button>
        <button type="button" tabIndex={-1} className={`sp-btn ng${v === 0 ? ' on' : ''}`} onClick={() => choose(0)}>NG</button>
      </div>
      <div className="sp-err" role="alert">{error ?? ''}</div>
    </div>
  );
}

interface KeyPartProps {
  label: string;
  sound: boolean;
  /** 校验批号：返回错误文字或 null */
  check: (lot: string) => Promise<string | null>;
  onValue: (lot: string) => void;
  onDone: (el: HTMLElement) => void;
  register: (code: string, api: FieldApi | null) => void;
}

/** 关键件批号（扫码后即时校验；扫错清空并把错误贴在框下，C-F15） */
export function KeyPartField({ label, sound, check, onValue, onDone, register }: KeyPartProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [okLot, setOkLot] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    register('__key_part__', { focus: () => focusField(ref.current), setError });
    return () => register('__key_part__', null);
  }, [register]);

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const raw = el.value.trim();
    // 支持直接扫 GS1/UDI：取 (10) 批号
    const m = raw.match(/\(10\)([^()]+)/);
    const lot = (m ? m[1] : raw).trim();
    if (!lot) {
      setError('请扫描关键件批号');
      beep('error', sound);
      return;
    }
    setBusy(true);
    try {
      const msg = await check(lot);
      if (msg) {
        setError(msg);
        setText('');
        setOkLot(null);
        onValue('');
        beep('error', sound);
        el.focus();
        return;
      }
      setError(null);
      setText(lot);
      setOkLot(lot);
      onValue(lot);
      onDone(el);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`station-param wide${error ? ' err' : okLot ? ' ok' : ''}`}>
      <div className="sp-head">
        <b className="sp-name">关键件：{label}</b>
        {okLot && !error && <b style={{ color: '#389e0d' }}>✓ 已核对</b>}
      </div>
      <div className="sp-spec">扫描批号（须为本工单已领用的批次）</div>
      <div className="sp-input">
        <input
          ref={ref}
          data-sfield="__key_part__"
          className="sp-num"
          autoComplete="off"
          spellCheck={false}
          placeholder="扫描关键件批号"
          value={text}
          readOnly={busy}
          onChange={(e) => {
            setText(e.target.value);
            setOkLot(null);
            setError(null);
            onValue('');
          }}
          onKeyDown={onKeyDown}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <div className="sp-err" role="alert">{error ?? ''}</div>
    </div>
  );
}

export const paramIsOkNg = isOkNg;
