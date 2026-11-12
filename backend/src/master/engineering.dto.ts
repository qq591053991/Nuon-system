/** 工程数据（BOM / 工艺路线）与设备校准的请求体 */
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateNested } from 'class-validator';
import { SignatureDto } from '../core/esign.service';

// ---------------- 设备校准 ----------------
export class CalibrationDto {
  @IsString() calibration_date: string;
  @IsOptional() @IsString() result: string | null = 'PASS';
  @IsOptional() @IsString() certificate_no?: string | null;
  @IsOptional() @IsString() agency?: string | null;
  @IsOptional() @IsString() next_due_date?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

// ---------------- BOM ----------------
export class BomLineDto {
  @Type(() => Number) @IsInt() component_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty_per: number;
  @IsOptional() @Type(() => Number) @IsNumber() scrap_rate: number | null = 0;
  @IsOptional() @IsString() designator?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

export class BomDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @IsString() version: string | null = 'A0';
  @IsOptional() @IsString() ecn_no?: string | null;
  @IsOptional() @IsString() effective_date?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  /** 变更原因 / 影响评估（首版之后的版本提交时必填） */
  @IsOptional() @IsString() change_reason?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BomLineDto) lines: BomLineDto[] | null = [];
}

/** 仅电子签名（QA 批准） */
export class SignOnlyDto {
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

/** 工程师提交（电子签名：编制）；可同时填写/更新变更原因 */
export class SubmitDto extends SignOnlyDto {
  @IsOptional() @IsString() change_reason?: string | null;
}

/** QA 驳回（电子签名 + 驳回原因） */
export class RejectDto extends SignOnlyDto {
  @IsString() @IsNotEmpty({ message: '请填写驳回原因' }) reason: string;
}

/** 升版 */
export class NewVersionDto {
  @IsString() version: string;
  @IsOptional() @IsString() ecn_no?: string | null;
  @IsOptional() @IsString() change_reason?: string | null;
}

// ---------------- 工艺路线 ----------------
export class ParamDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() unit?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() lower?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() upper?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() target?: number | null;
  /** NUMBER = 数值（按上下限判定）；OKNG = 合格判定（工位点 OK / NG） */
  @IsOptional() @IsIn(['NUMBER', 'OKNG'], { message: '测试项类型只能是“数值”或“OK/NG 判定”' }) param_type?: string | null;
  /** 小数位数（工位录入时限制） */
  @IsOptional() @Type(() => Number) @IsInt({ message: '小数位数须为 0–6 的整数' }) @Min(0, { message: '小数位数须为 0–6 的整数' }) @Max(6, { message: '小数位数须为 0–6 的整数' })
  decimals?: number | null;
  /** 合理输入范围（超出视为录入错误，工位当场拦截，不判不合格） */
  @IsOptional() @Type(() => Number) @IsNumber() min_valid?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() max_valid?: number | null;
}

export class OperationDto {
  @Type(() => Number) @IsInt() seq: number;
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() op_type: string | null = 'ASSEMBLY';
  @IsOptional() @Type(() => Number) @IsInt() work_center_id?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() std_minutes: number | null = 0;
  @IsOptional() @IsBoolean() requires_equipment: boolean | null = false;
  @IsOptional() @Type(() => Number) @IsInt() key_part_material_id?: number | null;
  @IsOptional() @IsString() sop_no?: string | null;
  @IsOptional() @IsString() instructions?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ParamDto) params: ParamDto[] | null = [];
}

export class RoutingDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @IsString() version: string | null = 'A0';
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  /** 变更原因 / 影响评估（首版之后的版本提交时必填） */
  @IsOptional() @IsString() change_reason?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OperationDto) operations: OperationDto[] | null = [];
}
