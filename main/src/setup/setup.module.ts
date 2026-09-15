import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EditionModule } from '../edition/edition.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { SetupService } from './setup.service';
import { SetupController } from './setup.controller';

@Module({
  imports: [DbModule, EditionModule, ModelRouterModule],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
