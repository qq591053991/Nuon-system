import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { NewVersionDto, ReleaseDto, RoutingDto } from './engineering.dto';
import { EngineeringService } from './engineering.service';

/** 工程-工艺路线（工序 + 测试规格上下限）：草稿 → 电子签名发布 → 升版 */
@Controller('routings')
export class RoutingController {
  constructor(private readonly svc: EngineeringService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.svc.listRoutings(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getRouting(id);
  }

  @Post()
  @Perms('engineering')
  create(@Body() body: RoutingDto, @User() user: CurrentUser) {
    return this.svc.createRouting(user, body);
  }

  @Put(':id')
  @Perms('engineering')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: RoutingDto) {
    return this.svc.updateRouting(id, body);
  }

  @Post(':id/release')
  @Perms('engineering')
  release(@Param('id', ParseIntPipe) id: number, @Body() body: ReleaseDto, @User() user: CurrentUser) {
    return this.svc.releaseRouting(id, body, user);
  }

  @Post(':id/new-version')
  @Perms('engineering')
  newVersion(@Param('id', ParseIntPipe) id: number, @Body() body: NewVersionDto, @User() user: CurrentUser) {
    return this.svc.routingNewVersion(id, body, user);
  }

  @Delete(':id')
  @Perms('engineering')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteRouting(id);
  }
}
