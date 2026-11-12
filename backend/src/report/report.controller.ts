/** 驾驶舱、岗位工作台、我的待办、交付风险、追溯、全局搜索。 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsString } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { ReportService } from './report.service';
import { SearchService } from './search.service';
import { TraceService } from './trace.service';
import { WorkbenchService } from './workbench.service';

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
    private readonly workbench: WorkbenchService,
    private readonly searcher: SearchService,
  ) {}

  /** 经营驾驶舱（图表与汇总；金额按读权限裁剪） */
  @Get('dashboard')
  dashboard(@User() user: CurrentUser) {
    return this.report.dashboard(this.db.client, user);
  }

  /** 岗位工作台：主岗位、KPI 卡（带下钻路径）、岗位专属区块（待我拍板/应收应付/账号安全/今日报工） */
  @Get('workbench')
  workbenchHome(@User() user: CurrentUser) {
    return this.workbench.workbench(this.db.client, user);
  }

  /** 交付风险：未发完订单的交期、进度、缺料（估算）、阻塞原因，红黄绿 */
  @Get('workbench/delivery-risk')
  @Perms('sales', 'plan', 'finance')
  deliveryRisk() {
    return this.workbench.deliveryRisk(this.db.client);
  }

  /** 产出下钻：某日（默认今天）完工序列号按工单汇总 */
  @Get('workbench/output')
  @Perms('plan', 'mes', 'qa', 'qc', 'wms', 'sales')
  output(@Query('date') date?: string) {
    return this.workbench.outputDetail(this.db.client, date);
  }

  /** FPY 下钻：近 30 天各工序首次测试结果与首次不合格明细 */
  @Get('workbench/fpy')
  @Perms('plan', 'mes', 'qa', 'qc', 'engineering')
  fpy(@Query('op_name') op?: string) {
    return this.workbench.fpyDetail(this.db.client, op);
  }

  /** 我的待办（按岗位，带筛选参数的跳转路径） */
  @Get('todos')
  todos(@User() user: CurrentUser) {
    return this.workbench.todos(this.db.client, user);
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

  /** 全局搜索：单号 / 序列号 / 批号 / UDI / 物料 / 库位，按读权限裁剪；完全匹配排最前 */
  @Get('search')
  search(@Query('q') q: string | undefined, @User() user: CurrentUser) {
    return this.searcher.search(this.db.client, user, q);
  }
}
