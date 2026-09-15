import { Module } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { SystemRegistryService } from './system-registry.service';
import { FileParserService } from './file-parser.service';
import { ModelRouterModule } from '../../model-router/model-router.module';
import { OcrModule } from '../../data/media/ocr.module';

@Module({
  imports: [ModelRouterModule, OcrModule],
  controllers: [AutomationController],
  providers: [AutomationService, SystemRegistryService, FileParserService],
  exports: [AutomationService],
})
export class AutomationModule {}
