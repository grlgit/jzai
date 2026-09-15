import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { ExcelExportService } from './excel-export.service';
import { ExportController } from './export.controller';
import { PdfExportService } from '../pdf/pdf-export.service';
import { PdfChartRenderer } from '../pdf/pdf-chart.renderer';
import { PdfTemplateService } from '../pdf/pdf-template.service';
import { PdfTemplateController } from '../pdf/pdf-template.controller';
import { PdfExportController } from './pdf-export.controller';
import { UserModule } from '../../user/user.module';
import { SkillModule } from '../../capability/skill/skill.module';
import { McpRegistryModule } from '../../capability/mcp/mcp-registry.module';

@Module({
  imports: [UserModule, SkillModule, McpRegistryModule],
  controllers: [DashboardController, ExportController, PdfExportController, PdfTemplateController],
  providers: [DashboardService, ExcelExportService, PdfExportService, PdfChartRenderer, PdfTemplateService],
  exports: [DashboardService, ExcelExportService, PdfExportService, PdfChartRenderer, PdfTemplateService],
})
export class DashboardModule {}
