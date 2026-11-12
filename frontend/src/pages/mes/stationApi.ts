/**
 * 工位终端专用接口、会话与终端配置（评审 P0-4：车间共用终端，刷工牌切换当前操作员）。
 *
 * - 操作员刷工牌 + PIN 登录（POST /auth/badge-login），令牌只保存在本终端自己的键 nuon_station_session 中，
 *   不覆盖办公端登录令牌（localStorage 'nuon_token'）。
 * - 工位上的扫码、报工、返工换件等请求一律显式携带操作员令牌（独立 axios 实例，不经过全局拦截器），
 *   因此每条记录都归属到实际刷卡的操作员。
 * - 空闲锁定（C-F13）：会话保留但标记 locked，同一操作员同一班次回来只需刷工牌（服务端核对工牌），未提交数据保留。
 * - 终端配置（C-F08）：本工位工序、默认设备、空闲锁定时间、无测试项工序的过站方式——由班组长（终端账号密码）设定。
 */
import axios from 'axios';
import type { Rec } from '../../api/http';

export const LS_STATION_SESSION = 'nuon_station_session';
export const LS_STATION_CONFIG = 'nuon_station_config';
/** 旧版本的空闲时间设置（迁移用） */
export const LS_STATION_IDLE = 'nuon_station_idle_minutes';
/** 默认空闲自动锁定时间（分钟） */
export const DEFAULT_IDLE_MINUTES = 5;
/** 同一班次：登录后多长时间内，空闲锁定可只刷工牌恢复（小时） */
export const SHIFT_HOURS = 10;

export interface StationOperator {
  id: number;
  username: string;
  full_name: string;
  department?: string | null;
  badge_no?: string | null;
  roles?: string[];
  role_names?: string[];
  permissions: string[];
  /** PIN 由管理员生成 / 重置：首次使用须本人重设 */
  must_change_pin?: boolean;
}

export interface StationSession {
  token: string;
  user: StationOperator;
  /** 登录时间（ms） */
  since: number;
  /** 最近一次操作时间（ms），用于刷新页面后判断是否已超过空闲时间 */
  last: number;
  /** 空闲锁定中：本人刷工牌即可恢复 */
  locked?: boolean;
}

/** 无测试项工序的过站方式：confirm = 扫码后按回车（或再扫一次）确认；scan = 扫码即过站 */
export type PassMode = 'confirm' | 'scan';

export interface StationConfig {
  /** 本工位工序编码（必须由班组长设定） */
  op_code?: string;
  op_name?: string;
  op_type?: string;
  work_center_id?: number | null;
  /** 默认设备/仪器 */
  equipment_id?: number | null;
  idle_minutes: number;
  pass_mode: PassMode;
  sound: boolean;
  set_by?: string;
  set_at?: number;
}

const ls = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* 浏览器禁止存储时忽略 */
    }
  },
};

const clampIdle = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.round(v), 60) : DEFAULT_IDLE_MINUTES;
};

export function loadConfig(): StationConfig {
  let c: Partial<StationConfig> = {};
  try {
    c = JSON.parse(ls.get(LS_STATION_CONFIG) || '{}') || {};
  } catch {
    c = {};
  }
  return {
    ...c,
    idle_minutes: clampIdle(c.idle_minutes ?? ls.get(LS_STATION_IDLE)),
    pass_mode: c.pass_mode === 'scan' ? 'scan' : 'confirm',
    sound: c.sound !== false,
  };
}

export function saveConfig(c: StationConfig) {
  ls.set(LS_STATION_CONFIG, JSON.stringify(c));
}

/** 读取操作员会话；超过空闲时间的会话转为“锁定”（同一班次本人刷卡恢复），超过一个班次则作废 */
export function loadSession(idleMinutes: number): StationSession | null {
  try {
    const s = JSON.parse(ls.get(LS_STATION_SESSION) || 'null') as StationSession | null;
    if (!s?.token || !s.user) return null;
    if (Date.now() - (s.since || 0) >= SHIFT_HOURS * 3600_000) {
      ls.set(LS_STATION_SESSION, null);
      return null;
    }
    if (!s.locked && Date.now() - (s.last || 0) >= idleMinutes * 60_000) return { ...s, locked: true };
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: StationSession | null) {
  ls.set(LS_STATION_SESSION, s ? JSON.stringify(s) : null);
}

/** 本终端记住的各工牌 PIN 位数：输满即自动提交（C-F12；首次登录需按确认） */
const LS_PIN_LEN = 'nuon_station_pin_len';
export function pinLength(badge: string): number | null {
  try {
    const m = JSON.parse(ls.get(LS_PIN_LEN) || '{}');
    const n = Number(m[badge.trim().toUpperCase()]);
    return n >= 4 && n <= 8 ? n : null;
  } catch {
    return null;
  }
}
export function rememberPinLength(badge: string, n: number) {
  try {
    const m = JSON.parse(ls.get(LS_PIN_LEN) || '{}') || {};
    m[badge.trim().toUpperCase()] = n;
    ls.set(LS_PIN_LEN, JSON.stringify(m));
  } catch {
    /* 忽略 */
  }
}

/** 独立的 axios 实例：不带办公端令牌，401 不跳转登录页（由工位终端自行锁定） */
const stationHttp = axios.create({ baseURL: '/api', timeout: 60000 });

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

export async function badgeLogin(badge_no: string, pin: string): Promise<{ access_token: string; user: StationOperator }> {
  return (await stationHttp.post('/auth/badge-login', { badge_no, pin })).data;
}

export async function stationGet<T = any>(token: string, url: string, params?: Rec): Promise<T> {
  return (await stationHttp.get<T>(url, { ...auth(token), params })).data;
}

export async function stationPost<T = any>(token: string, url: string, body?: any): Promise<T> {
  return (await stationHttp.post<T>(url, body, auth(token))).data;
}

/** 下载文件（作业指导附件预览），返回 Blob */
export async function stationBlob(token: string, url: string): Promise<Blob> {
  return (await stationHttp.get(url, { ...auth(token), responseType: 'blob' })).data;
}

/** 请求状态码（网络错误为 0） */
export const httpStatus = (e: any): number => e?.response?.status ?? 0;
