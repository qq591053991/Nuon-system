import { Input, type InputRef } from 'antd';
import { ScanOutlined } from '@ant-design/icons';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { parseScan, type ScanResult } from '../utils/scan';

export interface ScanInputHandle {
  focus: () => void;
  clear: () => void;
}

interface Props {
  /** 扫码/回车回调；返回 Promise 时等待完成后再清空并回焦（便于串行处理） */
  onScan: (code: string, parsed: ScanResult) => unknown;
  placeholder?: string;
  autoFocus?: boolean;
  /** 页面上没有其他输入框获得焦点时，把扫码枪的输入转交给本框（防止焦点丢失后无声丢码） */
  captureGlobal?: boolean;
  size?: 'large' | 'middle' | 'small';
  disabled?: boolean;
  style?: CSSProperties;
  prefix?: ReactNode;
  /** onScan 完成后是否回焦到扫码框（默认 true；若 onScan 期间焦点已被移到其他输入框，则不抢回） */
  refocus?: boolean;
}

const isEditable = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);

/**
 * 扫码输入框（扫码枪 = 键入 + 回车）：
 * - 回车触发 onScan（自动解析 UDI / GS1 原始串，parsed.sn、parsed.lot 可直接用），完成后清空并重新聚焦；
 * - 处理失败也清空，避免下一枪“串码”；
 * - captureGlobal：焦点不在任何输入框时，快速连续的按键（扫码枪）会被转入本框。
 */
const ScanInput = forwardRef<ScanInputHandle, Props>(function ScanInput(
  { onScan, placeholder = '扫描或输入条码后回车', autoFocus = true, captureGlobal = false, size = 'large', disabled, style, prefix, refocus = true },
  ref,
) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const buffer = useRef<{ text: string; last: number }>({ text: '', last: 0 });

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus(), clear: () => setValue('') }), []);

  // 始终调用最新的 onScan / busy（全局键盘监听只注册一次，不能闭包住旧回调）
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const busyRef = useRef(false);

  const fire = async (text: string) => {
    const code = text.trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onScanRef.current(parseScan(code).code, parseScan(code));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setValue('');
      setTimeout(() => {
        const el = inputRef.current?.input;
        const active = document.activeElement;
        // 业务代码已把焦点移到别的输入框（如扫码后跳到第一个测量框）时不抢回
        if (refocus && (!isEditable(active) || active === el)) inputRef.current?.focus();
      }, 0);
    }
  };

  useEffect(() => {
    if (!captureGlobal) return;
    const onKey = (e: KeyboardEvent) => {
      if (disabled || isEditable(document.activeElement) || e.ctrlKey || e.altKey || e.metaKey) return;
      const now = Date.now();
      const b = buffer.current;
      if (now - b.last > 80) b.text = ''; // 扫码枪字符间隔通常 < 50ms
      b.last = now;
      if (e.key === 'Enter') {
        if (b.text.length >= 3) {
          e.preventDefault();
          const t = b.text;
          b.text = '';
          fire(t);
        }
        return;
      }
      if (e.key.length === 1) b.text += e.key;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureGlobal, disabled, busy]);

  return (
    <Input
      ref={inputRef}
      size={size}
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPressEnter={(e) => { e.preventDefault(); fire(value); }}
      placeholder={placeholder}
      prefix={prefix ?? <ScanOutlined style={{ color: '#5b3cc4' }} />}
      allowClear
      autoComplete="off"
      style={style}
    />
  );
});

export default ScanInput;
