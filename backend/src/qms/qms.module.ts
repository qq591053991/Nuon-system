import { Module } from '@nestjs/common';
import { QmsController } from './qms.controller';
import { QualityService } from './quality.service';
import { InspectionSpecController } from './inspection-spec.controller';
import { ComplaintController } from './complaint.controller';
import { ComplaintService } from './complaint.service';

/** 质量：IQC 检验、AQL、NCR、CAPA（QualityService 供 WMS 收货调用） */
@Module({
  controllers: [QmsController, InspectionSpecController, ComplaintController],
  providers: [QualityService, ComplaintService],
  exports: [QualityService],
})
export class QmsModule {}
