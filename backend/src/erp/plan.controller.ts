/** 计划接口：齐套分析（只读）、工单下达后调整 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { KittingService } from './kitting.service';
import { WoAdjustService } from './wo-adjust.service';

/** 销售订单读权限（与 SalesOrderController 一致）+ 采购（看缺料） */
const SO_READ = ['sales', 'plan', 'wms', 'finance', 'qa', 'purchase'];

class WoAdjustDto {
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() planned_qty?: number | null;
  @IsOptional() @IsString() planned_start?: string | null;
  @IsOptional() @IsString() planned_end?: string | null;
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsBoolean() preview?: boolean;
}

@Controller('kitting')
export class KittingController {
  constructor(private readonly svc: KittingService) {}

  /** 销售订单齐套：每个物料的需求、可用、缺口、在途采购单、预计齐套日 */
  @Get('sales-orders/:id')
  @Perms(...SO_READ)
  salesOrder(@Param('id', ParseIntPipe) id: number) {
    return this.svc.salesOrder(id);
  }

  /** 工单齐套 */
  @Get('work-orders/:id')
  workOrder(@Param('id', ParseIntPipe) id: number) {
    return this.svc.workOrder(id);
  }

  /** 批量：?ids=1,2 → {[wo_id]: {kitted, shortage_count, eta}} */
  @Get('work-orders')
  workOrders(@Query('ids') ids?: string) {
    const list = String(ids || '').split(',').filter(Boolean).map(Number);
    if (list.some((x) => !Number.isInteger(x))) throw new BizError('参数 ids 格式错误，应为逗号分隔的工单 id');
    return this.svc.workOrders(list);
  }

  /** 工单列表（筛选同 /work-orders）+ 齐套列；kitting=SHORT 缺料工单 / KITTED 已齐套 */
  @Get('work-order-list')
  workOrderList(@Query() q: Record<string, string>) {
    return this.svc.workOrderList(q);
  }
}

@Controller('work-orders')
export class WoAdjustController {
  constructor(private readonly svc: WoAdjustService) {}

  /** 调整前信息：最少可调到多少、关联订单行 */
  @Get(':id/adjust-info')
  info(@Param('id', ParseIntPipe) id: number) {
    return this.svc.info(id);
  }

  /** 已下达/生产中工单调整未开工部分的数量与计划日期（preview=true 只预览） */
  @Post(':id/adjust')
  @Perms('plan')
  adjust(@Param('id', ParseIntPipe) id: number, @Body() b: WoAdjustDto, @User() user: CurrentUser) {
    return this.svc.adjust(id, b, user);
  }
}
