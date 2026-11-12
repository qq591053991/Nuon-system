import { Module } from '@nestjs/common';
import { AuthController } from '../auth/auth.controller';
import { config } from '../config';
import { AuditSealService } from './audit-seal.service';
import { SettingsController } from './settings.controller';
import { ExportController } from './export.controller';
import { SystemController } from './system.controller';
import { TestSupportController } from './test-support.controller';

@Module({
  controllers: [ExportController, AuthController, SystemController, SettingsController, ...(config.enableTestReset ? [TestSupportController] : [])],
  providers: [AuditSealService],
  exports: [AuditSealService],
})
export class SystemModule {}
