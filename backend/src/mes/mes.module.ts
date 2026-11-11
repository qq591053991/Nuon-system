import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';
import { MesController } from './mes.controller';
import { ProductionService } from './production.service';
import { QualificationController } from './qualification.controller';

/** 生产执行（MES）：工单、工位报工、返工换件、完工入库、DHR 与产品放行（分批）、人员上岗资质 */
@Module({ imports: [QmsModule], controllers: [MesController, QualificationController], providers: [ProductionService], exports: [ProductionService] })
export class MesModule {}
