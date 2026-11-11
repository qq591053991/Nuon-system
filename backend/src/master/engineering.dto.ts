/** 工程数据（BOM / 工艺路线）与设备校准的请求体 */
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
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
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BomLineDto) lines: BomLineDto[] | null = [];
}

/** 发布（电子签名） */
export class ReleaseDto {
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

/** 升版 */
export class NewVersionDto {
  @IsString() version: string;
  @IsOptional() @IsString() ecn_no?: string | null;
}

// ---------------- 工艺路线 ----------------
export class ParamDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() unit?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() lower?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() upper?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() target?: number | null;
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
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OperationDto) operations: OperationDto[] | null = [];
}
