import { Module } from '@nestjs/common';
import { DashboardModule } from './dashboard/dashboard.module';
import { OcrModule } from './media/ocr.module';
import { McpRegistryModule } from '../capability/mcp/mcp-registry.module';
import { SkillModule } from '../capability/skill/skill.module';
import { ChatSupportModule } from '../agent/support/chat-support.module';
import { MediaToolProvider } from './media/media.tools';
import { DatabaseToolProvider } from './database/database.tools';
import { DashboardToolProvider } from './dashboard/dashboard.tools';
import { ExcelToolProvider } from './excel/excel.tools';
import { PdfToolProvider } from './pdf/pdf.tools';
import { PdfWatermarkRemovalService } from './pdf/pdf-watermark-removal.service';


/**
 * DataModule — Domain 3: User data processing (dashboard, excel, database, media, pdf).
 */
@Module({
  imports: [DashboardModule, OcrModule, McpRegistryModule, SkillModule, ChatSupportModule],
  providers: [
    MediaToolProvider,
    DatabaseToolProvider,
    DashboardToolProvider,
    ExcelToolProvider,
    PdfToolProvider,
    PdfWatermarkRemovalService,
  ],
  exports: [MediaToolProvider, DatabaseToolProvider, DashboardToolProvider, ExcelToolProvider, PdfToolProvider],
})
export class DataModule {}
