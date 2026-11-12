import { Module } from '@nestjs/common';
import { QmsController } from './qms.controller';
import { QualityService } from './quality.service';
import { InspectionSpecController } from './inspection-spec.controller';
import { ComplaintController } from './complaint.controller';
import { ComplaintService } from './complaint.service';
import { SupplierReturnController } from './supplier-return.controller';
import { SupplierReturnService } from './supplier-return.service';
import { ReleaseCheckController } from './release-check.controller';
import { ReleaseCheckService } from './release-check.service';

/** 质量：IQC 检验、AQL、NCR、CAPA、客诉、退供应商单、放行结论（QualityService 供 WMS 收货调用） */
@Module({
  controllers: [QmsController, InspectionSpecController, ComplaintController, SupplierReturnController, ReleaseCheckController],
  providers: [QualityService, ComplaintService, SupplierReturnService, ReleaseCheckService],
  exports: [QualityService],
})
export class QmsModule {}
