import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, TOKEN_KEY } from './api/http';

export interface CurrentUser {
  id: number;
  username: string;
  full_name: string;
  roles: string[];
  role_names: string[];
  department?: string;
  permissions: string[];
  /** LOCAL 本系统账号 / KINGDEE 金蝶云星空账号 */
  auth_source?: string;
  /** 工牌号（工位终端刷卡） */
  badge_no?: string | null;
  /** 本次会话的登录方式：password 密码 / badge 工位刷工牌 */
  login_method?: 'password' | 'badge';
  /** 须先修改密码（管理员设的初始/重置密码，或密码已过期；其他接口返回 403） */
  must_change_password?: boolean;
  /** 须改密原因：INITIAL 管理员设置的初始/重置密码；EXPIRED 已过期 */
  password_change_reason?: 'INITIAL' | 'EXPIRED' | null;
  /** 密码到期时间（ISO），到期前 7 天提醒 */
  password_expires_at?: string | null;
}

/** 记住上次登录的账号（登录页预填） */
export const LAST_USER_KEY = 'nuon_last_username';

/**
 * 刚登录时输入的密码，只保存在内存中（刷新页面即丢失），用于强制改密时免去再输一次原密码。
 * 改密完成或读取一次后清除。
 */
let loginPassword: string | null = null;
export const peekLoginPassword = () => loginPassword;
export const clearLoginPassword = () => {
  loginPassword = null;
};

/** 密码还有几天到期（未设置返回 null；已过期返回 ≤0） */
export function passwordDaysLeft(u: CurrentUser | null): number | null {
  if (!u?.password_expires_at) return null;
  const ms = new Date(u.password_expires_at).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/** 登录 / 工牌登录接口的响应 */
export interface LoginResult {
  access_token: string;
  token_type: string;
  user: CurrentUser;
  must_change_password?: boolean;
}

interface AuthCtx {
  user: CurrentUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<CurrentUser>;
  /** 工位终端刷工牌登录（工牌号 + PIN），成功后切换为该用户的会话 */
  badgeLogin: (badge_no: string, pin: string) => Promise<CurrentUser>;
  /** 重新读取当前用户（如修改密码后） */
  refresh: () => Promise<CurrentUser | null>;
  logout: () => void;
  /** 是否拥有任一权限点 */
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      setLoading(false);
      return;
    }
    get<CurrentUser>('/auth/me', undefined, true)
      .then(setUser)
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setLoading(false));
  }, []);

  const apply = useCallback((r: LoginResult) => {
    localStorage.setItem(TOKEN_KEY, r.access_token);
    setUser(r.user);
    return r.user;
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await post<LoginResult>('/auth/login', { username, password });
    try {
      localStorage.setItem(LAST_USER_KEY, username.trim());
    } catch {
      /* 存储不可用时不记住 */
    }
    loginPassword = r.user.must_change_password ? password : null;
    return apply(r);
  }, [apply]);

  const badgeLogin = useCallback(async (badge_no: string, pin: string) => apply(await post<LoginResult>('/auth/badge-login', { badge_no, pin })), [apply]);

  const refresh = useCallback(async () => {
    const u = await get<CurrentUser>('/auth/me', undefined, true).catch(() => null);
    if (u) setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    loginPassword = null;
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    location.href = '/login';
  }, []);

  const can = useCallback((...perms: string[]) => !!user && perms.some((p) => user.permissions.includes(p)), [user]);

  return <Ctx.Provider value={{ user, loading, login, badgeLogin, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
