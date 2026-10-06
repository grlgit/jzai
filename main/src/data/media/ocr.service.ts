import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WorkspaceService } from '../../workspace/workspace.service';
import { DbService } from '../../db/db.service';
import { SpacesService, ENTERPRISE_SPACE_SLUG } from '../../knowledge/spaces.service';
import { ProcessorService } from '../../knowledge/processor/processor.service';

/**
 * OCR extraction result: per-page markdown content
 */
export interface OcrPage {
  page: number;
  content: string;
}

export interface OcrResult {
  pages: OcrPage[];
  fullText: string;
  pageCount: number;
  parser: string;
  images?: string[];
}

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MAX_RETRIES = 3;
const RETRY_BACKOFF = [2000, 5000, 10000];

const PDF_EXTENSIONS = new Set(['.pdf']);
const OFFICE_EXTENSIONS = new Set(['.docx', '.doc', '.pptx', '.ppt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private mistralApiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly workspace: WorkspaceService,
    private readonly db: DbService,
    private readonly spaces: SpacesService,
    private readonly processor: ProcessorService,
  ) {
    this.mistralApiKey = this.config.get('MISTRAL_API_KEY', '');
  }

  /**
   * Check if Mistral OCR is available
   */
  isMistralAvailable(): boolean {
    return !!this.mistralApiKey;
  }

  /**
   * Extract text from a file using the best available OCR engine.
   *
   * Priority:
   * 1. Mistral OCR (best for PDFs with tables/complex layout) — if API key configured
   * 2. llm_wiki opendataloader proxy (structured PDF extraction) — if llm_wiki running
   * 3. Fallback to basic pdfjs extraction
   */
  async extract(filePath: string): Promise<OcrResult> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();

    if (PDF_EXTENSIONS.has(ext)) {
      return this.extractPdf(filePath);
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      return this.extractOffice(filePath);
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return this.extractImage(filePath);
    }
    if (SPREADSHEET_EXTENSIONS.has(ext)) {
      return this.extractSpreadsheet(filePath);
    }

    throw new Error(`Unsupported file type for OCR: ${ext}`);
  }

  // ── PDF extraction ────────────────────────────────────────────────────

  private lastError: string | null = null;

  private async extractPdf(filePath: string): Promise<OcrResult> {
    // Strategy 1: Mistral OCR (best quality for complex layouts)
    if (this.mistralApiKey) {
      try {
        return await this.extractWithMistral(filePath);
      } catch (err: any) {
        this.lastError = `mistral: ${err.message}`;
        this.logger.warn(`Mistral OCR failed, trying fallback: ${err.message}`);
      }
    }

    // Strategy 2: Proxy to llm_wiki opendataloader
    try {
      return await this.extractViaLlmWiki(filePath);
    } catch (err: any) {
      this.lastError = `llm_wiki: ${err.message}`;
      this.logger.warn(`llm_wiki extraction failed, trying pdfjs: ${err.message}`);
    }

    // Strategy 3: Basic pdfjs extraction
    try {
      return await this.extractWithPdfjs(filePath);
    } catch (err: any) {
      this.lastError = `pdfjs: ${err.message}`;
      this.logger.warn(`pdfjs extraction also failed: ${err.message}`);
    }

    throw new Error(`PDF提取失败：所有引擎均不可用（最后错误: ${this.lastError ?? '无'}）。请联系管理员检查 Mistral 配置、知库服务与 pdfjs/pdf-parse 依赖。`);
  }

  // ── Mistral OCR (ported from llm_wiki) ────────────────────────────────

  private async extractWithMistral(filePath: string): Promise<OcrResult> {
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeType = ext === 'pdf' ? 'application/pdf'
      : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const ocrResult = await this.callMistralOcr(dataUrl, 'document_url');
    const pages: OcrPage[] = (ocrResult.pages || []).map((p: any) => ({
      page: (p.index ?? 0) + 1,
      content: p.markdown || '',
    }));

    const fullText = pages.map(p => p.content).join('\n\n---\n\n');

    // Extract and save images if present
    const savedImages: string[] = [];
    const assetsDir = path.join(path.dirname(filePath), 'ocr_assets');
    for (const page of ocrResult.pages || []) {
      for (const img of page.images || []) {
        if (!img.id || !img.image_base64) continue;
        try {
          let b64 = img.image_base64;
          if (b64.startsWith('data:')) b64 = b64.split(',')[1];
          if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
          const imgPath = path.join(assetsDir, `${img.id}.jpg`);
          fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
          savedImages.push(imgPath);
        } catch {
          // skip image save errors
        }
      }
    }

    return {
      pages,
      fullText,
      pageCount: pages.length,
      parser: 'mistral-ocr',
      images: savedImages.length ? savedImages : undefined,
    };
  }

  /**
   * Call Mistral OCR API with retry logic (ported from llm_wiki)
   */
  private async callMistralOcr(url: string, urlType: string = 'document_url'): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(MISTRAL_OCR_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.mistralApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mistral-ocr-latest',
            document: {
              type: urlType,
              [urlType]: url,
            },
            include_image_base64: true,
            table_format: 'markdown',
          }),
          signal: AbortSignal.timeout(300000),
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Mistral OCR API ${resp.status}: ${text.substring(0, 200)}`);
        }

        return await resp.json();
      } catch (err: any) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          const wait = RETRY_BACKOFF[attempt];
          this.logger.warn(`Mistral OCR attempt ${attempt + 1} failed: ${err.message}, retrying in ${wait}ms`);
          await new Promise(resolve => setTimeout(resolve, wait));
        }
      }
    }

    throw lastError || new Error('Mistral OCR failed after retries');
  }

  // ── 知识库文档处理管线（原 llm_wiki opendataloader 代理，kbs 并入后内部直连）──

  private async extractViaLlmWiki(filePath: string): Promise<OcrResult> {
    const fileName = path.basename(filePath);
    const space = await this.spaces.resolve(ENTERPRISE_SPACE_SLUG);
    if (!space) throw new Error('企业空间未初始化');

    // 复制到企业空间 _ocr_tmp/ 并建档
    const relative = `_ocr_tmp/${Date.now()}_${fileName}`;
    const dest = path.join(this.spaces.rootFor(space.slug), relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);

    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
    const docId = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_kb_documents (id, filename, title, path, relative_path, source_kind, ' +
        "file_type, file_size, status, space_id) " +
        "VALUES ($1, $2, $3, '/_ocr_tmp/', $4, 'source', $5, $6, 'pending', $7)",
      [docId, fileName, fileName, relative, ext || 'bin', fs.statSync(dest).size, space.id],
    );

    try {
      // 同步走文档处理管线
      await this.processor.processNow(docId);

      const { rows } = await this.db.query(
        'SELECT status, content, page_count, parser, error_message FROM jz_kb_documents WHERE id = $1',
        [docId],
      );
      const doc = rows[0];
      if (!doc || doc.status === 'failed') {
        throw new Error(`文档处理失败: ${doc?.error_message || 'unknown error'}`);
      }

      const { rows: pageRows } = await this.db.query(
        'SELECT page, content FROM jz_kb_document_pages WHERE document_id = $1 ORDER BY page',
        [docId],
      );
      const pages: OcrPage[] = pageRows.map((p: any) => ({ page: p.page || 1, content: p.content || '' }));
      const fullText = pages.length > 0
        ? pages.map(p => p.content).join('\n\n---\n\n')
        : doc.content || '';

      return {
        pages: pages.length > 0 ? pages : [{ page: 1, content: fullText }],
        fullText,
        pageCount: doc.page_count || pages.length || 1,
        parser: doc.parser || 'processor',
      };
    } finally {
      // Cleanup: 删除临时文档与文件
      await this.db.query('DELETE FROM jz_kb_documents WHERE id = $1', [docId]).catch(() => {});
      fs.unlinkSync(dest);
    }
  }

  // ── pdfjs / pdf-parse fallback ──────────────────────────────────────

  private async extractWithPdfjs(filePath: string): Promise<OcrResult> {
    // Strategy A: pdfjs-dist with DOM polyfills
    try {
      // 防御扩展包/第三方库污染：pdfjs 的 fake-worker 会读写 globalThis.pdfjsWorker，
      // 同进程内其他版本（如 dimension-tuner 内嵌的 pdfjs-dist@4.x）会留下不兼容的
      // WorkerMessageHandler，导致 "API version X does not match Worker version Y"。
      delete (globalThis as any).pdfjsWorker;

      // Polyfill minimal DOM APIs required by pdfjs-dist in Node.js
      const g = globalThis as any;
      if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix { constructor() { return new Proxy(this, { get: () => 0 }); } };
      if (!g.ImageData) g.ImageData = class ImageData { constructor(public width = 0, public height = 0) {} };
      if (!g.Path2D) g.Path2D = class Path2D {};

      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const data = new Uint8Array(fs.readFileSync(filePath));
      const pdf = await pdfjs.getDocument({ data }).promise;

      const pages: OcrPage[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => item.str).join(' ');
        pages.push({ page: i, content: pageText });
      }

      return { pages, fullText: pages.map(p => p.content).join('\n'), pageCount: pdf.numPages, parser: 'pdfjs' };
    } catch (err: any) {
      this.logger.warn(`pdfjs-dist failed: ${err.message}, trying pdf-parse...`);
    } finally {
      // 不让自己加载的 worker 滞留全局，反向污染同进程其他 pdfjs 使用方
      delete (globalThis as any).pdfjsWorker;
    }

    // Strategy B: pdf-parse as final fallback
    const { PDFParse } = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pages: OcrPage[] = (result.pages ?? [])
        .filter((p: any) => p.text?.trim())
        .map((p: any) => ({ page: p.num, content: p.text.trim() }));
      return {
        pages: pages.length > 0 ? pages : [{ page: 1, content: result.text }],
        fullText: result.text,
        pageCount: result.total || pages.length,
        parser: 'pdf-parse',
      };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  // ── Office file extraction ────────────────────────────────────────────

  private async extractOffice(filePath: string): Promise<OcrResult> {
    // Strategy 1: Mistral OCR via PDF conversion
    if (this.mistralApiKey) {
      try {
        const pdfPath = await this.convertOfficeToPdf(filePath);
        if (pdfPath) {
          const result = await this.extractWithMistral(pdfPath);
          // Cleanup temp PDF
          try { fs.unlinkSync(pdfPath); } catch {}
          return result;
        }
      } catch (err: any) {
        this.logger.warn(`Office→Mistral failed: ${err.message}`);
      }
    }

    // Strategy 2: Proxy to llm_wiki
    try {
      return await this.extractViaLlmWiki(filePath);
    } catch (err: any) {
      this.logger.warn(`llm_wiki Office extraction failed: ${err.message}`);
    }

    throw new Error('No available engine for Office file extraction. Install LibreOffice or configure Mistral API key.');
  }

  /**
   * Convert Office file to PDF using LibreOffice (if installed)
   */
  private async convertOfficeToPdf(filePath: string): Promise<string | null> {
    const { execSync } = await import('child_process');
    const tmpDir = path.join(path.dirname(filePath), '.ocr_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    try {
      execSync(
        `libreoffice --headless --norestore --convert-to pdf --outdir "${tmpDir}" "${filePath}"`,
        { timeout: 120000, stdio: 'pipe' },
      );
      const baseName = path.basename(filePath, path.extname(filePath));
      const pdfPath = path.join(tmpDir, `${baseName}.pdf`);
      if (fs.existsSync(pdfPath)) return pdfPath;
      return null;
    } catch (err: any) {
      this.logger.warn(`LibreOffice conversion failed: ${err.message}`);
      return null;
    }
  }

  // ── Image OCR ─────────────────────────────────────────────────────────

  private async extractImage(filePath: string): Promise<OcrResult> {
    if (this.mistralApiKey) {
      try {
        return await this.extractWithMistral(filePath);
      } catch (err: any) {
        this.logger.warn(`Mistral image OCR failed: ${err.message}`);
      }
    }

    // Return as-is with metadata (image OCR handled by FileParserService's Vision API)
    const ext = path.extname(filePath).replace('.', '').toUpperCase();
    const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
    return {
      pages: [{ page: 1, content: `[Image: ${path.basename(filePath)}, ${ext}, ${sizeMB}MB]` }],
      fullText: `[Image: ${path.basename(filePath)}, ${ext}, ${sizeMB}MB]`,
      pageCount: 1,
      parser: 'native',
    };
  }

  // ── Spreadsheet extraction ────────────────────────────────────────────

  private async extractSpreadsheet(filePath: string): Promise<OcrResult> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        pages: [{ page: 1, content }],
        fullText: content,
        pageCount: 1,
        parser: 'csv',
      };
    }

    // xlsx/xls via xlsx library
    const XLSX = await import('xlsx');
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: true });
    const pages: OcrPage[] = [];
    let fullText = '';

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const sheetName = workbook.SheetNames[i];
      const sheet = workbook.Sheets[sheetName];
      if (!sheet['!ref']) continue;

      // Handle merged cells
      const merges = sheet['!merges'] || [];
      for (const merge of merges) {
        const origin = sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
        if (!origin) continue;
        for (let r = merge.s.r; r <= merge.e.r; r++) {
          for (let c = merge.s.c; c <= merge.e.c; c++) {
            if (r === merge.s.r && c === merge.s.c) continue;
            const addr = XLSX.utils.encode_cell({ r, c });
            if (!sheet[addr]) sheet[addr] = { ...origin };
          }
        }
      }

      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as any[][];
      if (jsonData.length === 0) continue;

      // Smart header detection
      let headerIdx = 0;
      for (let j = 0; j < Math.min(jsonData.length, 5); j++) {
        const row = jsonData[j];
        const nonEmpty = row.filter((c: any) => c !== '' && c != null).length;
        if (nonEmpty >= 2) { headerIdx = j; break; }
      }

      const headers = jsonData[headerIdx].map((c: any) => String(c ?? '').trim());
      const rows = jsonData.slice(headerIdx + 1).filter((r: any[]) => r.some((c: any) => c !== '' && c != null));

      let md = `## ${sheetName}\n\n`;
      md += '| ' + headers.join(' | ') + ' |\n';
      md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
      const maxRows = Math.min(rows.length, 100);
      for (let j = 0; j < maxRows; j++) {
        const cells = headers.map((_, ci) => String(rows[j][ci] ?? '').replace(/\|/g, '\\|'));
        md += '| ' + cells.join(' | ') + ' |\n';
      }
      if (rows.length > maxRows) {
        md += `\n*(...共 ${rows.length} 行，已展示前 ${maxRows} 行)*\n`;
      }

      pages.push({ page: i + 1, content: md });
      fullText += md + '\n\n';
    }

    return {
      pages,
      fullText: fullText.trim(),
      pageCount: pages.length,
      parser: 'xlsx',
    };
  }
}
