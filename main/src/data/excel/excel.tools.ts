import { Injectable } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { ExcelExportService } from '../dashboard/excel-export.service';

@Injectable()
export class ExcelToolProvider implements ToolProvider {
  readonly toolIds = ['export_excel', 'update_excel_cells'];

  constructor(
    private readonly excelExportService: ExcelExportService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'export_excel', label: 'Excel导出', group: '数据' },
      { id: 'update_excel_cells', label: '修改Excel', group: '数据' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const tools: ToolInstance[] = [];

    // export_excel
    tools.push({
      name: 'export_excel',
      label: 'Excel导出',
      description: `生成 Excel 文件。后端直接执行 SQL 取数据并写入 Excel。

## 使用流程
1. 先用 search_db_schema 找到相关表和字段
2. 调用本工具，在 sheets 的 data_source 中传入 SQL，后端直接执行取数——**不要先查询数据再传入 rows**
3. 工具返回下载链接和 fileId，用户可在"数据仪表 → 工作表"中在线查看编辑

## 工作表类型

### table — 数据表（默认）
原始数据展示，自动格式化表头、斑马纹、冻结首行、筛选器。
\`\`\`json
{ "name": "原始数据", "type": "table",
  "data_source": { "type": "mcp", "mcp_name": "db-MOM-dev", "query": "SELECT ..." } }
\`\`\`

### summary — 汇总透视表
按字段分组聚合。groupBy 支持字段名或 "MONTH"/"YEAR" 按时间聚合。
\`\`\`json
{ "name": "月度汇总", "type": "summary",
  "source_sheet": "原始数据",
  "groupBy": "MONTH",
  "metrics": [{"field": "QTY", "agg": "sum", "label": "总数量"}, {"field": "QTY", "agg": "avg", "label": "平均"}] }
\`\`\`
agg 支持: sum, avg, count, min, max

### chart — 图表数据表
为图表准备的聚合数据表（折线图按日期聚合，饼图按分类聚合）。chartType: "line" | "pie" | "bar"。
\`\`\`json
{ "name": "趋势图", "type": "chart", "chartType": "line", "source_sheet": "原始数据" }
\`\`\`
也可自带 data_source 独立查询。数据量>20行时自动聚合。

### gantt — 甘特图
需要任务名、开始时间、结束时间三列，自动生成色块甘特图。
\`\`\`json
{ "name": "进度", "type": "gantt",
  "data_source": { "type": "mcp", "mcp_name": "db-MOM-dev", "query": "SELECT task, start_date, end_date FROM ..." },
  "taskColumn": "task", "startColumn": "start_date", "endColumn": "end_date" }
\`\`\`

## data_source 格式
外部数据库必须用 type="mcp"：
\`\`\`json
{ "type": "mcp", "mcp_name": "db-MOM-dev", "query": "SELECT ... FROM ..." }
\`\`\`
mcp_name 从 search_db_schema 结果中获取。

## 多表组合示例
一个文件可包含多个工作表，summary/chart 通过 source_sheet 引用 table 的数据：
\`\`\`json
{ "filename": "检验报告.xlsx", "sheets": [
  { "name": "数据", "type": "table", "data_source": {...} },
  { "name": "月度汇总", "type": "summary", "source_sheet": "数据", "groupBy": "MONTH", "metrics": [...] },
  { "name": "趋势", "type": "chart", "chartType": "line", "source_sheet": "数据" }
]}
\`\`\``,
      parameters: Type.Object({
        filename: Type.String({ description: '文件名，如"工序检验报告.xlsx"' }),
        sheets: Type.Array(Type.Any({ description: '工作表定义数组' })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          const result = await this.excelExportService.generateExcel(userId, args);
          const downloadUrl = `/api/exports/${result.fileId}/download`;
          return { content: [{ type: 'text' as const, text: `Excel 已生成：[📥 下载 ${args.filename}](${downloadUrl})\n\n文件ID: \`${result.fileId}\`（用于 update_excel_cells 修改此文件）\n\n可在"数据仪表 → 工作表"标签中在线查看和编辑。` }], details: {
            fileId: result.fileId, downloadUrl,
            __action: true, actionType: 'ui_hook',
            actionData: { panel: 'dashboard', hook: 'show-file', params: { fileId: result.fileId, fileName: args.filename } },
          } };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `Excel 生成失败: ${err.message}` }], details: null };
        }
      },
    });

    // update_excel_cells
    tools.push({
      name: 'update_excel_cells',
      label: '修改Excel',
      description: `修改已生成的 Excel 文件中的单元格（值、公式、格式）或新增列。

## 使用场景
用户要求对已导出的 Excel 做修改（加公式、改格式、新增计算列等）时使用。

## 修改单元格
updates 数组，每项指定 cell（如 "E2" 或 "E2:E100"），可设 value、formula、format：
- 设值: { "cell": "A1", "value": "标题" }
- 加公式: { "cell": "E2", "formula": "=C2/B2*100" }
- 改格式: { "cell": "E2:E100", "format": "0.00%" }

## 新增列
add_column 在指定列后插入新列并自动填充公式：
{ "after": "D", "header": "合格率", "formula": "=C{row}/B{row}*100" }
{row} 会自动替换为每行的行号（从第2行到末尾）。`,
      parameters: Type.Object({
        file_id: Type.String({ description: '文件ID（从 export_excel 返回的 fileId）' }),
        updates: Type.Optional(Type.Array(Type.Object({
          cell: Type.String({ description: '单元格引用，如 "E2" 或 "E2:E100"' }),
          value: Type.Optional(Type.Any()),
          formula: Type.Optional(Type.String()),
          format: Type.Optional(Type.String({ description: '数字格式，如 "0.00%" 或 "#,##0"' })),
        }))),
        add_column: Type.Optional(Type.Object({
          after: Type.String({ description: '在哪列后插入，如 "D"' }),
          header: Type.String({ description: '列标题' }),
          formula: Type.Optional(Type.String({ description: '自动填充公式，用 {row} 代替行号' })),
        })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          const result = await this.excelExportService.updateCells(userId, args.file_id, args.updates || [], args.add_column);
          return { content: [{ type: 'text' as const, text: `已更新 ${result.updated} 个单元格。` }], details: result };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `修改失败: ${err.message}` }], details: null };
        }
      },
    });

    return tools;
  }
}
