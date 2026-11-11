import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';

@Module({ imports: [QmsModule] })
export class MesModule {}
