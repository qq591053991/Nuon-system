import { Controller, Get, Param, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { ImportService } from './import.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 数据导入：GET 模板（.xlsx），POST 上传（multipart 字段 file，.xlsx 或 .csv） */
@Controller('import')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  @Get('templates/:entity')
  async template(@Param('entity') entity: string) {
    const buf = await this.svc.template(entity);
    return new StreamableFile(buf, { type: XLSX_MIME, disposition: `attachment; filename=${entity}_template.xlsx` });
  }

  @Post(':entity')
  @Perms('master', 'engineering', 'wms')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  run(@Param('entity') entity: string, @UploadedFile() file: Express.Multer.File | undefined, @User() user: CurrentUser) {
    return this.svc.run(entity, file, user);
  }
}
