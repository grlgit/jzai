import { Module, forwardRef } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { ModelRouterController } from './model-router.controller';
import { EditionModule } from '../edition/edition.module';

@Module({
  imports: [forwardRef(() => EditionModule)],
  controllers: [ModelRouterController],
  providers: [ModelRouterService],
  exports: [ModelRouterService],
})
export class ModelRouterModule {}
