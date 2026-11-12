/** ERP 请求体：销售订单、采购订单、采购收货、MRP 转单、收付款 */
import { Type } from 'class-transformer';
import { SignatureDto } from '../core/esign.service';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, ValidateNested } from 'class-validator';

// ============ 销售订单 ============
export class SoLineDto {
  /** 原订单行 id（修改草稿/订单变更时保留行；不传 = 新增行） */
  @IsOptional() @Type(() => Number) @IsInt() id?: number | null;
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

/** 已确认订单变更：preview=true 只分析影响不保存；保存时 reason 必填。表头字段未传 = 不改 */
export class SoChangeDto {
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsBoolean() preview?: boolean;
  @IsOptional() @IsString() delivery_date?: string | null;
  @IsOptional() @IsString() customer_po?: string | null;
  @IsOptional() @IsString() ship_to?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => SoLineDto) lines: SoLineDto[];
}

/** 撤销确认 / 工单调整等需要填写原因的操作 */
export class ReasonDto {
  @IsString() reason: string;
}

export class SoWoLineDto {
  @Type(() => Number) @IsInt() so_line_id: number;
  @Type(() => Number) @IsNumber() @Min(0) qty: number;
  @IsOptional() @IsString() planned_start?: string | null;
  @IsOptional() @IsString() planned_end?: string | null;
}

/** 订单生成工单：lines 不传 = 按未覆盖数量自动生成；link_wo_ids = 关联已有的未关联订单工单 */
export class SoWorkOrdersDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SoWoLineDto) lines?: SoWoLineDto[];
  @IsOptional() @IsArray() @Type(() => Number) @IsInt({ each: true }) link_wo_ids?: number[];
}

// ============ 采购订单 ============
/**
 * 采购订单行：qty / unit_price 为库存单位数量与单价。
 * 按采购单位下单时传 purchase_qty（+ purchase_price，可选 purchase_uom，默认取物料的采购单位）：
 *   qty = purchase_qty × 换算率；unit_price = purchase_price ÷ 换算率；amount = purchase_qty × purchase_price（此时 qty/unit_price 可不传）。
 */
export class PoLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() qty?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() unit_price: number | null = 0;
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() purchase_qty?: number | null;
  @IsOptional() @IsString() purchase_uom?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) purchase_price?: number | null;
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
  /** 湿敏物料放非防潮库位等“需确认”的放置，前端弹窗确认后带 true */
  @IsOptional() @IsBoolean() confirm_placement?: boolean;
  @IsOptional() @IsString() delivery_note?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveLineDto) lines: ReceiveLineDto[];
}

// ============ MRP ============
export class ConvertDto {
  @IsArray() @Type(() => Number) @IsInt({ each: true }) suggestion_ids: number[];
  /** MRP 结果已过期（之后订单/工单/采购/库存有变化）时仍要转单 */
  @IsOptional() @IsBoolean() force?: boolean;
}

// ============ 应收应付 ============
export class PaymentDto {
  @IsOptional() @IsString() pay_date?: string | null;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsString() method: string | null = '银行转账';
  @IsOptional() @IsString() reference?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  /** 银行手续费（原币）：应收从货款中扣除（核销金额含手续费）；应付为我方另付 */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fee_amount?: number | null;
  /** 实收/实付汇率（1 原币 = ? 本位币），不填按收付款日适用汇率 */
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() exchange_rate?: number | null;
  /** 超出未结余额的部分转为预收/预付款 */
  @IsOptional() @IsBoolean() as_advance?: boolean;
  /** 收付款银行账户 */
  @IsOptional() @IsString() bank_account?: string | null;
}

// ============ 大额采购单审批 ============
export class PoApproveDto {
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

export class PoRejectDto {
  @IsString() reason: string;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}
