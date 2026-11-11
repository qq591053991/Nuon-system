/** 驾驶舱、我的待办、追溯、全局搜索。 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsString } from 'class-validator';
import { User } from '../auth';
import type { CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { ReportService } from './report.service';
import { TraceService } from './trace.service';

class TraceLotQuery {
  @IsString() material_code: string;
  @IsString() lot_no: string;
}

@Controller()
export class ReportController {
  constructor(
    private readonly db: PrismaService,
    private readonly report: ReportService,
    private readonly trace: TraceService,
  ) {}

  /** 经营驾驶舱 */
  @Get('dashboard')
  dashboard() {
    return this.report.dashboard(this.db.client);
  }

  /** 我的待办（按权限） */
  @Get('todos')
  todos(@User() user: CurrentUser) {
    return this.report.todos(this.db.client, user);
  }

  /** 反向追溯：序列号 → 物料批次/工序/测试/发货 */
  @Get('trace/serial/:sn')
  traceSerial(@Param('sn') sn: string) {
    return this.trace.traceSerial(this.db.client, sn);
  }

  /** 正向追溯：物料批次 → 工单 → 序列号 → 客户（召回范围） */
  @Get('trace/lot')
  traceLot(@Query() q: TraceLotQuery) {
    return this.trace.traceLot(this.db.client, q.material_code, q.lot_no);
  }

  /** 全局搜索 */
  @Get('search')
  search(@Query('q') q?: string) {
    return this.trace.globalSearch(this.db.client, q);
  }
}
