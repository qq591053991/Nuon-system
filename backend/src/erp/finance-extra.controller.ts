/** 财务（G4 好用性）：单据详情（含来料 IQC 状态）、收付款流水、作废、合并收付款、预收冲抵、金蝶凭证引出 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { FinanceService } from './finance.service';

export class VoidPaymentDto {
  @IsString({ message: '请填写作废原因' }) @MinLength(2, { message: '请填写作废原因（至少 2 个字）' }) reason: string;
}

export class AllocationDto {
  @Type(() => Number) @IsInt() doc_id: number;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
}

export class SettleDto {
  @IsIn(['AR', 'AP'], { message: 'kind 只能为 AR（收款）或 AP（付款）' }) kind: 'AR' | 'AP';
  @Type(() => Number) @IsInt({ message: '请选择往来单位' }) partner_id: number;
  @IsString({ message: '请选择币别' }) currency: string;
  /** 核销合计（原币）；收款含银行手续费 */
  @Type(() => Number) @IsNumber() @IsPositive({ message: '金额必须大于 0' }) amount: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0, { message: '手续费不能为负数' }) fee_amount?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive({ message: '汇率必须大于 0' }) exchange_rate?: number | null;
  @IsOptional() @IsString() pay_date?: string | null;
  @IsOptional() @IsString() method?: string | null;
  @IsOptional() @IsString() reference?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  /** 不传 = 按到期日先后自动分配 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations?: AllocationDto[];
  @IsOptional() @IsBoolean() as_advance?: boolean;
  /** 只返回分配方案，不登记 */
  @IsOptional() @IsBoolean() dry_run?: boolean;
}

export class ApplyAdvanceDto {
  @Type(() => Number) @IsInt({ message: '请选择预收/预付单' }) advance_id: number;
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive({ message: '冲抵金额必须大于 0' }) amount?: number | null;
  @IsOptional() @IsString() remark?: string | null;
}

@Controller('finance')
export class FinanceExtraController {
  constructor(private readonly svc: FinanceService) {}

  /** 单据详情（应付含来料 IQC 状态，付款前提示） */
  @Get('docs/:id')
  @Perms('finance')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  /** 收付款流水（含已作废） */
  @Get('payments')
  @Perms('finance')
  payments(@Query() q: Record<string, string>) {
    return this.svc.payments(q);
  }

  /** 作废收付款（填写原因；同一收付款单号一起作废，核销回滚） */
  @Post('payments/:id/void')
  @Perms('finance')
  voidPayment(@Param('id', ParseIntPipe) id: number, @Body() body: VoidPaymentDto, @User() user: CurrentUser) {
    return this.svc.voidPayment(id, body.reason, user);
  }

  /** 合并收付款：按到期日先后自动分配（dry_run 预览） */
  @Post('receipts')
  @Perms('finance')
  settle(@Body() body: SettleDto, @User() user: CurrentUser) {
    return this.svc.settle({ ...body, allocations: body.allocations?.length ? body.allocations : undefined }, user);
  }

  /** 用预收/预付款冲抵应收/应付 */
  @Post('docs/:id/apply-advance')
  @Perms('finance')
  applyAdvance(@Param('id', ParseIntPipe) id: number, @Body() body: ApplyAdvanceDto, @User() user: CurrentUser) {
    return this.svc.applyAdvance(id, body, user);
  }

  /** 金蝶凭证引出：period=YYYY-MM 或 date_from/date_to */
  @Get('voucher')
  @Perms('finance')
  voucher(@Query() q: Record<string, string>) {
    return this.svc.voucher(q);
  }
}
