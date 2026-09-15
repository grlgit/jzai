import { Module } from '@nestjs/common';
import { OcrService } from './ocr.service';
import { KbModule } from '../../bridge/knowledge/kb.module';

@Module({
  imports: [KbModule],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
