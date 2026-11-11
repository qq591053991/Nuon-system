import { Module } from '@nestjs/common';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { TraceService } from './trace.service';

/** 驾驶舱、我的待办、追溯（正向/反向）、全局搜索 */
@Module({ controllers: [ReportController], providers: [ReportService, TraceService], exports: [ReportService, TraceService] })
export class ReportModule {}
