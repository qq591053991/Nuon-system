import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

/** 附件：任意单据挂文件（内容寻址存储 + sha256 校验，永久保存） */
@Module({ controllers: [AttachmentsController], providers: [AttachmentsService], exports: [AttachmentsService] })
export class AttachmentsModule {}
