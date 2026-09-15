import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import { CredentialService } from '../../capability/skill/credential.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ExcelExportService {
  private readonly logger = new Logger(ExcelExportService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly credentialService: CredentialService,
    private readonly mcpRegistry: McpRegistryService,
  ) {}

  /**
   * Generate an Excel file from spec (LLM provides structure, backend fetches data).
   * Returns { filePath, filename, fileId }.
   */
  async generateExcel(userId: string, spec: {
    filename: string;
    sheets: SheetSpec[];
  }): Promise<{ filePath: string; filename: string; fileId: string }> {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const sheetDataMap = new Map<string, { columns: string[]; rows: any[] }>();

    for (const sheet of spec.sheets) {
      // Fetch data if data_source provided
      let rows: any[] = sheet.rows || [];
      let columns: string[] = [];

      // Support both rows and data.rows format for compatibility
      if (sheet.data?.rows && Array.isArray(sheet.data.rows)) {
        rows = sheet.data.rows;
        columns = sheet.data.columns || [];
      }

      // Handle 2D array format: convert to object array
      if (rows.length > 0 && Array.isArray(rows[0])) {
        const firstRow = rows[0] as any[];
        const headers = columns.length > 0 ? columns : firstRow;
        const dataRows = rows.slice(columns.length > 0 ? 0 : 1);

        // Convert 2D array to object array
        rows = dataRows.map((row: any[]) => {
          const obj: any = {};
          headers.forEach((header, i) => {
            obj[header] = row[i];
          });
          return obj;
        });
        columns = headers as string[];
      }

      if (sheet.data_source?.type === 'mcp' && sheet.data_source.mcp_name && sheet.data_source.query) {
        try {
          const result = await this.executeMcpQuery(sheet.data_source.mcp_name, sheet.data_source.query);
          this.logger.log(`Sheet "${sheet.name}" query result keys: ${result ? Object.keys(result).join(',') : 'null'}, success=${result?.success}, rows=${result?.rows?.length ?? 'N/A'}, data.rows=${result?.data?.rows?.length ?? 'N/A'}`);
          // Handler may return { rows } directly or { data: { rows } } or { success, data: { rows } }
          const dataRows = result?.rows || result?.data?.rows;
          const dataCols = result?.columns || result?.data?.columns;
          if (dataRows) { rows = dataRows; columns = dataCols || []; }
          this.logger.log(`Sheet "${sheet.name}" data: ${rows.length} rows, ${columns.length} cols`);
        } catch (err: any) {
          this.logger.error(`Sheet "${sheet.name}" query failed: ${err.message}`);
        }
      }

      if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0]);

      // Apply column overrides
      const colDefs = sheet.columns?.length
        ? sheet.columns
        : columns.map(k => ({ key: k, header: k, width: Math.max(12, k.length * 1.5) }));

      sheetDataMap.set(sheet.name, { columns, rows });

      if (sheet.type === 'table' || !sheet.type) {
        this.buildTableSheet(wb, sheet, colDefs, rows);
      } else if (sheet.type === 'summary') {
        // Try source_sheet first, then own data, then first available table data
        let srcData = sheet.source_sheet ? sheetDataMap.get(sheet.source_sheet) : null;
        if (!srcData?.rows?.length && rows.length > 0) srcData = { columns, rows };
        if (!srcData?.rows?.length) {
          // Fallback: use first table sheet with data
          for (const [, d] of sheetDataMap) { if (d.rows.length > 0) { srcData = d; break; } }
        }
        const summaryRows = srcData?.rows || [];
        const summaryCols = srcData?.columns || columns;
        this.logger.log(`Summary sheet "${sheet.name}": source="${sheet.source_sheet}", groupBy="${sheet.groupBy}", metrics=${JSON.stringify(sheet.metrics?.length)}, srcRows=${summaryRows.length}`);
        this.buildSummarySheet(wb, sheet, summaryRows, summaryCols);
      } else if (sheet.type === 'chart') {
        let srcData = sheet.source_sheet ? sheetDataMap.get(sheet.source_sheet) : null;
        if (!srcData?.rows?.length && rows.length > 0) srcData = { columns, rows };
        if (!srcData?.rows?.length) {
          for (const [, d] of sheetDataMap) { if (d.rows.length > 0) { srcData = d; break; } }
        }
        this.buildChartSheet(wb, sheet, srcData || { columns, rows });
      } else if (sheet.type === 'gantt') {
        this.buildGanttSheet(wb, sheet, colDefs, rows);
      }
    }

    // Save file
    const exportDir = this.workspace.getExportDir(userId);
    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const safeName = spec.filename.replace(/[\/\\:*?"<>|]/g, '_');
    const filename = safeName.endsWith('.xlsx') ? safeName : `${safeName}.xlsx`;
    const filePath = path.join(exportDir, `${fileId}_${filename}`);
    await wb.xlsx.writeFile(filePath);

    this.logger.log(`Excel generated: ${filePath} (${spec.sheets.length} sheets)`);
    return { filePath, filename, fileId: `${fileId}_${filename}` };
  }

  /**
   * Read an existing Excel file and return as JSON (for Univer frontend).
   */
  async readExcelAsJson(userId: string, fileId: string): Promise<any> {
    const ExcelJS = require('exceljs');
    const filePath = path.join(this.workspace.getExportDir(userId), fileId);
    if (!fs.existsSync(filePath)) return null;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    const sheets: any[] = [];
    wb.eachSheet((ws: any) => {
      const rows: any[][] = [];
      ws.eachRow({ includeEmpty: true }, (row: any, rowNum: number) => {
        const cells: any[] = [];
        row.eachCell({ includeEmpty: true }, (cell: any, colNum: number) => {
          cells[colNum - 1] = {
            v: cell.value?.result !== undefined ? cell.value.result : cell.value,
            f: cell.value?.formula || undefined,
            s: cell.style ? {
              bold: cell.font?.bold,
              color: cell.font?.color?.argb,
              bgColor: cell.fill?.fgColor?.argb,
              numFmt: cell.numFmt,
            } : undefined,
          };
        });
        rows[rowNum - 1] = cells;
      });

      const colWidths: number[] = [];
      ws.columns?.forEach((col: any, i: number) => { colWidths[i] = col.width || 12; });

      sheets.push({ name: ws.name, rows, colWidths, rowCount: ws.rowCount, colCount: ws.columnCount });
    });

    return { filename: path.basename(filePath), sheets };
  }

  /**
   * Save Univer JSON data back to xlsx file.
   */
  async saveJsonToExcel(userId: string, fileId: string, data: { sheets: any[] }): Promise<boolean> {
    const ExcelJS = require('exceljs');
    const filePath = path.join(this.workspace.getExportDir(userId), fileId);
    if (!fs.existsSync(filePath)) return false;

    const wb = new ExcelJS.Workbook();

    for (const sheet of data.sheets) {
      const ws = wb.addWorksheet(sheet.name);
      if (sheet.colWidths) {
        ws.columns = sheet.colWidths.map((w: number, i: number) => ({ width: w || 12 }));
      }
      for (let r = 0; r < (sheet.rows || []).length; r++) {
        const rowData = sheet.rows[r];
        if (!rowData) continue;
        const row = ws.getRow(r + 1);
        for (let c = 0; c < rowData.length; c++) {
          const cell = rowData[c];
          if (!cell) continue;
          const wsCell = row.getCell(c + 1);
          if (cell.f) {
            wsCell.value = { formula: cell.f, result: cell.v };
          } else {
            wsCell.value = cell.v;
          }
          if (cell.s) {
            if (cell.s.bold) wsCell.font = { ...wsCell.font, bold: true };
            if (cell.s.numFmt) wsCell.numFmt = cell.s.numFmt;
          }
        }
        row.commit();
      }
    }

    await wb.xlsx.writeFile(filePath);
    return true;
  }

  /**
   * Update specific cells in an existing Excel file (AI tool).
   */
  async updateCells(userId: string, fileId: string, updates: { cell: string; value?: any; formula?: string; format?: string }[], addColumn?: { after: string; header: string; formula?: string }): Promise<{ updated: number }> {
    const ExcelJS = require('exceljs');
    const filePath = path.join(this.workspace.getExportDir(userId), fileId);
    if (!fs.existsSync(filePath)) throw new Error('文件不存在');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.getWorksheet(1);
    if (!ws) throw new Error('工作表不存在');

    let count = 0;

    // Add column if requested
    if (addColumn) {
      const afterCol = this.colNameToNum(addColumn.after);
      ws.spliceColumns(afterCol + 1, 0, []);
      const headerCell = ws.getRow(1).getCell(afterCol + 1);
      headerCell.value = addColumn.header;
      headerCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

      if (addColumn.formula) {
        for (let r = 2; r <= ws.rowCount; r++) {
          const formula = addColumn.formula.replace(/\{row\}/g, String(r));
          ws.getRow(r).getCell(afterCol + 1).value = { formula };
        }
      }
      count++;
    }

    // Apply cell updates
    for (const u of updates) {
      const parsed = this.parseCellRange(u.cell);
      for (const { row, col } of parsed) {
        const cell = ws.getRow(row).getCell(col);
        if (u.formula) {
          cell.value = { formula: u.formula };
        } else if (u.value !== undefined) {
          cell.value = u.value;
        }
        if (u.format) cell.numFmt = u.format;
        count++;
      }
    }

    await wb.xlsx.writeFile(filePath);
    return { updated: count };
  }

  /**
   * List Excel files for a user.
   */
  listFiles(userId: string): { fileId: string; filename: string; size: number; created: string }[] {
    const dir = this.workspace.getExportDir(userId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.xlsx'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        // Extract display name: remove timestamp prefix
        const displayName = f.replace(/^\d+_[a-z0-9]+_/, '');
        return { fileId: f, filename: displayName, size: stat.size, created: stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  // ===== Private helpers =====

  private async executeMcpQuery(mcpName: string, sql: string): Promise<any> {
    const mcp = this.mcpRegistry.get(mcpName);
    if (!mcp || !mcp.handlerCode) throw new Error(`MCP "${mcpName}" 不存在或无 handler`);
    const authSystem = mcp.authSystem || mcp.system || mcp.name;
    const creds = this.credentialService.resolveCredentials('', authSystem, mcp.authScope);
    if (!creds) throw new Error(`MCP "${mcpName}" 凭证缺失`);

    let code = mcp.handlerCode.replace(/import\s+.*?from\s+.*?;?\n?/g, '').replace(/export\s+/g, '').replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
    const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
    const result = await fn(require, { params: { sql }, credentials: creds, tool: 'execute_query', toolName: 'execute_query' });
    this.logger.debug(`executeMcpQuery "${mcpName}": keys=${result ? Object.keys(result).join(',') : 'null'}, rows=${result?.rows?.length ?? 'N/A'}, success=${result?.success}`);
    return result;
  }

  private buildTableSheet(wb: any, spec: SheetSpec, colDefs: any[], rows: any[]) {
    const ws = wb.addWorksheet(spec.name);

    // Header row
    ws.columns = colDefs.map((c: any) => ({ key: c.key, header: c.header, width: c.width || 14 }));
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    headerRow.alignment = { horizontal: 'center' };
    headerRow.border = { bottom: { style: 'thin', color: { argb: 'FF4472C4' } } };

    // Data rows with alternating colors
    for (let i = 0; i < rows.length; i++) {
      const row = ws.addRow(rows[i]);
      if (i % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      }
      row.border = { bottom: { style: 'hair', color: { argb: 'FFE0E0E0' } } };
    }

    // Auto-filter + freeze
    ws.autoFilter = { from: 'A1', to: `${this.numToColName(colDefs.length)}1` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Apply formulas
    if (spec.formulas) {
      for (const f of spec.formulas) {
        const cell = ws.getCell(f.cell);
        cell.value = { formula: f.formula };
      }
    }
  }

  private buildSummarySheet(wb: any, spec: SheetSpec, rows: any[], srcColumns?: string[]) {
    if (!rows.length) return;

    // Auto-detect groupBy and metrics if not provided
    let groupBy = spec.groupBy;
    let metrics = spec.metrics || [];

    if (!groupBy && srcColumns?.length) {
      // Use first string-like column as groupBy, numeric columns as metrics
      const sampleRow = rows[0];
      for (const col of srcColumns) {
        if (!groupBy && typeof sampleRow[col] === 'string') { groupBy = col; continue; }
        if (typeof sampleRow[col] === 'number' && metrics.length < 5) {
          metrics.push({ field: col, agg: 'sum' as const, label: `${col}_合计` });
        }
      }
    }

    if (!groupBy || !metrics.length) {
      // Fallback: just copy the data as-is into a new sheet
      const ws = wb.addWorksheet(spec.name);
      const cols = srcColumns || Object.keys(rows[0]);
      ws.columns = cols.map(c => ({ header: c, key: c, width: 14 }));
      for (const row of rows) ws.addRow(row);
      return;
    }
    const ws = wb.addWorksheet(spec.name);

    // Group data
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = String(row[groupBy] ?? '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    // Headers
    const headers = [groupBy, ...metrics.map(m => m.label)];
    ws.columns = headers.map(h => ({ header: h, width: 16 }));
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E75B6' } };

    // Aggregated rows
    for (const [key, groupRows] of groups) {
      const rowData: any = { [groupBy]: key };
      for (const m of metrics) {
        const vals = groupRows.map(r => Number(r[m.field]) || 0);
        switch (m.agg) {
          case 'sum': rowData[m.label] = vals.reduce((a, b) => a + b, 0); break;
          case 'avg': rowData[m.label] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
          case 'count': rowData[m.label] = vals.length; break;
          case 'max': rowData[m.label] = Math.max(...vals); break;
          case 'min': rowData[m.label] = Math.min(...vals); break;
        }
      }
      ws.addRow(headers.map(h => rowData[h]));
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  private buildChartSheet(wb: any, spec: SheetSpec, srcData: any) {
    const ws = wb.addWorksheet(spec.name);
    if (!srcData?.rows?.length || !srcData?.columns?.length) {
      ws.getCell('A1').value = '无数据';
      return;
    }

    const chartType = spec.chartType || 'bar';
    let chartRows = srcData.rows;
    let chartCols = srcData.columns;

    // If too many rows for a chart, auto-aggregate smartly
    if (chartRows.length > 20) {
      const sampleRow = chartRows[0];
      const numCols: string[] = [];
      let dateCol: string | null = null;
      let categoryCol: string | null = null;

      for (const col of chartCols) {
        const val = sampleRow[col];
        if (typeof val === 'number') { numCols.push(col); continue; }
        // Detect date-like columns (Date object, or string matching date patterns)
        const strVal = String(val ?? '');
        const isDate = val instanceof Date || /^\d{4}[-\/]\d{2}/.test(strVal) || /\d{4}.*\d{2}.*\d{2}/.test(strVal);
        if (isDate && !dateCol) { dateCol = col; continue; }
        // Category: short text, not an ID (no long alphanumeric sequences)
        if (typeof val === 'string' && val.length < 30 && !/^[A-Z0-9]{8,}/.test(val) && !categoryCol) {
          categoryCol = col;
        }
      }

      // Line/curve charts prefer date grouping; pie/bar prefer category grouping
      let groupCol: string | null = null;
      if (chartType === 'line' || (chartType as string) === 'curve') {
        groupCol = dateCol || categoryCol;
      } else if (chartType === 'pie') {
        groupCol = categoryCol || dateCol;
      } else {
        groupCol = categoryCol || dateCol;
      }
      if (groupCol && numCols.length > 0) {
        const groups = new Map<string, any>();
        for (const row of chartRows) {
          const key = String(row[groupCol] ?? '').slice(0, 7); // truncate to month for dates
          if (!groups.has(key)) {
            const init: any = { [groupCol]: key };
            for (const nc of numCols) init[nc + '_sum'] = 0;
            init['_count'] = 0;
            groups.set(key, init);
          }
          const g = groups.get(key)!;
          for (const nc of numCols) g[nc + '_sum'] += Number(row[nc]) || 0;
          g['_count']++;
        }
        chartCols = [groupCol, ...numCols.slice(0, 4).map(c => c + '_sum'), '记录数'];
        chartRows = [...groups.values()].map(g => {
          const r: any = { [groupCol!]: g[groupCol!] };
          for (const nc of numCols.slice(0, 4)) r[nc + '_sum'] = Math.round(g[nc + '_sum'] * 100) / 100;
          r['记录数'] = g['_count'];
          return r;
        });
        this.logger.log(`Chart "${spec.name}": auto-aggregated ${srcData.rows.length} rows → ${chartRows.length} groups by "${groupCol}"`);
      }
    }

    // Write data as formatted table
    const headerRow = ws.addRow(chartCols);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: chartType === 'pie' ? 'FF2E75B6' : 'FF4472C4' } };

    for (let i = 0; i < chartRows.length; i++) {
      const row = chartRows[i];
      const dataRow = ws.addRow(chartCols.map((c: string) => row[c]));
      if (i % 2 === 1) {
        dataRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      }
    }

    ws.columns = chartCols.map((c: string) => ({ width: Math.max(14, c.length * 2) }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const noteRow = chartRows.length + 3;
    ws.getCell(`A${noteRow}`).value = `📊 图表类型: ${chartType === 'pie' ? '饼图' : chartType === 'line' ? '折线图' : '柱状图'}`;
    ws.getCell(`A${noteRow}`).font = { bold: true, color: { argb: 'FF4472C4' } };
    ws.getCell(`A${noteRow + 1}`).value = spec.chartTitle || spec.name;
    ws.getCell(`A${noteRow + 2}`).value = '提示: 在 Excel 中选择上方数据区域，插入图表即可可视化';
    ws.getCell(`A${noteRow + 2}`).font = { color: { argb: 'FF808080' }, italic: true };
  }

  private buildGanttSheet(wb: any, spec: SheetSpec, colDefs: any[], rows: any[]) {
    if (!spec.taskColumn || !spec.startColumn || !spec.endColumn || !rows.length) return;
    const ws = wb.addWorksheet(spec.name);

    const MIN_VALID_DATE = new Date('2000-01-01').getTime();
    const isValidDate = (d: Date) => !isNaN(d.getTime()) && d.getTime() > MIN_VALID_DATE;

    // Filter rows with valid start AND end dates
    const validRows = rows.filter(row => {
      const s = new Date(row[spec.startColumn!]);
      const e = new Date(row[spec.endColumn!]);
      return isValidDate(s) && isValidDate(e) && e >= s;
    });

    if (validRows.length === 0) {
      ws.getCell('A1').value = '无有效甘特图数据（缺少有效的开始/结束日期）';
      return;
    }

    // Find date range from valid rows only
    const allDates: Date[] = [];
    for (const row of validRows) {
      allDates.push(new Date(row[spec.startColumn!]));
      allDates.push(new Date(row[spec.endColumn!]));
    }

    const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
    const dayCount = Math.ceil((maxDate.getTime() - minDate.getTime()) / 86400000) + 1;

    // Auto-select period granularity based on date range
    const useMonths = dayCount > 365;
    const useWeeks = !useMonths && dayCount > 60;

    const periods: Date[] = [];
    const d = new Date(minDate);
    const maxPeriods = 200; // Cap to avoid excessive columns
    while (d <= maxDate && periods.length < maxPeriods) {
      periods.push(new Date(d));
      if (useMonths) d.setMonth(d.getMonth() + 1);
      else if (useWeeks) d.setDate(d.getDate() + 7);
      else d.setDate(d.getDate() + 1);
    }

    // Headers: Task | Start | End | date1 | date2 | ...
    const fixedCols = [spec.taskColumn, spec.startColumn, spec.endColumn];
    const periodLabels = periods.map(p => useMonths ? p.toISOString().slice(0, 7) : p.toISOString().slice(0, 10));
    ws.getRow(1).values = [...fixedCols, ...periodLabels];
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

    // Set column widths
    ws.getColumn(1).width = 22;
    ws.getColumn(2).width = 12;
    ws.getColumn(3).width = 12;
    const colWidth = useMonths ? 6 : useWeeks ? 5 : 3;
    for (let i = 4; i <= 3 + periods.length; i++) ws.getColumn(i).width = colWidth;

    // Data rows with Gantt bars (limited to 500 rows max for performance)
    const colors = ['FF4472C4', 'FF70AD47', 'FFFFC000', 'FF5B9BD5', 'FFED7D31'];
    const maxRows = Math.min(validRows.length, 500);
    for (let r = 0; r < maxRows; r++) {
      const row = validRows[r];
      const rowObj = ws.getRow(r + 2);
      const start = new Date(row[spec.startColumn!]);
      const end = new Date(row[spec.endColumn!]);

      rowObj.getCell(1).value = row[spec.taskColumn!];
      rowObj.getCell(2).value = start.toISOString().slice(0, 10);
      rowObj.getCell(3).value = end.toISOString().slice(0, 10);

      const color = colors[r % colors.length];
      for (let p = 0; p < periods.length; p++) {
        const pDate = periods[p];
        const pEnd = new Date(pDate);
        if (useMonths) pEnd.setMonth(pEnd.getMonth() + 1);
        else if (useWeeks) pEnd.setDate(pEnd.getDate() + 6);
        // Check overlap: task [start, end] overlaps period [pDate, pEnd]
        if (start <= pEnd && end >= pDate) {
          const cell = rowObj.getCell(4 + p);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        }
      }
    }

    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  }

  private colNameToNum(name: string): number {
    let num = 0;
    for (let i = 0; i < name.length; i++) {
      num = num * 26 + (name.charCodeAt(i) - 64);
    }
    return num;
  }

  private numToColName(num: number): string {
    let s = '';
    while (num > 0) { num--; s = String.fromCharCode(65 + (num % 26)) + s; num = Math.floor(num / 26); }
    return s;
  }

  private parseCellRange(ref: string): { row: number; col: number }[] {
    const results: { row: number; col: number }[] = [];
    const parts = ref.split(':');
    const parse = (c: string) => {
      const m = c.match(/^([A-Z]+)(\d+)$/);
      if (!m) return null;
      return { col: this.colNameToNum(m[1]), row: parseInt(m[2]) };
    };
    const start = parse(parts[0]);
    if (!start) return results;
    if (parts.length === 1) { results.push(start); return results; }
    const end = parse(parts[1]);
    if (!end) { results.push(start); return results; }
    for (let r = start.row; r <= end.row; r++) {
      for (let c = start.col; c <= end.col; c++) {
        results.push({ row: r, col: c });
      }
    }
    return results;
  }
}

interface SheetSpec {
  name: string;
  type?: 'table' | 'summary' | 'chart' | 'gantt';
  data_source?: { type: string; mcp_name: string; query: string };
  columns?: { key: string; header: string; width?: number }[];
  rows?: any[];
  formulas?: { cell: string; formula: string }[];
  source_sheet?: string;
  groupBy?: string;
  metrics?: { field: string; agg: 'sum' | 'avg' | 'count' | 'max' | 'min'; label: string }[];
  chartType?: 'bar' | 'line' | 'pie';
  chartTitle?: string;
  taskColumn?: string;
  startColumn?: string;
  endColumn?: string;
  // Support data.rows format for agent compatibility
  data?: { rows?: any[]; columns?: string[] };
}
