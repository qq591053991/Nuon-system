import { Module } from '@nestjs/common';
import { KittingService } from './kitting.service';
import { KittingController, WoAdjustController } from './plan.controller';
import { WoAdjustService } from './wo-adjust.service';

/** 计划（G3）：齐套分析（只读）、工单下达后调整 */
@Module({
  controllers: [KittingController, WoAdjustController],
  providers: [KittingService, WoAdjustService],
  exports: [KittingService],
})
export class PlanModule {}
