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
}

interface AuthCtx {
  user: CurrentUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
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

  const login = useCallback(async (username: string, password: string) => {
    const r = await post('/auth/login', { username, password });
    localStorage.setItem(TOKEN_KEY, r.access_token);
    setUser(r.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    location.href = '/login';
  }, []);

  const can = useCallback((...perms: string[]) => !!user && perms.some((p) => user.permissions.includes(p)), [user]);

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
