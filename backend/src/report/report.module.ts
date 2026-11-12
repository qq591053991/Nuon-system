import { Module } from '@nestjs/common';
import { PlanModule } from '../erp/plan.module';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { SearchService } from './search.service';
import { TraceService } from './trace.service';
import { WorkbenchService } from './workbench.service';

/** 驾驶舱、岗位工作台与待办、交付风险（用 G3 齐套分析）、追溯（正向/反向）、全局搜索 */
@Module({
  imports: [PlanModule],
  controllers: [ReportController],
  providers: [ReportService, TraceService, WorkbenchService, SearchService],
  exports: [ReportService, TraceService, WorkbenchService, SearchService],
})
export class ReportModule {}
