/** 生产退料接口：生成退料单、查询工单可退批次。退料单过账/取消沿用 POST /issues/:id/confirm、/issues/:id/cancel。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { ser } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { ReturnsService } from './returns.service';

class ReturnLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @Type(() => Number) @IsInt() location_id: number;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @IsOptional() @Type(() => Number) @IsInt() owner_customer_id?: number | null;
}

class ReturnDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines: ReturnLineDto[];
  @IsOptional() @IsString() remark?: string | null;
}

@Controller()
export class ReturnsController {
  constructor(private readonly db: PrismaService, private readonly svc: ReturnsService) {}

  /** 工单已领物料批次与可退数量（新建退料单时选择） */
  @Get('work-orders/:id/returnable')
  returnable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.returnableLots(this.db.client, id);
  }

  /** 生成生产退料单（草稿；过账后库存加回“合格”，扣减工单已领数量） */
  @Post('work-orders/:id/returns')
  @Perms('wms')
  create(@Param('id', ParseIntPipe) id: number, @Body() b: ReturnDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => ser('MaterialIssue', await this.svc.createReturn(tx, user, id, b.lines, b.remark), ['lines']));
  }
}
