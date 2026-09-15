import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AnalyticsModule } from '../platform/analytics/analytics.module';
import { EditionService } from './edition.service';
import { EditionController } from './edition.controller';
import { EditionGuard } from './edition.guard';

@Module({
  imports: [DbModule, AnalyticsModule],
  controllers: [EditionController],
  providers: [EditionService, EditionGuard],
  exports: [EditionService, EditionGuard],
})
export class EditionModule {}
