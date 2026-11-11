import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { BomDto, NewVersionDto, ReleaseDto } from './engineering.dto';
import { EngineeringService } from './engineering.service';

/** 工程-BOM：草稿 → 电子签名发布 → 升版（ECN） */
@Controller('boms')
export class BomController {
  constructor(private readonly svc: EngineeringService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.svc.listBoms(q);
  }

  @Get(':id/tree')
  tree(@Param('id', ParseIntPipe) id: number, @Query('qty') qty?: string) {
    const n = qty === undefined || qty === '' ? 1 : Number(qty);
    if (Number.isNaN(n)) throw new BizError(`参数格式错误：${qty}`);
    return this.svc.bomTree(id, n);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getBom(id);
  }

  @Post()
  @Perms('engineering')
  create(@Body() body: BomDto, @User() user: CurrentUser) {
    return this.svc.createBom(user, body);
  }

  @Put(':id')
  @Perms('engineering')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: BomDto) {
    return this.svc.updateBom(id, body);
  }

  @Delete(':id')
  @Perms('engineering')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteBom(id);
  }

  @Post(':id/release')
  @Perms('engineering')
  release(@Param('id', ParseIntPipe) id: number, @Body() body: ReleaseDto, @User() user: CurrentUser) {
    return this.svc.releaseBom(id, body, user);
  }

  @Post(':id/new-version')
  @Perms('engineering')
  newVersion(@Param('id', ParseIntPipe) id: number, @Body() body: NewVersionDto, @User() user: CurrentUser) {
    return this.svc.bomNewVersion(id, body, user);
  }
}
