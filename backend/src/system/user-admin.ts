/**
 * 用户管理的公共逻辑（用户与角色页面、批量操作、Excel 批量导入共用）：
 *  - 管理员新建/重置的本系统密码一律标记“下次登录须修改密码”（must_change_password），保证电子签名密码仅本人知晓；
 *  - 可由系统生成随机临时密码（只在本次响应中返回一次）；
 *  - 停用（离职）默认释放工牌、清除工位 PIN，工牌可直接分配给新人；
 *  - 工位 PIN 哈希直接写库，不进入审计内容（审计只记录“已设置/已重置/已清除”）。
 */
import type { User as DbUser } from '@prisma/client';
import { NO_LOCAL_PASSWORD } from '../auth/auth.service';
import { checkPasswordPolicy, generatePin, generateTempPassword, hashPasswordAsync, PIN_PATTERN } from '../auth/password';
import { ROLES } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { config } from '../config';
import { BizError } from '../common/errors';
import type { Tx } from '../common/prisma.service';

export const USERNAME_PATTERN = /^[\w.\-一-龥]+$/;

export function checkRoles(roles: string[]) {
  const bad = roles.filter((r) => !ROLES[r]);
  if (bad.length) throw new BizError(`未知角色：${bad.join(',')}（可选：${roleChoicesText()}）`);
}

export const roleChoicesText = () => Object.entries(ROLES).map(([code, r]) => `${r.name}(${code})`).join('、');

/** 角色别名：代码、中文名、中文名按“/”拆开的部分，以及常用叫法 */
const ROLE_ALIASES: Record<string, string> = {
  仓管: 'warehouse', 仓库: 'warehouse', 操作员: 'operator', 作业员: 'operator', 产线: 'operator', 质检: 'qc', 品检: 'qc', 工艺: 'engineer',
  工程师: 'engineer', 研发: 'engineer', 财务: 'finance', 会计: 'finance', 采购员: 'purchaser', 管理员: 'admin', 厂长: 'manager', 计划: 'planner',
  PMC: 'planner', 销售: 'sales', 客服: 'sales', 品保: 'qa',
};

function roleIndex(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [code, r] of Object.entries(ROLES)) {
    m.set(code.toLowerCase(), code);
    m.set(r.name.toLowerCase(), code);
    for (const part of r.name.split(/[/／\s]+/)) if (part) m.set(part.toLowerCase(), code);
  }
  for (const [k, v] of Object.entries(ROLE_ALIASES)) if (ROLES[v] && !m.has(k.toLowerCase())) m.set(k.toLowerCase(), v);
  return m;
}

/** 解析角色文本（逗号、顿号、分号、斜杠或空格分隔；中文名或代码均可）；无法识别时报错并列出可选值 */
export function parseRoles(text: string): string[] {
  const idx = roleIndex();
  const out: string[] = [];
  const bad: string[] = [];
  for (const raw of String(text || '').split(/[,，、;；\n]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const code = idx.get(s.toLowerCase()) ?? idx.get(s.replace(/\s+/g, '').toLowerCase());
    if (code) {
      if (!out.includes(code)) out.push(code);
    } else bad.push(s);
  }
  if (bad.length) throw new BizError(`无法识别的角色：${bad.join('、')}（可选：${roleChoicesText()}）`);
  return out;
}

/** 金蝶登录未启用时不能创建/切换为金蝶账号（否则用户登录时才报错） */
export function checkKingdeeEnabled() {
  if (!config.kingdee.enabled) {
    throw new BizError('金蝶云星空登录未启用，暂不能使用金蝶账号（需在服务器配置 KINGDEE_ENABLED=1、KINGDEE_URL、KINGDEE_ACCT_ID 后重启）；请先建本系统账号');
  }
}

export interface NewUserInput {
  username: string;
  full_name: string;
  roles: string[];
  department?: string | null;
  email?: string | null;
  is_active?: boolean;
  auth_source?: 'LOCAL' | 'KINGDEE';
  /** 初始密码；不填且 generate_password 为 true（或批量导入）时随机生成 */
  password?: string | null;
  generate_password?: boolean;
  /** 首次登录须修改密码（默认 true；仅系统集成/测试可显式关闭） */
  must_change_password?: boolean;
  badge_no?: string | null;
  pin?: string | null;
  /** 有工牌但未给 PIN 时随机生成 PIN（批量导入用） */
  generate_pin?: boolean;
}

export interface CreatedUser {
  user: DbUser;
  /** 系统生成的临时密码（仅本次返回） */
  temp_password: string | null;
  /** 系统生成的工位 PIN（仅本次返回） */
  temp_pin: string | null;
}

/** 工牌号唯一性 */
export async function checkBadge(tx: Tx, badge: string | null, selfId?: number) {
  if (!badge) return;
  const other = await tx.user.findUnique({ where: { badge_no: badge } });
  if (other && other.id !== selfId) {
    throw new BizError(`工牌号 ${badge} 已分配给用户 ${other.full_name}（${other.username}）${other.is_active ? '' : '（已停用账号，可先在其行内“释放工牌”或停用时勾选释放工牌）'}`);
  }
}

/** 设置工位 PIN：直接写库，PIN 哈希不进入审计追踪内容（dryRun = 预检查，不计算哈希） */
export async function setPin(tx: Tx, user: DbUser, pin: string, admin: CurrentUser, dryRun = false) {
  if (!PIN_PATTERN.test(pin)) throw new BizError('工位 PIN 须为 4–8 位数字');
  const hash = dryRun ? '!check' : await hashPasswordAsync(pin);
  await tx.$executeRaw`UPDATE "sys_user" SET "pin_hash" = ${hash} WHERE "id" = ${user.id}`;
  await tx.auditLog.create({
    data: {
      username: admin.username, full_name: admin.full_name, entity: 'sys_user', entity_id: user.id, action: 'UPDATE',
      changes: JSON.stringify({ pin: [user.pin_hash ? '已设置' : null, user.pin_hash ? '已重置' : '已设置'] }),
    },
  });
}

/** 清除工位 PIN（停用/离职） */
export async function clearPin(tx: Tx, user: DbUser, admin: CurrentUser) {
  if (!user.pin_hash) return;
  await tx.$executeRaw`UPDATE "sys_user" SET "pin_hash" = NULL WHERE "id" = ${user.id}`;
  await tx.auditLog.create({
    data: {
      username: admin.username, full_name: admin.full_name, entity: 'sys_user', entity_id: user.id, action: 'UPDATE',
      changes: JSON.stringify({ pin: ['已设置', '已清除'] }),
    },
  });
}

/** 新建用户（事务内）；dryRun = 预检查（批量导入），不计算密码哈希以加快速度，事务随后回滚 */
export async function createUserTx(tx: Tx, b: NewUserInput, admin: CurrentUser, dryRun = false): Promise<CreatedUser> {
  const username = (b.username || '').trim();
  const fullName = (b.full_name || '').trim();
  if (!username) throw new BizError('请填写登录账号');
  if (!USERNAME_PATTERN.test(username)) throw new BizError(`登录账号“${username}”只能包含中文、字母、数字、下划线、点、横线`);
  if (username.length > 64) throw new BizError('登录账号不能超过 64 个字符');
  if (!fullName) throw new BizError('请填写姓名');
  checkRoles(b.roles);
  const source = b.auth_source ?? 'LOCAL';
  const kingdee = source === 'KINGDEE';
  if (kingdee) checkKingdeeEnabled();
  let tempPassword: string | null = null;
  let password = b.password?.trim() || null;
  if (!kingdee) {
    if (!password) {
      if (!b.generate_password) throw new BizError('请设置初始密码（或点“生成临时密码”）');
      password = tempPassword = generateTempPassword();
    }
    const bad = checkPasswordPolicy(password);
    if (bad) throw new BizError(bad);
  }
  const badge = b.badge_no?.trim() || null;
  if (await tx.user.findUnique({ where: { username } })) throw new BizError(`用户名 ${username} 已存在`);
  await checkBadge(tx, badge);
  let pin = b.pin?.trim() || null;
  let tempPin: string | null = null;
  if (!pin && badge && b.generate_pin) pin = tempPin = generatePin();
  let u = await tx.user.create({
    data: {
      username, full_name: fullName, password_hash: kingdee ? NO_LOCAL_PASSWORD : dryRun ? '!check' : await hashPasswordAsync(password!), roles: b.roles.join(','),
      auth_source: source, password_changed_at: kingdee ? null : new Date(), must_change_password: !kingdee && b.must_change_password !== false,
      badge_no: badge, department: b.department?.trim() || null, email: b.email?.trim() || null, is_active: b.is_active ?? true, created_by: admin.username,
    },
  });
  if (pin) {
    await setPin(tx, u, pin, admin, dryRun);
    u = (await tx.user.findUnique({ where: { id: u.id } }))!;
  }
  return { user: u, temp_password: tempPassword, temp_pin: tempPin };
}

/** 重置密码（管理员）：本人下次登录须修改；不传密码则生成临时密码 */
export async function resetPasswordTx(tx: Tx, cur: DbUser, password: string | null | undefined, opts: { must_change_password?: boolean } = {}) {
  if (cur.auth_source === 'KINGDEE') throw new BizError(`${cur.full_name}（${cur.username}）使用金蝶云星空账号登录，请在金蝶中重置密码`);
  const pw = password?.trim() || generateTempPassword();
  const bad = checkPasswordPolicy(pw);
  if (bad) throw new BizError(bad);
  const u = await tx.user.update({
    where: { id: cur.id },
    data: {
      password_hash: await hashPasswordAsync(pw), password_changed_at: new Date(), must_change_password: opts.must_change_password !== false,
      failed_login_count: 0, locked_until: null,
    },
  });
  return { user: u, temp_password: password?.trim() ? null : pw };
}

/** 停用（离职）：默认释放工牌、清除 PIN、清除锁定 */
export async function deactivateTx(tx: Tx, cur: DbUser, admin: CurrentUser, releaseBadge = true) {
  if (cur.id === admin.id) throw new BizError('不能停用自己的账号');
  let u = await tx.user.update({
    where: { id: cur.id },
    data: { is_active: false, failed_login_count: 0, locked_until: null, ...(releaseBadge ? { badge_no: null } : {}) },
  });
  if (releaseBadge) {
    await clearPin(tx, cur, admin);
    u = (await tx.user.findUnique({ where: { id: cur.id } }))!;
  }
  return u;
}
