/**
 * 工作台/待办/搜索的跳转工具（G1）：
 *  - hasRoute(path)：该路径是否有页面（各组新页面还没上线时，自动退回到可用的旧页面）；
 *  - resolvePath(path)：目标页不存在时按 FALLBACK 退回；
 *  - canPath(path, can)：按菜单权限判断当前用户能否进入（快捷按钮、九宫格据此裁剪）；
 *  - useGo()：带筛选参数跳转。即使已在同一列表页，也会让页面按新的 URL 参数重新加载（MainLayout 读取 state.wb 作为 key）。
 */
import { useCallback } from 'react';
import { matchPath, useNavigate } from 'react-router-dom';
import { menu, routes, type MenuDef } from '../../routes';

const pathOnly = (p: string) => p.split('?')[0].split('#')[0] || '/';

export function hasRoute(path: string): boolean {
  const p = pathOnly(path);
  return routes.some((r) => !!matchPath({ path: r.path, end: true }, p));
}

/** 新页面未上线时的退路（目标页 → 现有页面） */
const FALLBACK: [prefix: string, to: string][] = [
  ['/purchase/chase', '/purchase/orders?status=APPROVED,PARTIAL_RECEIVED'],
  ['/wms/putaway', '/wms/stock?status=AVAILABLE'],
  ['/quality/supplier-returns', '/quality/ncrs'],
  ['/wms/pda/', '/wms/receipts'],
];

export function resolvePath(path: string): string {
  if (!path || path.startsWith('#') || hasRoute(path)) return path;
  const hit = FALLBACK.find(([p]) => path.startsWith(p));
  return hit && hasRoute(hit[1]) ? hit[1] : '/';
}

/** 第一个存在的路径（如 PDA 收货页优先，没有就用电脑收货页） */
export const firstRoute = (...paths: string[]) => paths.find((p) => hasRoute(p)) ?? paths[paths.length - 1];

/** 菜单路径 → 所需权限（任一） */
const PERM_OF = new Map<string, string[] | undefined>();
const walk = (ms: MenuDef[], parent?: string[]) =>
  ms.forEach((m) => {
    const perm = m.perm ?? parent;
    if (m.children) return walk(m.children, perm);
    // 同一页面出现在多个菜单分组（如“汇率”）时取并集；任一处不限权限则不限
    const k = pathOnly(m.key);
    if (!PERM_OF.has(k)) PERM_OF.set(k, perm);
    else {
      const prev = PERM_OF.get(k);
      PERM_OF.set(k, prev === undefined || perm === undefined ? undefined : [...new Set([...prev, ...perm])]);
    }
  });
walk(menu);

/** 当前用户能否进入该路径（按菜单权限；菜单里没有的路径按其列表页判断，查不到则放行） */
export function canPath(path: string, can: (...p: string[]) => boolean): boolean {
  const p = pathOnly(path);
  let best: string | undefined;
  for (const k of PERM_OF.keys()) if ((k === p || (k !== '/' && p.startsWith(k + '/'))) && (!best || k.length > best.length)) best = k;
  const perm = best ? PERM_OF.get(best) : undefined;
  return !perm || can(...perm);
}

/** 跳转（带 state.wb，保证同页不同筛选也会刷新） */
export function useGo() {
  const nav = useNavigate();
  return useCallback((path: string) => {
    const p = resolvePath(path);
    nav(p, { state: { wb: Date.now() } });
  }, [nav]);
}
