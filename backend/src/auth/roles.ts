/** 权限点与角色定义 */
export const PERMISSIONS: Record<string, string> = {
  master: '主数据维护（客户/供应商/物料/仓库/设备）',
  engineering: '工程数据（BOM/工艺路线）编制与提交',
  sales: '销售订单与发货申请',
  purchase: '采购订单',
  plan: '生产计划（MRP/工单）',
  wms: '仓储作业（收货/领料/发货/调拨/盘点）',
  mes: '车间报工（工位过站/测试数据录入）',
  qc: '质量检验（IQC/FQC、开具NCR）',
  qa: '质量保证（NCR评审处置、CAPA、产品放行、BOM/工艺批准）',
  finance: '财务（应收应付、收付款）',
  admin: '系统管理（用户、权限、审计）',
};

/**
 * 角色 → 权限点。职责分离（GMP / ISO 13485）：
 *  - admin 只管账号、权限与审计，不含任何业务写权限（所有登录用户都可查看业务数据）；
 *  - manager 可做各业务操作，但不含 qa —— 质量签名（产品放行、NCR 处置、让步接收、CAPA 关闭、BOM/工艺批准）只能由 QA 角色完成。
 */
export const ROLES: Record<string, { name: string; perms: string[] }> = {
  admin: { name: '系统管理员', perms: ['admin'] },
  manager: { name: '厂长/管理层', perms: Object.keys(PERMISSIONS).filter((p) => p !== 'admin' && p !== 'qa') },
  sales: { name: '销售/客服', perms: ['sales'] },
  purchaser: { name: '采购', perms: ['purchase'] },
  planner: { name: 'PMC 计划', perms: ['plan', 'sales'] },
  engineer: { name: '工艺/研发工程师', perms: ['engineering', 'master'] },
  warehouse: { name: '仓管员', perms: ['wms'] },
  operator: { name: '产线操作员', perms: ['mes'] },
  qc: { name: '质检员', perms: ['qc'] },
  qa: { name: '质量工程师/QA', perms: ['qa', 'qc'] },
  finance: { name: '财务', perms: ['finance'] },
};

export const roleList = (roles: string | null | undefined) => String(roles || '').split(',').filter(Boolean);

export function userPermissions(user: { roles: string }): Set<string> {
  const s = new Set<string>();
  for (const r of roleList(user.roles)) for (const p of ROLES[r]?.perms ?? []) s.add(p);
  return s;
}
