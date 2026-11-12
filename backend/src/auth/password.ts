import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { config } from '../config';

export const hashPassword = (pw: string) => bcrypt.hashSync(pw, config.bcryptRounds);
/** 异步哈希（分片计算、不阻塞事件循环）：批量开户等一次要算很多个哈希时使用 */
export const hashPasswordAsync = (pw: string) => bcrypt.hash(pw, config.bcryptRounds);
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

/** 临时密码字符集：去掉易混淆的 0/O、1/l/I */
const PW_LETTERS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const PW_DIGITS = '23456789';

/** 生成符合密码策略的随机临时密码（管理员新建/重置时一次性显示，用户首次登录须修改） */
export function generateTempPassword(length = Math.max(config.passwordMinLength, 10)): string {
  const all = PW_LETTERS + PW_DIGITS;
  const chars = [PW_LETTERS[randomInt(PW_LETTERS.length)], PW_DIGITS[randomInt(PW_DIGITS.length)]];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 生成随机工位 PIN（4 位数字，不全相同） */
export function generatePin(length = 4): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < length; i++) s += String(randomInt(10));
    if (!/^(\d)\1+$/.test(s)) return s;
  }
}

/**
 * 是否须先修改密码（金蝶账号由金蝶管理，不判断）：
 *  - INITIAL：管理员新建/重置的密码，本人尚未修改（sys_user.must_change_password）；
 *  - EXPIRED：超过密码有效期。
 */
export function passwordChangeReason(u: {
  auth_source?: string | null;
  password_changed_at?: Date | null;
  must_change_password?: boolean | null;
}): 'INITIAL' | 'EXPIRED' | null {
  if (u.auth_source === 'KINGDEE') return null;
  if (u.must_change_password) return 'INITIAL';
  return passwordExpired(u) ? 'EXPIRED' : null;
}
