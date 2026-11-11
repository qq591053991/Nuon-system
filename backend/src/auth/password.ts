import * as bcrypt from 'bcryptjs';
import { config } from '../config';

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, config.bcryptRounds);
export const verifyPassword = (pw: string, hash: string) => {
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
};

/** 密码策略说明（登录页/改密弹窗提示用） */
export function passwordPolicyText() {
  return `至少 ${config.passwordMinLength} 位${config.passwordRequireLetterDigit ? '，且须同时包含字母和数字' : ''}`;
}

/** 校验密码复杂度：不符合返回中文提示，符合返回 null */
export function checkPasswordPolicy(pw: string | null | undefined): string | null {
  const s = pw ?? '';
  if (s.length < config.passwordMinLength || (config.passwordRequireLetterDigit && !(/[A-Za-z]/.test(s) && /\d/.test(s)))) {
    return `密码不符合安全策略：${passwordPolicyText()}`;
  }
  return null;
}

/** 本地密码是否已过期（金蝶账号的密码由金蝶管理，不在此判断）；未记录修改时间视为已过期 */
export function passwordExpiresAt(u: { auth_source?: string | null; password_changed_at?: Date | null }): Date | null {
  if (config.passwordMaxAgeDays <= 0 || u.auth_source === 'KINGDEE' || !u.password_changed_at) return null;
  return new Date(u.password_changed_at.getTime() + config.passwordMaxAgeDays * 86_400_000);
}

export function passwordExpired(u: { auth_source?: string | null; password_changed_at?: Date | null }): boolean {
  if (config.passwordMaxAgeDays <= 0 || u.auth_source === 'KINGDEE') return false;
  if (!u.password_changed_at) return true;
  return passwordExpiresAt(u)!.getTime() <= Date.now();
}

/** 工位 PIN：4–8 位数字 */
export const PIN_PATTERN = /^\d{4,8}$/;
