import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { NewVersionDto, RejectDto, SignOnlyDto, SubmitDto, RoutingDto } from './engineering.dto';
import { EngineeringService } from './engineering.service';

/** 工程-工艺路线（工序 + 测试规格上下限）：草稿 →（工程师）提交 →（QA）批准发布 / 驳回 → 升版 */
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

  /** 工程师提交（电子签名：编制）；首版之后的版本须填写变更原因 */
  @Post(':id/submit')
  @Perms('engineering')
  submit(@Param('id', ParseIntPipe) id: number, @Body() body: SubmitDto, @User() user: CurrentUser) {
    return this.svc.submitRouting(id, body, user);
  }

  /** QA 批准（电子签名：批准）；批准人不能是提交人 */
  @Post(':id/approve')
  @Perms('qa')
  approve(@Param('id', ParseIntPipe) id: number, @Body() body: SignOnlyDto, @User() user: CurrentUser) {
    return this.svc.approveRouting(id, body, user);
  }

  /** QA 驳回（电子签名 + 原因），退回草稿 */
  @Post(':id/reject')
  @Perms('qa')
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: RejectDto, @User() user: CurrentUser) {
    return this.svc.rejectRouting(id, body, user);
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
