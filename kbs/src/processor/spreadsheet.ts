/**
 * 表格提取（xlsx/SheetJS）— 对译 openpyxl 路径：每 sheet 一页，
 * 行内单元格 " | " 连接，elements = {"sheet_name"}。
 */
import * as XLSX from 'xlsx';

export interface SheetPage {
  page: number;
  content: string;
  sheetName: string;
}

export function extractSpreadsheet(filePath: string): SheetPage[] {
  const wb = XLSX.readFile(filePath, { dense: true });
  const pages: SheetPage[] = [];
  wb.SheetNames.forEach((sheetName, i) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      raw: true,
      defval: '',
    });
    const content = rows
      .map((row) => row.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | '))
      .join('\n');
    pages.push({ page: i + 1, content, sheetName });
  });
  return pages;
}
