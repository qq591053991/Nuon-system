/**
 * 初始化/演示数据：
 *   npm run seed              # 基础数据（用户、主数据、BOM、工艺、期初库存、订单）
 *   npm run seed -- --demo    # 额外跑一遍完整业务流程，生成生产/质量/发货演示数据
 *   npm run seed -- --reset   # 清空数据库后重建
 */
import 'reflect-metadata';
import { PrismaService } from '../common/prisma.service';
import { DEMO_PASSWORD, resetDatabase, seedBase } from './seed-base';
import { seedDemo } from './seed-demo';

async function main() {
  const args = process.argv.slice(2);
  const db = new PrismaService();
  try {
    if (args.includes('--reset')) await resetDatabase(db);
    const ctx = await seedBase(db);
    console.log(`基础数据已初始化。演示账号：admin / ${DEMO_PASSWORD}（其他账号见 README）`);
    if (args.includes('--demo')) await seedDemo(db, ctx);
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
