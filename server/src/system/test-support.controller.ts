import { Controller, ForbiddenException, Post } from '@nestjs/common';
import { Public, resetLoginFailures } from '../auth';
import { config } from '../config';
import { PrismaService } from '../common/prisma.service';
import { resetDatabase, seedBase } from '../seed/seed-base';

/** 仅测试环境（ENABLE_TEST_RESET=1）：重置数据库并写入基础数据，供端到端测试使用 */
@Controller('test')
export class TestSupportController {
  constructor(private readonly db: PrismaService) {}

  @Public()
  @Post('reset')
  async reset() {
    if (!config.enableTestReset) throw new ForbiddenException();
    resetLoginFailures();
    await resetDatabase(this.db);
    await seedBase(this.db);
    return { ok: true };
  }
}
