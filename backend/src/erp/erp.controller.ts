/** ERP 接口：销售订单、采购订单、MRP、应收应付 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { ConvertDto, PaymentDto, PoDto, ReceiveDto, SoDto } from './erp.dto';
import { FinanceService } from './finance.service';
import { MrpService } from './mrp.service';
import { PurchaseService } from './purchase.service';
import { PO_READ } from './purchase-extra.controller';
import { maskMoney, SalesService } from './sales.service';
import { PrismaService } from '../common/prisma.service';
import { PoApproveDto, PoRejectDto } from './erp.dto';
import { ReasonDto, SoChangeDto, SoWorkOrdersDto } from './erp.dto';
import { userPermissions } from '../auth';

/** 销售订单读权限（读权限矩阵：销售、计划、仓库、财务、QA；厂长含全部业务权限） */
const SO_READ = ['sales', 'plan', 'wms', 'finance', 'qa'];

@Controller('sales-orders')
export class SalesOrderController {
  constructor(private readonly svc: SalesService) {}

  @Get()
  @Perms(...SO_READ)
  async list(@Query() q: Record<string, string>, @User() user: CurrentUser) {
    const page = await this.svc.list(q);
    page.items = maskMoney(user, userPermissions(user), page.items);
    return page;
  }

  /** 同一客户的客户PO号是否已被其他订单使用（录单时提示重复下单） */
  @Get('check-po')
  @Perms(...SO_READ)
  checkPo(@Query() q: Record<string, string>) {
    return this.svc.checkPo(q);
  }

  /** 该客户各产品的上次成交价：?customer_id=&material_ids=1,2 */
  @Get('last-prices')
  @Perms('sales')
  lastPrices(@Query() q: Record<string, string>) {
    return this.svc.lastPrices(q);
  }

  @Get(':id')
  @Perms(...SO_READ)
  async get(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return maskMoney(user, userPermissions(user), await this.svc.get(id));
  }

  /** 订单变更记录（审计追踪中本订单及其明细行的变更，含变更原因） */
  @Get(':id/history')
  @Perms(...SO_READ)
  history(@Param('id', ParseIntPipe) id: number) {
    return this.svc.history(id);
  }

  /** 生成工单预览：已排产、库存/未关联工单抵扣、建议数量、按交期倒排的计划日期 */
  @Get(':id/work-order-plan')
  @Perms('plan', 'sales')
  workOrderPlan(@Param('id', ParseIntPipe) id: number) {
    return this.svc.workOrderPlan(id);
  }

  @Post()
  @Perms('sales')
  create(@Body() body: SoDto, @User() user: CurrentUser) {
    return this.svc.create(user, body);
  }

  @Put(':id')
  @Perms('sales')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: SoDto) {
    return this.svc.update(id, body);
  }

  @Post(':id/confirm')
  @Perms('sales')
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.svc.transition(id, ['DRAFT'], 'CONFIRMED', '只有草稿可以确认');
  }

  /** 撤销确认（金蝶“反审核”）：无工单、无发货时退回草稿 */
  @Post(':id/unconfirm')
  @Perms('sales')
  unconfirm(@Param('id', ParseIntPipe) id: number, @Body() body: ReasonDto, @User() user: CurrentUser) {
    return this.svc.unconfirm(id, body.reason, user);
  }

  /** 订单变更（已确认/生产中/部分发货）：preview=true 只返回差异与受影响工单 */
  @Post(':id/change')
  @Perms('sales')
  change(@Param('id', ParseIntPipe) id: number, @Body() body: SoChangeDto, @User() user: CurrentUser) {
    return this.svc.change(id, body, user);
  }

  @Post(':id/cancel')
  @Perms('sales')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(id);
  }

  @Post(':id/close')
  @Perms('sales')
  close(@Param('id', ParseIntPipe) id: number) {
    return this.svc.transition(id, ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED', 'SHIPPED'], 'CLOSED', '当前状态不能关闭');
  }

  /** 生成工单：不传 body = 按未覆盖数量自动生成（交期倒排）；lines = 按预览确认的数量/日期；link_wo_ids = 关联已有工单 */
  @Post(':id/create-work-orders')
  @Perms('plan')
  createWorkOrders(@Param('id', ParseIntPipe) id: number, @Body() body: SoWorkOrdersDto, @User() user: CurrentUser) {
    return this.svc.createWorkOrders(id, user, body ?? {});
  }
}

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly svc: PurchaseService, private readonly db: PrismaService) {}

  @Get()
  @Perms(...PO_READ)
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  /** 大额审批标准（新建采购单时判断按钮显示“审批”还是“提交审批”） */
  @Get('approval-rule')
  @Perms(...PO_READ)
  approvalRule(@Query('amount') amount?: string, @Query('currency') currency?: string) {
    return this.svc.bigness(this.db.client, { total_amount: Number(amount) || 0, currency: currency || 'CNY' });
  }

  @Get(':id')
  @Perms(...PO_READ)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post()
  @Perms('purchase')
  create(@Body() body: PoDto, @User() user: CurrentUser) {
    return this.svc.create(user, body);
  }

  @Put(':id')
  @Perms('purchase')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: PoDto) {
    return this.svc.update(id, body);
  }

  /** 审批：大额采购单（≥ PO_APPROVAL_THRESHOLD，本位币）须厂长 po_big_approve + 电子签名 */
  @Post(':id/approve')
  @Perms('purchase', 'po_big_approve')
  approve(@Param('id', ParseIntPipe) id: number, @Body() body: PoApproveDto, @User() user: CurrentUser) {
    return this.svc.approve(id, user, body?.signature);
  }

  /** 采购员提交大额采购单给厂长审批（DRAFT → SUBMITTED） */
  @Post(':id/submit')
  @Perms('purchase')
  submit(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.svc.submit(id, user);
  }

  /** 厂长退回大额采购单（SUBMITTED → DRAFT，原因 + 电子签名） */
  @Post(':id/reject')
  @Perms('po_big_approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: PoRejectDto, @User() user: CurrentUser) {
    return this.svc.reject(id, user, body.reason, body.signature);
  }

  @Post(':id/cancel')
  @Perms('purchase')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(id);
  }

  @Post(':id/close')
  @Perms('purchase')
  close(@Param('id', ParseIntPipe) id: number) {
    return this.svc.close(id);
  }

  @Post(':id/receive')
  @Perms('wms', 'purchase')
  receive(@Param('id', ParseIntPipe) id: number, @Body() body: ReceiveDto, @User() user: CurrentUser) {
    return this.svc.receive(id, body, user);
  }
}

@Controller('mrp')
export class MrpController {
  constructor(private readonly svc: MrpService) {}

  @Post('run')
  @Perms('plan')
  run(@User() user: CurrentUser) {
    return this.svc.run(user);
  }

  @Get('runs')
  runs(@Query() q: Record<string, string>) {
    return this.svc.runs(q);
  }

  @Get('runs/:id')
  getRun(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getRun(id);
  }

  /** 运算结果是否过期（之后订单/工单/采购/BOM/库存有变化） */
  @Get('runs/:id/staleness')
  staleness(@Param('id', ParseIntPipe) id: number) {
    return this.svc.staleness(id);
  }

  @Post('convert')
  @Perms('plan', 'purchase')
  convert(@Body() body: ConvertDto, @User() user: CurrentUser) {
    return this.svc.convert(body.suggestion_ids, user, !!body.force);
  }

  /** 客供料建议：生成客户供料通知并标记“已通知”（记录通知人、时间） */
  @Post('suggestions/notify')
  @Perms('plan', 'purchase')
  notify(@Body() body: ConvertDto, @User() user: CurrentUser) {
    return this.svc.notify(body.suggestion_ids, user);
  }

  @Post('suggestions/:id/ignore')
  @Perms('plan', 'purchase')
  ignore(@Param('id', ParseIntPipe) id: number) {
    return this.svc.ignore(id);
  }
}

@Controller('finance')
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  /** 应收应付单据：往来单位/期间/币别/状态筛选，sort/order 排序 */
  @Get('docs')
  @Perms('finance')
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  @Post('docs/:id/payments')
  @Perms('finance')
  addPayment(@Param('id', ParseIntPipe) id: number, @Body() body: PaymentDto, @User() user: CurrentUser) {
    return this.svc.addPayment(id, body, user);
  }

  /** 账龄汇总：按往来单位 + 币别，另给本位币合计（as_of 截止日、basis=booking|closing、buckets=30,60,90、detail=1 下钻） */
  @Get('summary')
  @Perms('finance')
  summary(@Query() q: Record<string, string>) {
    return this.svc.summary(q);
  }

  /** 本位币与当前适用汇率 */
  @Get('currencies')
  @Perms('finance', 'master')
  currencies() {
    return this.svc.currencies();
  }
}
