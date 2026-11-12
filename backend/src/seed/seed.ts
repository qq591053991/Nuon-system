/**
 * 初始化/演示数据：
 *   npm run seed                      # 生产初始化：只建系统管理员 admin（首次登录强制改密），不生成任何演示账号与演示数据
 *                                     #   初始密码 = 环境变量 INITIAL_ADMIN_PASSWORD；未设置则随机生成并在控制台打印一次
 *   npm run seed -- --demo            # 演示环境：基础数据 + 14 个岗位演示账号（密码 Nuon@2026）+ 完整业务流程演示数据
 *   npm run seed -- --demo --force-change   # 同上，但演示账号首次登录也须修改密码（或设置 DEMO_FORCE_PASSWORD_CHANGE=1）
 *   npm run seed -- --reset           # 清空数据库后重建（可与上面任一组合）
 * 登录页是否显示“演示账号”由 DEMO_MODE 决定（未设置时：仍有演示账号使用公开演示密码即显示）。
 */
import 'reflect-metadata';
import { PrismaService } from '../common/prisma.service';
import { DEMO_PASSWORD, resetDatabase, seedAdmin, seedBase } from './seed-base';
import { seedDemo } from './seed-demo';
import { DEMO_USERS } from '../auth/demo';

async function main() {
  const args = process.argv.slice(2);
  const db = new PrismaService();
  try {
    if (args.includes('--reset')) await resetDatabase(db);
    if (args.includes('--demo')) {
      const forcePasswordChange = args.includes('--force-change') || process.env.DEMO_FORCE_PASSWORD_CHANGE === '1';
      const ctx = await seedBase(db, { forcePasswordChange });
      console.log(`演示数据初始化：${DEMO_USERS.length} 个岗位演示账号，密码均为 ${DEMO_PASSWORD}${forcePasswordChange ? '（首次登录须修改密码）' : ''}。正式环境请勿使用 --demo。`);
      await seedDemo(db, ctx);
    } else {
      const admin = await seedAdmin(db, process.env.INITIAL_ADMIN_PASSWORD);
      if (admin) {
        console.log('系统已初始化：只创建了系统管理员账号，首次登录须修改密码。');
        console.log(`  账号：${admin.username}`);
        console.log(`  初始密码：${admin.password}${process.env.INITIAL_ADMIN_PASSWORD ? '（来自 INITIAL_ADMIN_PASSWORD）' : '（随机生成，仅显示这一次，请妥善转交）'}`);
        console.log('  登录后在“用户与角色”中批量导入/新建员工账号（Excel 导入可一次生成初始密码清单）。');
      } else {
        console.log('系统管理员账号已存在，未做修改。');
      }
    }
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
