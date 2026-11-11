import { Module } from '@nestjs/common';
import { QmsController } from './qms.controller';
import { QualityService } from './quality.service';

/** 质量：IQC 检验、AQL、NCR、CAPA（QualityService 供 WMS 收货调用） */
@Module({ controllers: [QmsController], providers: [QualityService], exports: [QualityService] })
export class QmsModule {}
