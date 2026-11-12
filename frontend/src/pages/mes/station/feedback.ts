/**
 * 工位结果反馈（C-F18）：整屏闪色 + 提示音，1 米外也能看清/听清。
 * 直接操作 DOM，不触发 React 重新渲染（工位录入期间避免任何多余的重渲染，见 C-F01）。
 */
export type Feedback = 'pass' | 'fail' | 'error' | 'warn';

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx ||= new AC();
    if (ctx!.state === 'suspended') ctx!.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** 一组音：[频率 Hz, 时长 ms] */
function tones(seq: [number, number][], volume = 0.25) {
  const ac = audio();
  if (!ac) return;
  let t = ac.currentTime;
  for (const [f, ms] of seq) {
    if (f > 0) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(volume, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + ms / 1000);
    }
    t += ms / 1000 + 0.04;
  }
}

const SOUNDS: Record<Feedback, [number, number][]> = {
  pass: [[1320, 90], [1760, 120]],
  fail: [[220, 600]],
  error: [[330, 140], [0, 40], [330, 140], [0, 40], [330, 140]],
  warn: [[880, 160]],
};

const COLORS: Record<Feedback, string> = { pass: 'rgba(56,158,13,.55)', fail: 'rgba(207,19,34,.6)', error: 'rgba(207,19,34,.45)', warn: 'rgba(250,173,20,.45)' };

export function beep(kind: Feedback, enabled = true) {
  if (enabled) tones(SOUNDS[kind]);
}

/** 整屏闪色（约 0.7 秒淡出） */
export function flash(kind: Feedback) {
  try {
    const el = document.createElement('div');
    el.setAttribute('data-station-flash', kind);
    el.style.cssText = `position:fixed;inset:0;z-index:3000;pointer-events:none;background:${COLORS[kind]};transition:opacity .7s ease-out;opacity:1`;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '0')));
    setTimeout(() => el.remove(), 800);
  } catch {
    /* 忽略 */
  }
}

export function feedback(kind: Feedback, sound = true) {
  flash(kind);
  beep(kind, sound);
}
