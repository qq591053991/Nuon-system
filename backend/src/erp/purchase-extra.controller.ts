/** 采购（G4 好用性）：审批后变更与变更记录、催货清单、物料采购属性（采购自行维护） */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { PurchaseService } from './purchase.service';

/** 采购订单可读：采购、计划、仓储、质量、财务（厂长含以上全部） */
export const PO_READ = ['purchase', 'plan', 'wms', 'qc', 'qa', 'finance'];

export class PoChangeLineDto {
  @Type(() => Number) @IsInt() id: number;
  /** 未传 = 不改；null = 清空 */
  @IsOptional() @IsString() expected_date?: string | null;
  /** 供应商回复交期 */
  @IsOptional() @IsString() promised_date?: string | null;
  /** 库存单位数量 / 单价（按采购单位下单的行用 purchase_qty / purchase_price） */
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive({ message: '数量必须大于 0' }) qty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0, { message: '单价不能为负数' }) unit_price?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive({ message: '数量必须大于 0' }) purchase_qty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0, { message: '单价不能为负数' }) purchase_price?: number | null;
}

export class PoChangeDto {
  @IsString({ message: '请填写变更原因' }) @MinLength(2, { message: '请填写变更原因（至少 2 个字）' }) reason: string;
  @IsOptional() @IsString() expected_date?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PoChangeLineDto) lines?: PoChangeLineDto[];
}

export class MaterialPurchaseDto {
  @IsOptional() @IsString() purchase_uom?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() purchase_factor?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() default_supplier_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt({ message: '采购提前期请填写整数天' }) @Min(0) lead_time_days?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0, { message: '最小订购量不能为负数' }) min_order_qty?: number | null;
}

@Controller('purchase-orders')
export class PurchaseOrderChangeController {
  constructor(private readonly svc: PurchaseService) {}

  /** 审批后变更：交期 / 供应商回复交期 / 单价 / 数量（必须填写变更原因，留痕） */
  @Post(':id/change')
  @Perms('purchase')
  change(@Param('id', ParseIntPipe) id: number, @Body() body: PoChangeDto, @User() user: CurrentUser) {
    return this.svc.change(id, body, user);
  }

  /** 变更记录 */
  @Get(':id/changes')
  @Perms(...PO_READ)
  changes(@Param('id', ParseIntPipe) id: number) {
    return this.svc.changes(id);
  }
}

@Controller('purchase')
export class PurchaseExtraController {
  constructor(private readonly svc: PurchaseService) {}

  /** 催货清单：未到齐的采购订单行（未交数量、应到日期、逾期天数） */
  @Get('chase')
  @Perms(...PO_READ)
  chase(@Query() q: Record<string, string>) {
    return this.svc.chase(q);
  }

  /** 采购订单明细（按行；筛选同采购订单列表，供导出 Excel） */
  @Get('lines')
  @Perms(...PO_READ)
  lines(@Query() q: Record<string, string>) {
    return this.svc.lines(q);
  }

  /** 物料采购属性列表（附最近采购价） */
  @Get('materials')
  @Perms('purchase', 'master', 'plan')
  materials(@Query() q: Record<string, string>) {
    return this.svc.materials(q);
  }

  /** 采购维护物料采购属性 */
  @Put('materials/:id')
  @Perms('purchase', 'master')
  updateMaterial(@Param('id', ParseIntPipe) id: number, @Body() body: MaterialPurchaseDto) {
    return this.svc.updateMaterialPurchase(id, body);
  }
}
