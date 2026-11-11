import { ser, serList, inc } from './presenter';

export interface PageQuery { page?: string | number; page_size?: string | number }

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
    delegate.findMany({ where: opts.where, orderBy: opts.orderBy ?? { id: 'desc' }, skip, take, include: inc(model, opts.children) }),
  ]);
  return { items: serList(model, rows, opts.children), total, page, page_size };
}

export { ser, serList, inc };

/** 模糊搜索条件（不区分大小写） */
export const like = (v: string) => ({ contains: v, mode: 'insensitive' as const });

/** 逗号分隔的多值筛选 */
export const inList = (v?: string) => (v ? { in: v.split(',') } : undefined);
