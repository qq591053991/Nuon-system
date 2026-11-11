import type { PrismaService } from '../common/prisma.service';
import type { SeedContext } from './seed-base';

/** 演示业务流程（待实现：SO → 工单 → 领料 → 过站（含返工/报废）→ 完工入库 → DHR 放行 → 发货；在制工单；待检来料） */
export async function seedDemo(_db: PrismaService, _ctx: SeedContext): Promise<void> {
  console.log('演示业务流程：待实现');
}
