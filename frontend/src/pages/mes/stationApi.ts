/**
 * 工位终端专用接口与会话（评审 P0-4：车间共用终端，刷工牌切换当前操作员）。
 *
 * - 操作员刷工牌 + PIN 登录（POST /auth/badge-login），令牌只保存在本终端自己的键 nuon_station_session 中，
 *   不覆盖办公端登录令牌（localStorage 'nuon_token'）。
 * - 工位上的扫码、报工、返工换件等请求一律显式携带操作员令牌（独立 axios 实例，不经过全局拦截器），
 *   因此每条记录都归属到实际刷卡的操作员。
 */
import axios from 'axios';
import type { Rec } from '../../api/http';

export const LS_STATION_SESSION = 'nuon_station_session';
export const LS_STATION_IDLE = 'nuon_station_idle_minutes';
/** 默认空闲自动锁定时间（分钟） */
export const DEFAULT_IDLE_MINUTES = 5;

export interface StationOperator {
  id: number;
  username: string;
  full_name: string;
  department?: string | null;
  roles?: string[];
  role_names?: string[];
  permissions: string[];
}

export interface StationSession {
  token: string;
  user: StationOperator;
  /** 登录时间（ms） */
  since: number;
  /** 最近一次操作时间（ms），用于刷新页面后判断是否已超过空闲时间 */
  last: number;
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

export function loadIdleMinutes(): number {
  const n = Number(ls.get(LS_STATION_IDLE));
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 240) : DEFAULT_IDLE_MINUTES;
}

export function saveIdleMinutes(n: number) {
  ls.set(LS_STATION_IDLE, String(n));
}

/** 读取操作员会话；已超过空闲时间的会话视为失效（终端必须重新刷卡） */
export function loadSession(idleMinutes: number): StationSession | null {
  try {
    const s = JSON.parse(ls.get(LS_STATION_SESSION) || 'null') as StationSession | null;
    if (!s?.token || !s.user) return null;
    if (Date.now() - (s.last || 0) >= idleMinutes * 60_000) {
      ls.set(LS_STATION_SESSION, null);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: StationSession | null) {
  ls.set(LS_STATION_SESSION, s ? JSON.stringify(s) : null);
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

/** 请求状态码（网络错误为 0） */
export const httpStatus = (e: any): number => e?.response?.status ?? 0;
