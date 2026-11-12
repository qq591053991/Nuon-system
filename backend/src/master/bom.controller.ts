import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { BomDto, NewVersionDto, RejectDto, SignOnlyDto, SubmitDto } from './engineering.dto';
import { EngineeringService, qInt } from './engineering.service';

/** 工程-BOM：草稿 →（工程师）提交 →（QA）批准发布 / 驳回 → 升版（ECN） */
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

  /** 电子签名记录（编制提交 / 驳回 / 批准） */
  @Get(':id/signatures')
  signatures(@Param('id', ParseIntPipe) id: number) {
    return this.svc.signatures('bom', id);
  }

  /** 与上一版本的差异（新增 / 删除 / 修改；上下限变化标记 limit）；?base= 指定对比版本 */
  @Get(':id/diff')
  diff(@Param('id', ParseIntPipe) id: number, @Query('base') base?: string) {
    return this.svc.bomDiff(id, qInt(base));
  }

  /** 未保存的编辑内容与上一版本的差异（编辑页实时对比，只读、无副作用） */
  @Post(':id/diff')
  diffDraft(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, any>, @Query('base') base?: string) {
    return this.svc.bomDiff(id, qInt(base), body);
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

  /** 工程师提交（电子签名：编制）；首版之后的版本须填写变更原因 */
  @Post(':id/submit')
  @Perms('engineering')
  submit(@Param('id', ParseIntPipe) id: number, @Body() body: SubmitDto, @User() user: CurrentUser) {
    return this.svc.submitBom(id, body, user);
  }

  /** QA 批准（电子签名：批准）；批准人不能是提交人 */
  @Post(':id/approve')
  @Perms('qa')
  approve(@Param('id', ParseIntPipe) id: number, @Body() body: SignOnlyDto, @User() user: CurrentUser) {
    return this.svc.approveBom(id, body, user);
  }

  /** QA 驳回（电子签名 + 原因），退回草稿 */
  @Post(':id/reject')
  @Perms('qa')
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: RejectDto, @User() user: CurrentUser) {
    return this.svc.rejectBom(id, body, user);
  }

  @Post(':id/new-version')
  @Perms('engineering')
  newVersion(@Param('id', ParseIntPipe) id: number, @Body() body: NewVersionDto, @User() user: CurrentUser) {
    return this.svc.bomNewVersion(id, body, user);
  }
}
