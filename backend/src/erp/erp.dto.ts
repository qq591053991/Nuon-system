/** ERP 请求体：销售订单、采购订单、采购收货、MRP 转单、收付款 */
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

// ============ 销售订单 ============
export class SoLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @IsOptional() @Type(() => Number) @IsNumber() unit_price: number | null = 0;
  @IsOptional() @IsString() delivery_date?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

/**
 * 表头可选字段：未传（undefined）= 不修改；显式传 null = 清空（修改草稿时可清除客户PO号、备注、交期等）。
 * 因此可选字段不设默认值，默认值在新建时处理（currency 默认 CNY、order_date 默认今天）。
 */
export class SoDto {
  @Type(() => Number) @IsInt() customer_id: number;
  @IsOptional() @IsString() order_date?: string | null;
  @IsOptional() @IsString() delivery_date?: string | null;
  @IsOptional() @IsString() customer_po?: string | null;
  @IsOptional() @IsString() currency?: string | null;
  @IsOptional() @IsString() ship_to?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SoLineDto) lines: SoLineDto[];
}

// ============ 采购订单 ============
export class PoLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @IsOptional() @Type(() => Number) @IsNumber() unit_price: number | null = 0;
  @IsOptional() @IsString() expected_date?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

/** 同 SoDto：未传 = 不修改；null = 清空 */
export class PoDto {
  @Type(() => Number) @IsInt() supplier_id: number;
  @IsOptional() @IsString() order_date?: string | null;
  @IsOptional() @IsString() expected_date?: string | null;
  @IsOptional() @IsString() currency?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PoLineDto) lines: PoLineDto[];
}

export class ReceiveLineDto {
  @Type(() => Number) @IsInt() po_line_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @Type(() => Number) @IsInt() location_id: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() supplier_lot?: string | null;
  @IsOptional() @IsString() mfg_date?: string | null;
  @IsOptional() @IsString() expiry_date?: string | null;
}

export class ReceiveDto {
  @IsOptional() @IsString() delivery_note?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveLineDto) lines: ReceiveLineDto[];
}

// ============ MRP ============
export class ConvertDto {
  @IsArray() @Type(() => Number) @IsInt({ each: true }) suggestion_ids: number[];
}

// ============ 应收应付 ============
export class PaymentDto {
  @IsOptional() @IsString() pay_date?: string | null;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsString() method: string | null = '银行转账';
  @IsOptional() @IsString() reference?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}
