/** ERP 接口：销售订单、采购订单、MRP、应收应付 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { ConvertDto, PaymentDto, PoDto, ReceiveDto, SoDto } from './erp.dto';
import { FinanceService } from './finance.service';
import { MrpService } from './mrp.service';
import { PurchaseService } from './purchase.service';
import { SalesService } from './sales.service';

@Controller('sales-orders')
export class SalesOrderController {
  constructor(private readonly svc: SalesService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
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

  @Post(':id/create-work-orders')
  @Perms('plan')
  createWorkOrders(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.svc.createWorkOrders(id, user);
  }
}

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly svc: PurchaseService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  @Get(':id')
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

  @Post(':id/approve')
  @Perms('purchase')
  approve(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.svc.approve(id, user);
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

  @Post('convert')
  @Perms('plan', 'purchase')
  convert(@Body() body: ConvertDto, @User() user: CurrentUser) {
    return this.svc.convert(body.suggestion_ids, user);
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

  @Get('docs')
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  @Post('docs/:id/payments')
  @Perms('finance')
  addPayment(@Param('id', ParseIntPipe) id: number, @Body() body: PaymentDto, @User() user: CurrentUser) {
    return this.svc.addPayment(id, body, user);
  }

  /** 账龄汇总：按往来单位 + 币别，另给本位币合计 */
  @Get('summary')
  summary() {
    return this.svc.summary();
  }

  /** 本位币与当前适用汇率 */
  @Get('currencies')
  currencies() {
    return this.svc.currencies();
  }
}
