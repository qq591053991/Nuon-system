import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';
import { MesController } from './mes.controller';
import { ProductionService } from './production.service';

/** 生产执行（MES）：工单、工位报工、完工入库、DHR 与产品放行 */
@Module({ imports: [QmsModule], controllers: [MesController], providers: [ProductionService], exports: [ProductionService] })
export class MesModule {}
