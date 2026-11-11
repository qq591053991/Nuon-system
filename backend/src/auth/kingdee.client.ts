/**
 * 金蝶云星空（K/3 Cloud）WebAPI 用户校验客户端。
 *
 * 调用标准接口：POST {KINGDEE_URL}Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc
 *   请求：{ acctID: 数据中心ID, username, password, lcid: 2052 }
 *   响应：{ LoginResultType: 1 表示成功, Message, Context: { UserId, UserName, ... }, ... }
 * 校验成功后立即调用 Logout 释放金蝶会话，避免占用金蝶在线用户/许可。
 * 本系统不保存金蝶密码。
 */
import { Logger } from '@nestjs/common';
import { config } from '../config';

export interface KingdeeResult {
  ok: boolean;
  /** 金蝶服务不可达/响应异常（区别于“账号或密码错误”） */
  unavailable?: boolean;
  message?: string;
  userId?: string;
  displayName?: string;
}

const VALIDATE = 'Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc';
const LOGOUT = 'Kingdee.BOS.WebApi.ServicesStub.AuthService.Logout.common.kdsvc';
const log = new Logger('Kingdee');

const base = () => (config.kingdee.url.endsWith('/') ? config.kingdee.url : `${config.kingdee.url}/`);

export async function kingdeeValidateUser(username: string, password: string): Promise<KingdeeResult> {
  const k = config.kingdee;
  if (!k.url || !k.acctId) return { ok: false, unavailable: true, message: '金蝶集成未配置（KINGDEE_URL / KINGDEE_ACCT_ID）' };
  let res: Response;
  try {
    res = await fetch(base() + VALIDATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acctID: k.acctId, username, password, lcid: k.lcid }),
      signal: AbortSignal.timeout(k.timeoutMs),
    });
  } catch (e) {
    log.warn(`无法连接金蝶云星空：${(e as Error).message}`);
    return { ok: false, unavailable: true, message: '无法连接金蝶云星空服务器，请稍后重试或联系管理员' };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, unavailable: true, message: `金蝶云星空返回异常（HTTP ${res.status}）` };
  }
  if (!res.ok) return { ok: false, unavailable: true, message: `金蝶云星空返回异常（HTTP ${res.status}）` };
  const ok = Number(body?.LoginResultType) === 1;
  if (ok) {
    // 释放会话（尽力而为，不影响登录结果）
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length) {
      fetch(base() + LOGOUT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies.map((c) => c.split(';')[0]).join('; ') },
        body: '{}',
        signal: AbortSignal.timeout(k.timeoutMs),
      }).catch(() => undefined);
    }
  }
  const ctx = body?.Context ?? {};
  return {
    ok,
    message: ok ? undefined : body?.Message || '金蝶账号或密码错误',
    userId: ctx.UserId !== undefined ? String(ctx.UserId) : undefined,
    displayName: ctx.UserName || undefined,
  };
}
