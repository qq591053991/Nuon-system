/**
 * 演示账号与“演示模式”判断（评审 E-02）：
 *  - 演示初始化（npm run seed -- --demo）预置 14 个岗位账号，密码均为公开的演示密码；
 *  - 演示模式：环境变量 DEMO_MODE=1 强制开启、DEMO_MODE=0 强制关闭；未设置时自动判断——
 *    仍有启用状态的预置演示账号在使用公开演示密码即为演示模式（登录页据此显示“演示账号”下拉）。
 *  - 生产初始化（npm run seed，无 --demo）只建 admin，且首次登录强制改密，不会进入演示模式。
 * 校验演示密码需要 bcrypt 比对，按密码哈希缓存结果（同一批预置账号共用一个哈希，只算一次）。
 */
import type { User } from '@prisma/client';
import { config } from '../config';
import type { PrismaService } from '../common/prisma.service';
import { verifyPassword } from './password';

export const DEMO_PASSWORD = 'Nuon@2026';

/** 预置演示账号：[账号, 姓名, 角色, 部门] */
export const DEMO_USERS: [string, string, string, string][] = [
  ['admin', '系统管理员', 'admin', '信息部'], ['manager', '王厂长', 'manager', '总经办'],
  ['sales', '李销售', 'sales', '销售部'], ['buyer', '陈采购', 'purchaser', '采购部'],
  ['pmc', '周计划', 'planner', 'PMC'], ['engineer', '吴工艺', 'engineer', '工程部'],
  ['wh', '郑仓管', 'warehouse', '仓储部'], ['op1', '刘操作', 'operator', '生产部'], ['op2', '黄操作', 'operator', '生产部'],
  ['qc', '孙质检', 'qc', '品质部'], ['qa', '赵QA', 'qa', '品质部'], ['finance', '钱财务', 'finance', '财务部'],
  ['leader', '赵班长', 'leader', '生产部'], ['station1', '总装线工位终端', 'station', '生产部'],
];
export const DEMO_USERNAMES = DEMO_USERS.map(([u]) => u);

const hashCache = new Map<string, boolean>();

/** 该密码哈希是否就是公开的演示密码（按哈希缓存） */
export function isDemoPasswordHash(hash: string | null | undefined): boolean {
  if (!hash || hash.startsWith('!')) return false;
  let v = hashCache.get(hash);
  if (v === undefined) {
    v = verifyPassword(DEMO_PASSWORD, hash);
    if (hashCache.size > 500) hashCache.clear();
    hashCache.set(hash, v);
  }
  return v;
}

/** 仍在使用公开演示密码的预置演示账号（按 id 排序；只检查系统预置的演示账号，避免逐个 bcrypt 比对全部用户） */
export async function demoPasswordUsers(db: PrismaService, opts: { activeOnly?: boolean } = {}): Promise<User[]> {
  const rows = await db.base.user.findMany({
    where: { auth_source: 'LOCAL', username: { in: DEMO_USERNAMES }, created_by: 'system', ...(opts.activeOnly ? { is_active: true } : {}) },
    orderBy: { id: 'asc' },
  });
  return rows.filter((u) => isDemoPasswordHash(u.password_hash));
}

/** 演示模式（登录页是否显示演示账号下拉） */
export async function isDemoMode(db: PrismaService): Promise<boolean> {
  const v = config.demoMode;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return (await demoPasswordUsers(db, { activeOnly: true })).length > 0;
}
