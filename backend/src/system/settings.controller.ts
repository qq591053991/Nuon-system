/** 系统设置（R1）：公司信息（单据打印抬头），管理员维护；所有登录用户可读（打印用） */
import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { PrismaService } from '../common/prisma.service';
import { getCompany, saveCompany } from './settings';

class CompanyDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) name_en?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(500) address_en?: string;
  @IsOptional() @IsString() @MaxLength(100) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) tax_no?: string;
  @IsOptional() @IsString() @MaxLength(300) bank?: string;
  @IsOptional() @IsString() @MaxLength(50) swift?: string;
}

@Controller('system/settings')
export class SettingsController {
  constructor(private readonly db: PrismaService) {}

  /** 公司信息（未维护的项为环境变量默认值） */
  @Get('company')
  company() {
    return getCompany(this.db);
  }

  /** 保存公司信息（系统管理员）；逐项写审计 */
  @Put('company')
  @Perms('admin')
  save(@Body() b: CompanyDto, @User() user: CurrentUser) {
    return saveCompany(this.db, b, user);
  }
}
