import { Module } from '@nestjs/common';
import { OcrService } from './ocr.service';
import { KnowledgeModule } from '../../knowledge/knowledge.module';

@Module({
  imports: [KnowledgeModule],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
