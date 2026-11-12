import { Prisma } from '@prisma/client';
import { ser, serList, inc } from './presenter';

export interface PageQuery { page?: string | number; page_size?: string | number; sort?: string; order?: string }

const SCALARS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.filter((f) => f.kind === 'scalar').map((f) => f.name))]));

/** 列表排序：?sort=字段&order=asc|desc（只允许模型的真实字段，防注入） */
export function sortArg(model: string, q: PageQuery, fallback?: any) {
  const field = String(q.sort ?? '');
  if (field && SCALARS.get(model)?.has(field)) return [{ [field]: q.order === 'asc' || q.order === 'ascend' ? 'asc' : 'desc' }, { id: 'desc' }];
  return fallback;
}

export const pageArgs = (q: PageQuery, def = 20) => {
  const page = Math.max(Number(q.page) || 1, 1);
  const page_size = Math.min(Math.max(Number(q.page_size) || def, 1), 1000);
  return { page, page_size, skip: (page - 1) * page_size, take: page_size };
};

/** 通用分页：返回 {items, total, page, page_size}，items 已按视图序列化 */
export async function paginate(delegate: any, model: string, opts: { where?: any; orderBy?: any; children?: string[] }, q: PageQuery, def = 20) {
  const { page, page_size, skip, take } = pageArgs(q, def);
  const [total, rows] = await Promise.all([
    delegate.count({ where: opts.where }),
    delegate.findMany({ where: opts.where, orderBy: sortArg(model, q, opts.orderBy ?? { id: 'desc' }), skip, take, include: inc(model, opts.children) }),
  ]);
  return { items: serList(model, rows, opts.children), total, page, page_size };
}

export { ser, serList, inc };

/** 模糊搜索条件（不区分大小写） */
export const like = (v: string) => ({ contains: v, mode: 'insensitive' as const });

/** 逗号分隔的多值筛选 */
export const inList = (v?: string) => (v ? { in: v.split(',') } : undefined);
