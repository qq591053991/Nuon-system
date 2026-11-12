import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth';
import { AllExceptionsFilter, JsonInterceptor } from './common/http';
import { config } from './config';
import { CoreModule } from './core/core.module';
import { SystemModule } from './system/system.module';
import { HealthController } from './health.controller';
// --- 业务模块（按领域划分） ---
import { MasterModule } from './master/master.module';
import { ErpModule } from './erp/erp.module';
import { PlanModule } from './erp/plan.module';
import { WmsModule } from './wms/wms.module';
import { QmsModule } from './qms/qms.module';
import { MesModule } from './mes/mes.module';
import { ReportModule } from './report/report.module';
import { ImportModule } from './imports/import.module';
import { AttachmentsModule } from './attachments/attachments.module';

@Module({
  imports: [
    JwtModule.register({ global: true, secret: config.secretKey, signOptions: { expiresIn: `${config.tokenExpireMinutes}m` } }),
    CoreModule,
    SystemModule,
    MasterModule,
    ErpModule,
    PlanModule,
    WmsModule,
    QmsModule,
    MesModule,
    ReportModule,
    ImportModule,
    AttachmentsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: JsonInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
