/** 放行结论（DHR 顶部结论卡）：GET /quality/release-check/:woId —— 按序列号逐项检查，只读。 */
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ReleaseCheckService } from './release-check.service';

@Controller('quality/release-check')
export class ReleaseCheckController {
  constructor(private readonly db: PrismaService, private readonly svc: ReleaseCheckService) {}

  @Get(':woId')
  check(@Param('woId', ParseIntPipe) woId: number) {
    return this.svc.check(this.db.client, woId);
  }
}
