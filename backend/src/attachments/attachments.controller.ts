/**
 * 附件接口（质量证据永久保存，不提供删除）：
 *   POST /attachments                       multipart：file + entity（表名，如 qms_inspection）+ entity_id
 *   GET  /attachments?entity=&entity_id=    某单据的附件列表
 *   GET  /attachments/:id/download          下载（原文件名；sha256 校验）
 */
import {
  ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Param, ParseIntPipe, PayloadTooLargeException, Post, Query,
  StreamableFile, UploadedFile, UseFilters, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsInt, IsString } from 'class-validator';
import type { Response } from 'express';
import { User } from '../auth';
import type { CurrentUser } from '../common/context';
import { config } from '../config';
import { AttachmentsService, contentDisposition, type UploadedFileLike } from './attachments.service';

class UploadDto {
  @IsString() entity: string;
  @Type(() => Number) @IsInt() entity_id: number;
}

/** 超过大小上限时返回中文提示 */
@Catch(PayloadTooLargeException)
class FileTooLargeFilter implements ExceptionFilter {
  catch(_e: PayloadTooLargeException, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().status(413).json({ detail: `附件不能超过 ${config.attachmentMaxMb} MB` });
  }
}

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  @Post()
  @UseFilters(FileTooLargeFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.attachmentMaxMb * 1024 * 1024, files: 1 }, defParamCharset: 'utf8' }))
  async upload(@UploadedFile() file: UploadedFileLike | undefined, @Body() b: UploadDto, @User() user: CurrentUser) {
    const { storage_key: _k, ...row } = await this.svc.upload(file, b.entity, b.entity_id, user);
    return { ...row, uploaded_by_name: user.full_name };
  }

  @Get()
  list(@Query('entity') entity: string, @Query('entity_id') entityId: string) {
    return this.svc.list(entity, Number(entityId));
  }

  @Get(':id/download')
  async download(@Param('id', ParseIntPipe) id: number) {
    const { row, data } = await this.svc.read(id);
    return new StreamableFile(data, { type: row.content_type || 'application/octet-stream', disposition: contentDisposition(row.filename), length: data.length });
  }
}
