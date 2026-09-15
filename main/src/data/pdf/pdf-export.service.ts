import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import { FileCleanupService } from '../../workspace/file-cleanup.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { CredentialService } from '../../capability/skill/credential.service';
import { PdfChartRenderer } from './pdf-chart.renderer';
import * as fs from 'fs';
import * as path from 'path';

/** Section definitions that compose a PDF document */
export type PdfSection =
  | { type: 'heading'; level?: number; text: string; style?: string }
  | { type: 'paragraph'; text: string; style?: string }
  | { type: 'table'; columns?: { key: string; header: string }[]; data_source?: string; mcp?: string; data?: any[]; style?: string }
  | { type: 'chart'; chartType: string; data_source?: string; mcp?: string; data?: any; title?: string; width?: number; height?: number; colors?: string[] }
  | { type: 'key_values'; title?: string; items: { label: string; value: string }[]; layout?: 'grid' | 'list' }
  | { type: 'image'; base64?: string; caption?: string; width?: number }
  | { type: 'page_break' };

export interface PdfSpec {
  filename: string;
  title?: string;
  sections: PdfSection[];
  page?: { size?: string; orientation?: string; margins?: number[] };
  header?: { left?: string; right?: string; logo?: boolean; borderBottom?: boolean };
  footer?: { center?: string; right?: string };
  styles?: Record<string, any>;
}

export interface PdfDocStructure {
  spec: PdfSpec;
  generatedAt: string;
}

// Layout constants
const PAGE_SIZES: Record<string, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  LETTER: [612, 792],
};

const COLORS = {
  heading: { r: 0.1, g: 0.1, b: 0.18 },
  text: { r: 0.15, g: 0.15, b: 0.15 },
  muted: { r: 0.6, g: 0.6, b: 0.6 },
  headerBg: { r: 0.31, g: 0.27, b: 0.89 },
  headerText: { r: 1, g: 1, b: 1 },
  stripeBg: { r: 0.97, g: 0.97, b: 1 },
  border: { r: 0.88, g: 0.88, b: 0.88 },
};

@Injectable()
export class PdfExportService {
  private readonly logger = new Logger(PdfExportService.name);
  private cachedFontBytes: Buffer | null = null;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly credentialService: CredentialService,
    private readonly chartRenderer: PdfChartRenderer,
    private readonly fileCleanup: FileCleanupService,
  ) {}

  private getFontBytes(): Buffer | null {
    if (this.cachedFontBytes) return this.cachedFontBytes;
    // Try multiple paths (dist vs src)
    const candidates = [
      path.join(__dirname, 'fonts', 'NotoSansSC-Regular.ttf'),
      path.join(process.cwd(), 'src', 'data', 'pdf', 'fonts', 'NotoSansSC-Regular.ttf'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.cachedFontBytes = fs.readFileSync(p);
        this.logger.log(`Loaded NotoSansSC font from ${p}`);
        return this.cachedFontBytes;
      }
    }
    this.logger.warn('NotoSansSC font not found');
    return null;
  }

  /**
   * Generate a PDF file from spec. Returns fileId + path.
   */
  async generatePdf(userId: string, spec: PdfSpec): Promise<{ filePath: string; filename: string; fileId: string }> {
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

    const doc = await PDFDocument.create();

    // Embed font
    let font: any;
    const fontBytes = this.getFontBytes();
    if (fontBytes) {
      const fontkit = require('fontkit');
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(fontBytes, { subset: true });
    } else {
      font = await doc.embedFont(StandardFonts.Helvetica);
    }
    const boldFont = font; // Same font for bold (variable weight)

    // Page dimensions
    const pageKey = (spec.page?.size || 'A4').toUpperCase();
    let [pageW, pageH] = PAGE_SIZES[pageKey] || PAGE_SIZES.A4;
    if (spec.page?.orientation === 'landscape') [pageW, pageH] = [pageH, pageW];

    const margins = spec.page?.margins || [40, 60, 40, 60]; // left, top, right, bottom
    const [mLeft, mTop, mRight, mBottom] = margins;
    const contentWidth = pageW - mLeft - mRight;

    // Simple layout cursor
    let page = doc.addPage([pageW, pageH]);
    let cursorY = pageH - mTop;

    const ensureSpace = (needed: number) => {
      if (cursorY - needed < mBottom) {
        addHeaderFooter(page, doc.getPageCount());
        page = doc.addPage([pageW, pageH]);
        cursorY = pageH - mTop;
      }
    };

    const addHeaderFooter = (p: any, pageNum: number) => {
      const totalPages = '?'; // Will be updated at end
      if (spec.header) {
        const left = spec.header.left || '';
        const right = spec.header.right || '';
        if (left) p.drawText(left, { x: mLeft, y: pageH - 20, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
        if (right) {
          const rw = font.widthOfTextAtSize(right, 8);
          p.drawText(right, { x: pageW - mRight - rw, y: pageH - 20, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
        }
        if (spec.header.borderBottom) {
          p.drawLine({ start: { x: mLeft, y: pageH - 30 }, end: { x: pageW - mRight, y: pageH - 30 }, thickness: 0.5, color: rgb(0.88, 0.88, 0.88) });
        }
      }
      if (spec.footer) {
        const center = (spec.footer.center || '').replace(/\{\{page\}\}/g, String(pageNum)).replace(/\{\{pages\}\}/g, String(totalPages));
        const right = spec.footer.right || '';
        if (center) {
          const cw = font.widthOfTextAtSize(center, 8);
          p.drawText(center, { x: (pageW - cw) / 2, y: 20, size: 8, font, color: rgb(0.67, 0.67, 0.67) });
        }
        if (right) {
          const rw = font.widthOfTextAtSize(right, 8);
          p.drawText(right, { x: pageW - mRight - rw, y: 20, size: 8, font, color: rgb(0.67, 0.67, 0.67) });
        }
      }
    };

    // Render sections
    for (const section of spec.sections) {
      switch (section.type) {
        case 'heading': {
          const sStyle = (section as any).style || {};
          const sizes = [22, 16, 13];
          const size = sStyle.fontSize || sizes[(section.level || 1) - 1] || 13;
          ensureSpace(size + 20);
          cursorY -= size + 8;
          const lines = this.wrapText(section.text, font, size, contentWidth);
          // Background color support
          if (sStyle.backgroundColor) {
            const bgColor = this.parseColor(sStyle.backgroundColor);
            const blockH = lines.length * (size + 4) + 8;
            page.drawRectangle({ x: mLeft - 4, y: cursorY - blockH + size + 4, width: contentWidth + 8, height: blockH, color: rgb(bgColor.r, bgColor.g, bgColor.b) });
          }
          const textColor = sStyle.color ? this.parseColor(sStyle.color) : COLORS.heading;
          for (const line of lines) {
            page.drawText(line, { x: mLeft, y: cursorY, size, font: boldFont, color: rgb(textColor.r, textColor.g, textColor.b) });
            cursorY -= size + 4;
          }
          cursorY -= 4;
          break;
        }

        case 'paragraph': {
          const sStyle = (section as any).style || {};
          const size = sStyle.fontSize || 10;
          const isBold = sStyle.bold || sStyle.fontWeight === 'bold';
          const lines = this.wrapText(section.text, font, size, contentWidth);
          ensureSpace(size + 8);
          // Background color support
          if (sStyle.backgroundColor) {
            const bgColor = this.parseColor(sStyle.backgroundColor);
            const blockH = lines.length * (size + 4) + 6;
            page.drawRectangle({ x: mLeft - 4, y: cursorY - blockH + size + 2, width: contentWidth + 8, height: blockH, color: rgb(bgColor.r, bgColor.g, bgColor.b) });
          }
          const textColor = sStyle.color ? this.parseColor(sStyle.color) : COLORS.text;
          for (const line of lines) {
            ensureSpace(size + 4);
            page.drawText(line, { x: mLeft, y: cursorY, size, font: isBold ? boldFont : font, color: rgb(textColor.r, textColor.g, textColor.b) });
            cursorY -= size + 4;
          }
          cursorY -= 8;
          break;
        }

        case 'table': {
          let rows: any[] = (section as any).data || [];
          if ((section as any).data_source && !rows.length) {
            rows = await this.fetchData((section as any).data_source, (section as any).mcp);
          }
          if (rows.length === 0) {
            ensureSpace(20);
            page.drawText('(无数据)', { x: mLeft, y: cursorY, size: 10, font, color: rgb(0.6, 0.6, 0.6) });
            cursorY -= 20;
            break;
          }

          const columns = (section as any).columns?.length
            ? (section as any).columns
            : Object.keys(rows[0]).map((k: string) => ({ key: k, header: k }));

          const colWidth = contentWidth / columns.length;
          const rowHeight = 18;
          const fontSize = 9;

          // Header row
          ensureSpace(rowHeight + 4);
          page.drawRectangle({ x: mLeft, y: cursorY - rowHeight, width: contentWidth, height: rowHeight, color: rgb(COLORS.headerBg.r, COLORS.headerBg.g, COLORS.headerBg.b) });
          columns.forEach((col: any, i: number) => {
            const text = this.truncateText(col.header || col.key, font, fontSize, colWidth - 8);
            page.drawText(text, { x: mLeft + i * colWidth + 4, y: cursorY - 13, size: fontSize, font: boldFont, color: rgb(1, 1, 1) });
          });
          cursorY -= rowHeight;

          // Data rows (limit to 200)
          for (let r = 0; r < Math.min(rows.length, 200); r++) {
            ensureSpace(rowHeight);
            if (r % 2 === 0) {
              page.drawRectangle({ x: mLeft, y: cursorY - rowHeight, width: contentWidth, height: rowHeight, color: rgb(COLORS.stripeBg.r, COLORS.stripeBg.g, COLORS.stripeBg.b) });
            }
            // Horizontal line
            page.drawLine({ start: { x: mLeft, y: cursorY }, end: { x: mLeft + contentWidth, y: cursorY }, thickness: 0.3, color: rgb(COLORS.border.r, COLORS.border.g, COLORS.border.b) });
            columns.forEach((col: any, i: number) => {
              const val = rows[r][col.key];
              const text = this.truncateText(val != null ? String(val) : '', font, fontSize, colWidth - 8);
              page.drawText(text, { x: mLeft + i * colWidth + 4, y: cursorY - 13, size: fontSize, font, color: rgb(COLORS.text.r, COLORS.text.g, COLORS.text.b) });
            });
            cursorY -= rowHeight;
          }
          if (rows.length > 200) {
            cursorY -= 4;
            page.drawText(`... 共 ${rows.length} 行，显示前 200 行`, { x: mLeft, y: cursorY, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
            cursorY -= 16;
          }
          cursorY -= 12;
          break;
        }

        case 'chart': {
          let data = (section as any).data;
          if ((section as any).data_source && !data) {
            const rows = await this.fetchData((section as any).data_source, (section as any).mcp);
            data = this.transformChartData((section as any).chartType, rows);
          }
          if (!data) {
            ensureSpace(20);
            page.drawText('(图表无数据)', { x: mLeft, y: cursorY, size: 10, font, color: rgb(0.6, 0.6, 0.6) });
            cursorY -= 20;
            break;
          }

          // Render chart to PNG via ECharts SSR → SVG → sharp PNG
          const chartW = Math.min((section as any).width || 480, contentWidth);
          const chartH = (section as any).height || 280;
          try {
            const pngBuffer = await this.chartRenderer.renderToPNG((section as any).chartType, data, {
              title: (section as any).title,
              width: chartW,
              height: chartH,
              colors: (section as any).colors,
            });
            const chartImg = await doc.embedPng(pngBuffer);
            const scale = chartW / chartImg.width;
            const imgH = chartImg.height * scale;
            ensureSpace(imgH + 20);
            cursorY -= 4;
            page.drawImage(chartImg, { x: mLeft, y: cursorY - imgH, width: chartW, height: imgH });
            cursorY -= imgH + 8;
          } catch (chartErr: any) {
            this.logger.error(`Chart PNG embed failed: ${chartErr.message}`);
            ensureSpace(30);
            page.drawText(`[图表渲染失败: ${(section as any).title || (section as any).chartType}]`, { x: mLeft, y: cursorY - 20, size: 10, font, color: rgb(0.6, 0.6, 0.6) });
            cursorY -= 30;
          }
          // Chart caption
          if ((section as any).title) {
            const captionText = (section as any).title;
            const cw = font.widthOfTextAtSize(captionText, 9);
            page.drawText(captionText, { x: mLeft + (contentWidth - cw) / 2, y: cursorY, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
            cursorY -= 16;
          }
          cursorY -= 4;
          break;
        }

        case 'key_values': {
          const items = (section as any).items || [];
          if ((section as any).title) {
            ensureSpace(20);
            cursorY -= 4;
            page.drawText((section as any).title, { x: mLeft, y: cursorY, size: 13, font: boldFont, color: rgb(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b) });
            cursorY -= 20;
          }

          const isGrid = (section as any).layout === 'grid' && items.length > 1;
          const itemH = 16;

          if (isGrid) {
            const halfW = contentWidth / 2;
            for (let i = 0; i < items.length; i += 2) {
              ensureSpace(itemH);
              page.drawText(`${items[i].label}: `, { x: mLeft, y: cursorY, size: 9, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
              const labelW = font.widthOfTextAtSize(`${items[i].label}: `, 9);
              page.drawText(String(items[i].value), { x: mLeft + labelW, y: cursorY, size: 10, font, color: rgb(COLORS.text.r, COLORS.text.g, COLORS.text.b) });

              if (i + 1 < items.length) {
                page.drawText(`${items[i + 1].label}: `, { x: mLeft + halfW, y: cursorY, size: 9, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
                const labelW2 = font.widthOfTextAtSize(`${items[i + 1].label}: `, 9);
                page.drawText(String(items[i + 1].value), { x: mLeft + halfW + labelW2, y: cursorY, size: 10, font, color: rgb(COLORS.text.r, COLORS.text.g, COLORS.text.b) });
              }
              cursorY -= itemH;
            }
          } else {
            for (const item of items) {
              ensureSpace(itemH);
              page.drawText(`${item.label}: `, { x: mLeft, y: cursorY, size: 9, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
              const labelW = font.widthOfTextAtSize(`${item.label}: `, 9);
              page.drawText(String(item.value), { x: mLeft + labelW, y: cursorY, size: 10, font, color: rgb(COLORS.text.r, COLORS.text.g, COLORS.text.b) });
              cursorY -= itemH;
            }
          }
          cursorY -= 8;
          break;
        }

        case 'image': {
          if ((section as any).base64) {
            try {
              const imgBytes = Buffer.from((section as any).base64, 'base64');
              let img: any;
              // Detect PNG vs JPEG
              if (imgBytes[0] === 0x89 && imgBytes[1] === 0x50) {
                img = await doc.embedPng(imgBytes);
              } else {
                img = await doc.embedJpg(imgBytes);
              }
              const imgW = (section as any).width || Math.min(img.width, contentWidth);
              const scale = imgW / img.width;
              const imgH = img.height * scale;
              ensureSpace(imgH + 20);
              cursorY -= imgH;
              page.drawImage(img, { x: mLeft, y: cursorY, width: imgW, height: imgH });
              cursorY -= 4;
              if ((section as any).caption) {
                page.drawText((section as any).caption, { x: mLeft, y: cursorY, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
                cursorY -= 16;
              }
            } catch {
              page.drawText('(图片加载失败)', { x: mLeft, y: cursorY, size: 10, font, color: rgb(0.6, 0.6, 0.6) });
              cursorY -= 16;
            }
          }
          break;
        }

        case 'page_break': {
          addHeaderFooter(page, doc.getPageCount());
          page = doc.addPage([pageW, pageH]);
          cursorY = pageH - mTop;
          break;
        }
      }
    }

    // Add header/footer to last page
    addHeaderFooter(page, doc.getPageCount());

    // Update page count in all footers (replace '?' with actual count)
    const totalPages = doc.getPageCount();
    // Note: page count placeholder '?' in footers is a simplification.
    // For production, consider a two-pass approach.

    // Save
    const pdfBytes = await doc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    const exportDir = this.getPdfDir(userId);
    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const safeName = spec.filename.replace(/[\/\\:*?"<>|]/g, '_');
    const filename = safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`;
    const fullFileId = `${fileId}_${filename}`;
    const filePath = path.join(exportDir, fullFileId);

    fs.writeFileSync(filePath, pdfBuffer);

    // Save doc structure for later editing
    const structPath = filePath + '.json';
    const structure: PdfDocStructure = { spec, generatedAt: new Date().toISOString() };
    fs.writeFileSync(structPath, JSON.stringify(structure, null, 2));

    this.logger.log(`PDF generated: ${filePath} (${pdfBuffer.length} bytes, ${spec.sections.length} sections)`);
    return { filePath, filename, fileId: fullFileId };
  }

  /**
   * Update an existing PDF by modifying its stored structure and re-rendering.
   */
  async updatePdf(userId: string, fileId: string, updates: any[]): Promise<{ success: boolean; updated: number }> {
    const structPath = path.join(this.getPdfDir(userId), fileId + '.json');
    if (!fs.existsSync(structPath)) throw new Error('PDF结构文件不存在，无法编辑');

    const structure: PdfDocStructure = JSON.parse(fs.readFileSync(structPath, 'utf-8'));
    let updateCount = 0;

    for (const update of updates) {
      const idx = update.sectionIndex;
      if (idx != null && idx >= 0 && idx < structure.spec.sections.length) {
        const section = structure.spec.sections[idx] as any;
        if (update.field && update.value !== undefined) {
          section[update.field] = update.value;
          updateCount++;
        }
        if (update.replace) {
          structure.spec.sections[idx] = { ...section, ...update.replace };
          updateCount++;
        }
      }
      if (update.title !== undefined) { structure.spec.title = update.title; updateCount++; }
      if (update.header !== undefined) { structure.spec.header = { ...structure.spec.header, ...update.header }; updateCount++; }
      if (update.footer !== undefined) { structure.spec.footer = { ...structure.spec.footer, ...update.footer }; updateCount++; }
      if (update.addSection) {
        const insertAt = update.insertAt ?? structure.spec.sections.length;
        structure.spec.sections.splice(insertAt, 0, update.addSection);
        updateCount++;
      }
      if (update.removeSection != null) {
        structure.spec.sections.splice(update.removeSection, 1);
        updateCount++;
      }
    }

    const result = await this.generatePdf(userId, structure.spec);
    const oldPath = path.join(this.getPdfDir(userId), fileId);
    if (result.filePath !== oldPath) {
      fs.renameSync(result.filePath, oldPath);
      fs.renameSync(result.filePath + '.json', structPath);
    }

    return { success: true, updated: updateCount };
  }

  listFiles(userId: string): { fileId: string; filename: string; size: number; created: string }[] {
    const dir = this.getPdfDir(userId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.pdf'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        const displayName = f.replace(/^\d+_[a-z0-9]+_/, '');
        return { fileId: f, filename: displayName, size: stat.size, created: stat.birthtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  getFilePath(userId: string, fileId: string): string | null {
    const filePath = path.join(this.getPdfDir(userId), fileId);
    return fs.existsSync(filePath) ? filePath : null;
  }

  /**
   * Get the structure of a PDF file (sections with index, type, and content summary).
   */
  getStructure(userId: string, fileId: string): { filename: string; sections: { index: number; type: string; summary: string }[] } | null {
    const structPath = path.join(this.getPdfDir(userId), fileId + '.json');
    if (!fs.existsSync(structPath)) return null;
    try {
      const structure: PdfDocStructure = JSON.parse(fs.readFileSync(structPath, 'utf-8'));
      const sections = structure.spec.sections.map((s, i) => {
        let summary = '';
        switch (s.type) {
          case 'heading': summary = `level=${(s as any).level || 1} "${(s as any).text?.substring(0, 50) || ''}"`;  break;
          case 'paragraph': summary = `"${((s as any).text || '').substring(0, 60)}"`;  break;
          case 'table': summary = `data_source=${(s as any).data_source ? 'SQL' : 'inline'} cols=${(s as any).columns?.length || 'auto'}`;  break;
          case 'chart': summary = `${(s as any).chartType} "${(s as any).title || ''}"`;  break;
          case 'key_values': summary = `"${(s as any).title || ''}" items=${(s as any).items?.length || 0}`;  break;
          case 'image': summary = (s as any).caption || '(image)';  break;
          case 'page_break': summary = '---';  break;
        }
        return { index: i, type: s.type, summary };
      });
      return { filename: structure.spec.filename, sections };
    } catch {
      return null;
    }
  }

  deleteFile(userId: string, fileId: string): boolean {
    return this.fileCleanup.deleteExportFile(userId, fileId);
  }

  // --- Private helpers ---

  /** Parse hex color string (#RRGGBB or #RGB) to {r, g, b} in 0-1 range */
  private parseColor(hex: string): { r: number; g: number; b: number } {
    if (!hex || !hex.startsWith('#')) return { r: 0.6, g: 0.6, b: 0.6 };
    const h = hex.replace('#', '');
    if (h.length === 3) {
      return { r: parseInt(h[0] + h[0], 16) / 255, g: parseInt(h[1] + h[1], 16) / 255, b: parseInt(h[2] + h[2], 16) / 255 };
    }
    return { r: parseInt(h.substring(0, 2), 16) / 255, g: parseInt(h.substring(2, 4), 16) / 255, b: parseInt(h.substring(4, 6), 16) / 255 };
  }

  private getPdfDir(userId: string): string {
    const dir = path.join(this.workspace.getExportDir(userId), 'pdf');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Wrap text into lines that fit within maxWidth */
  private wrapText(text: string, font: any, fontSize: number, maxWidth: number): string[] {
    if (!text) return [''];
    const lines: string[] = [];
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (!para.trim()) { lines.push(''); continue; }
      let current = '';
      for (const char of para) {
        const testLine = current + char;
        try {
          const w = font.widthOfTextAtSize(testLine, fontSize);
          if (w > maxWidth && current) {
            lines.push(current);
            current = char;
          } else {
            current = testLine;
          }
        } catch {
          // Skip characters that can't be encoded
          continue;
        }
      }
      if (current) lines.push(current);
    }
    return lines.length ? lines : [''];
  }

  /** Truncate text to fit within maxWidth */
  private truncateText(text: string, font: any, fontSize: number, maxWidth: number): string {
    if (!text) return '';
    try {
      const w = font.widthOfTextAtSize(text, fontSize);
      if (w <= maxWidth) return text;
    } catch { return text.substring(0, 20); }

    // Binary search for fitting length
    let lo = 0, hi = text.length;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        const w = font.widthOfTextAtSize(text.substring(0, mid) + '…', fontSize);
        if (w <= maxWidth) lo = mid; else hi = mid;
      } catch { hi = mid; }
    }
    return text.substring(0, lo) + '…';
  }

  private async fetchData(dataSource: string, mcpName?: string): Promise<any[]> {
    if (!mcpName) return [];
    try {
      const result = await this.executeMcpQuery(mcpName, dataSource);
      return result?.rows || result?.data?.rows || [];
    } catch (err: any) {
      this.logger.error(`PDF data fetch failed: ${err.message}`);
      return [];
    }
  }

  private async executeMcpQuery(mcpName: string, sql: string): Promise<any> {
    const mcp = (this.mcpRegistry as any).get(mcpName);
    if (!mcp || !mcp.handlerCode) throw new Error(`MCP "${mcpName}" 不存在或无 handler`);
    const authSystem = mcp.authSystem || mcp.system || mcp.name;
    const creds = this.credentialService.resolveCredentials('', authSystem, mcp.authScope);
    if (!creds) throw new Error(`MCP "${mcpName}" 凭证缺失`);

    let code = mcp.handlerCode.replace(/import\s+.*?from\s+.*?;?\n?/g, '').replace(/export\s+/g, '').replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
    const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
    const result = await fn(require, { params: { sql }, credentials: creds, tool: 'execute_query', toolName: 'execute_query' });
    this.logger.debug(`executeMcpQuery "${mcpName}": keys=${result ? Object.keys(result).join(',') : 'null'}, rows=${result?.rows?.length ?? 'N/A'}`);
    return result;
  }

  private transformChartData(chartType: string, rows: any[]): any {
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]);

    if (chartType === 'pie') {
      const nameKey = keys.find(k => /name|label|category|type|类型|名称/i.test(k)) || keys[0];
      const valueKey = keys.find(k => /value|count|total|sum|数量|金额/i.test(k)) || keys[1] || keys[0];
      return rows.map(r => ({ name: String(r[nameKey]), value: Number(r[valueKey]) || 0 }));
    }

    const categoryKey = keys.find(k => /date|month|year|period|name|category|时间|日期|月份/i.test(k)) || keys[0];
    const valueKeys = keys.filter(k => k !== categoryKey);
    return {
      xAxis: rows.map(r => String(r[categoryKey])),
      series: valueKeys.map(k => ({ name: k, data: rows.map(r => Number(r[k]) || 0) })),
    };
  }
}
