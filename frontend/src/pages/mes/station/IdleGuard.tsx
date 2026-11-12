/**
 * 空闲自动锁定（C-F13）：倒计时状态只在本组件内部变化，**不会**让工位主界面每秒重渲染（C-F01 的诱因之一）。
 * 剩 30 秒时全屏提示 + 提示音，触摸屏幕或按任意键即继续作业。
 */
import { LockOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { beep } from './feedback';

const WARN_SECONDS = 30;

interface Props {
  /** 是否启用（锁定中不计时） */
  active: boolean;
  minutes: number;
  sound: boolean;
  /** 最近操作时间（ms），用于刷新页面后恢复计时 */
  initialLast?: number;
  onLock: () => void;
  /** 记录最近操作时间（约每 5 秒一次，写入本终端会话） */
  onPersist: (last: number) => void;
}

export default function IdleGuard({ active, minutes, sound, initialLast, onLock, onPersist }: Props) {
  const [left, setLeft] = useState<number | null>(null);
  const last = useRef<number>(initialLast ?? Date.now());
  const cb = useRef({ onLock, onPersist, sound });
  cb.current = { onLock, onPersist, sound };

  useEffect(() => {
    if (!active) {
      setLeft(null);
      return;
    }
    last.current = Date.now();
    const onActive = () => {
      last.current = Date.now();
    };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    evs.forEach((ev) => window.addEventListener(ev, onActive, { capture: true, passive: true }));
    let persisted = 0;
    let shown: number | null = null;
    const timer = setInterval(() => {
      const idle = Date.now() - last.current;
      const limit = minutes * 60_000;
      if (idle >= limit) {
        shown = null;
        setLeft(null);
        cb.current.onLock();
        return;
      }
      const remain = idle >= limit - WARN_SECONDS * 1000 ? Math.ceil((limit - idle) / 1000) : null;
      // 只在显示值变化时 setState（且只重渲染本组件）
      if (remain !== shown) {
        if (remain !== null && (shown === null || remain % 10 === 0 || remain <= 5)) beep('warn', cb.current.sound);
        shown = remain;
        setLeft(remain);
      }
      if (Date.now() - persisted > 5000) {
        persisted = Date.now();
        cb.current.onPersist(last.current);
      }
    }, 1000);
    return () => {
      evs.forEach((ev) => window.removeEventListener(ev, onActive, { capture: true }));
      clearInterval(timer);
    };
  }, [active, minutes]);

  if (left === null) return null;
  return (
    <div
      className="station-idle"
      role="alertdialog"
      aria-label="即将自动锁定"
      onPointerDown={() => {
        last.current = Date.now();
        setLeft(null);
      }}
    >
      <div className="station-idle-box">
        <LockOutlined style={{ fontSize: 64 }} />
        <div className="station-idle-num">{left}</div>
        <div className="station-idle-title">秒后自动锁定终端</div>
        <div className="station-idle-sub">触摸屏幕或按任意键继续作业；锁定后已扫的产品和已录的数据会保留，本人刷工牌即可继续</div>
      </div>
    </div>
  );
}
