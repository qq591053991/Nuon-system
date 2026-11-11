import type { Tx } from '../common/prisma.service';

/** 产品当前已发布的 BOM / 工艺路线（GMP：只能使用受控版本） */
export const releasedBom = (tx: Tx, materialId: number) =>
  tx.bom.findFirst({ where: { material_id: materialId, status: 'RELEASED' }, orderBy: { id: 'desc' }, include: { lines: { include: { component: true }, orderBy: { line_no: 'asc' } } } });

export const releasedRouting = (tx: Tx, materialId: number) =>
  tx.routing.findFirst({
    where: { material_id: materialId, status: 'RELEASED' },
    orderBy: { id: 'desc' },
    include: { operations: { orderBy: { seq: 'asc' }, include: { params: { orderBy: { id: 'asc' } } } } },
  });
