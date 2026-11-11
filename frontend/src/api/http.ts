import axios, { AxiosError } from 'axios';
import { message } from 'antd';

export type Rec = Record<string, any>;
export interface Page<T = Rec> { items: T[]; total: number; page: number; page_size: number }

export const TOKEN_KEY = 'nuon_token';

export const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.request.use((cfg) => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

http.interceptors.response.use(
  (r) => r,
  (err: AxiosError<any>) => {
    const status = err.response?.status;
    let detail = err.response?.data?.detail;
    if (Array.isArray(detail)) {
      // 参数校验错误（数组格式）
      detail = detail.map((d: any) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('；');
    }
    if (status === 401 && !location.pathname.startsWith('/login')) {
      localStorage.removeItem(TOKEN_KEY);
      location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    } else if (!(err.config as any)?.silent) {
      message.error(detail || err.message || '请求失败');
    }
    return Promise.reject(err);
  },
);

/** GET，返回 data */
export async function get<T = any>(url: string, params?: Rec, silent = false): Promise<T> {
  return (await http.get<T>(url, { params, silent } as any)).data;
}
export async function post<T = any>(url: string, body?: any, silent = false): Promise<T> {
  return (await http.post<T>(url, body, { silent } as any)).data;
}
export async function put<T = any>(url: string, body?: any): Promise<T> {
  return (await http.put<T>(url, body)).data;
}
export async function del<T = any>(url: string): Promise<T> {
  return (await http.delete<T>(url)).data;
}

/** 下载文件（带鉴权） */
export async function download(url: string, filename: string) {
  const r = await http.get(url, { responseType: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(r.data);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
