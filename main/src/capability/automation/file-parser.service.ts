import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../../workspace/workspace.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { OcrService } from '../../data/media/ocr.service';

export interface ParsedFile {
  fileType: string;
  fileName: string;
  summary: string;
  rawText: string;
  fields: Record<string, any>;
  tables?: { headers: string[]; rows: any[][] }[];
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);

@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly modelRouter: ModelRouterService,
    @Optional() private readonly ocrService?: OcrService,
  ) {}

  /**
   * Get or create workspace directory for a user session (uploads subfolder)
   * Structure: workspace/{userId}/uploads/
   */
  getUserDir(userId?: string): string {
    return this.workspace.getUploadDir(userId || '_anonymous');
  }

  /**
   * Save an uploaded file to user's workspace and return its path
   */
  saveFile(buffer: Buffer, originalName: string, userId?: string): string {
    const userDir = this.getUserDir(userId);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = path.extname(originalName);
    const safeOriginal = originalName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_');
    const fileName = `${id}_${safeOriginal}`;
    const filePath = path.join(userDir, fileName);
    fs.writeFileSync(filePath, buffer);
    this.logger.log(`File saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  }

  /**
   * Parse a file by absolute path
   */
  async parseFilePath(filePath: string): Promise<ParsedFile> {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    if (IMAGE_EXTENSIONS.has(ext)) return this.parseImage(filePath, fileName);
    switch (ext) {
      case '.pdf': return this.parsePdf(filePath, fileName);
      case '.xlsx': case '.xls': return this.parseExcel(filePath, fileName);
      case '.csv': return this.parseCsv(filePath, fileName);
      case '.docx': case '.doc': return this.parseDocx(filePath, fileName);
      case '.pptx': case '.ppt': return this.parsePptx(filePath, fileName);
      default: return this.parseText(filePath, fileName);
    }
  }

  /**
   * Parse a file by ID (legacy, searches workspace)
   */
  async parseFile(fileId: string, hint?: string): Promise<ParsedFile> {
    // Try as absolute path first
    if (fs.existsSync(fileId)) return this.parseFilePath(fileId);
    // Search in workspace
    const found = this.findFile(this.workspace.getRoot(), fileId);
    if (found) return this.parseFilePath(found);
    throw new Error(`File not found: ${fileId}`);
  }

  private findFile(dir: string, name: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && (e.name === name || full === name)) return full;
      if (e.isDirectory()) {
        const found = this.findFile(full, name);
        if (found) return found;
      }
    }
    return null;
  }

  private async parsePdf(filePath: string, fileName: string): Promise<ParsedFile> {
    // Try enhanced OCR extraction first (Mistral OCR / opendataloader)
    if (this.ocrService) {
      try {
        const result = await this.ocrService.extract(filePath);
        if (result.fullText.trim()) {
          const fields = this.extractKeyValuePairs(result.fullText);
          return {
            fileType: 'pdf', fileName,
            summary: `PDF文档，${result.pageCount}页 (${result.parser}引擎)`,
            rawText: result.fullText, fields,
          };
        }
      } catch (err: any) {
        this.logger.warn(`OCR extraction failed for ${fileName}, falling back to pdfjs: ${err.message}`);
      }
    }

    // Fallback: pdfjs-dist with DOM polyfills, then pdf-parse
    try {
      // 防御扩展包污染：清除同进程其他 pdfjs 版本滞留的 fake-worker 全局
      delete (globalThis as any).pdfjsWorker;

      const g = globalThis as any;
      if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix { constructor() { return new Proxy(this, { get: () => 0 }); } };
      if (!g.ImageData) g.ImageData = class ImageData { constructor(public width = 0, public height = 0) {} };
      if (!g.Path2D) g.Path2D = class Path2D {};

      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const data = new Uint8Array(fs.readFileSync(filePath));
      const pdf = await pdfjs.getDocument({ data }).promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map((item: any) => item.str).join(' ') + '\n';
      }
      const fields = this.extractKeyValuePairs(fullText);
      return { fileType: 'pdf', fileName, summary: `PDF文档，${pdf.numPages}页`, rawText: fullText, fields };
    } catch {
      // pdf-parse v2 API：PDFParse 类 + getText()
      const { PDFParse } = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        const fields = this.extractKeyValuePairs(result.text);
        return { fileType: 'pdf', fileName, summary: `PDF文档，${result.total || 1}页`, rawText: result.text, fields };
      } finally {
        await parser.destroy().catch(() => {});
      }
    } finally {
      delete (globalThis as any).pdfjsWorker;
    }
  }

  private async parseExcel(filePath: string, fileName: string): Promise<ParsedFile> {
    const xlsxModule = await import('xlsx');
    const XLSX = (xlsxModule as any).default || xlsxModule;
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: true });
    const tables: { headers: string[]; rows: any[][] }[] = [];
    let summary = '';
    let markdownText = '';

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet['!ref']) continue;

      // Handle merged cells: fill merged values into all covered cells
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

      // Smart header detection: skip empty/whitespace-only rows
      let headerIdx = 0;
      for (let i = 0; i < Math.min(jsonData.length, 5); i++) {
        const row = jsonData[i];
        const nonEmpty = row.filter((c: any) => c !== '' && c != null).length;
        if (nonEmpty >= 2) { headerIdx = i; break; }
      }

      const headers = jsonData[headerIdx].map((c: any) => String(c ?? '').trim());
      const rows = jsonData.slice(headerIdx + 1).filter((r: any[]) =>
        r.some((c: any) => c !== '' && c != null),
      );
      tables.push({ headers, rows });
      summary += `Sheet "${sheetName}": ${rows.length}行 × ${headers.length}列\n`;

      // Generate markdown table (LLM-friendly)
      markdownText += `## ${sheetName}\n\n`;
      markdownText += '| ' + headers.join(' | ') + ' |\n';
      markdownText += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
      const maxRows = Math.min(rows.length, 100); // Limit to prevent token overflow
      for (let i = 0; i < maxRows; i++) {
        const cells = headers.map((_, ci) => String(rows[i][ci] ?? '').replace(/\|/g, '\\|'));
        markdownText += '| ' + cells.join(' | ') + ' |\n';
      }
      if (rows.length > maxRows) {
        markdownText += `\n... (共 ${rows.length} 行，已展示前 ${maxRows} 行)\n`;
      }
      markdownText += '\n';
    }

    return { fileType: 'xlsx', fileName, summary: summary.trim(), rawText: markdownText.trim(), fields: {}, tables };
  }

  private async parseCsv(filePath: string, fileName: string): Promise<ParsedFile> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));

    return { fileType: 'csv', fileName, summary: `CSV文件，${rows.length}行 × ${headers.length}列`, rawText: content, fields: {}, tables: [{ headers, rows }] };
  }

  private parseText(filePath: string, fileName: string): ParsedFile {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { fileType: 'text', fileName, summary: `文本文件，${content.length}字符`, rawText: content, fields: this.extractKeyValuePairs(content) };
  }

  /** Word：.docx 走 OOXML(zip+xml)；旧版 .doc 二进制无法纯 JS 解析，给出明确提示。 */
  private async parseDocx(filePath: string, fileName: string): Promise<ParsedFile> {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const docFile = zip.file('word/document.xml');
      if (!docFile) throw new Error('缺少 word/document.xml（非标准 .docx）');
      const xml = await docFile.async('string');
      const text = this.extractOoxmlText(xml, 'w');
      return { fileType: 'docx', fileName, summary: `Word 文档，${text.length}字符`, rawText: text, fields: this.extractKeyValuePairs(text) };
    } catch (e: any) {
      this.logger.warn(`parseDocx failed for ${fileName}: ${e.message}`);
      const hint = /zip|end of central|document\.xml/i.test(e.message)
        ? '可能是旧版 .doc 二进制格式，请在 Word 里「另存为 .docx」后重试'
        : e.message;
      const msg = `无法解析「${fileName}」：${hint}`;
      return { fileType: 'docx', fileName, summary: msg, rawText: msg, fields: {} };
    }
  }

  /** PowerPoint：.pptx 走 OOXML，按幻灯片顺序抽 a:t 文本；旧版 .ppt 二进制给出明确提示。 */
  private async parsePptx(filePath: string, fileName: string): Promise<ParsedFile> {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const slideNames = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => (parseInt(a.match(/(\d+)/)![1], 10) - parseInt(b.match(/(\d+)/)![1], 10)));
      if (!slideNames.length) throw new Error('未找到幻灯片（非标准 .pptx）');
      const parts: string[] = [];
      for (let i = 0; i < slideNames.length; i++) {
        const xml = await zip.file(slideNames[i])!.async('string');
        const t = this.extractOoxmlText(xml, 'a');
        if (t.trim()) parts.push(`【第${i + 1}页】\n${t}`);
      }
      const text = parts.join('\n\n');
      return { fileType: 'pptx', fileName, summary: `PPT 演示文稿，${slideNames.length} 页，${text.length}字符`, rawText: text, fields: {} };
    } catch (e: any) {
      this.logger.warn(`parsePptx failed for ${fileName}: ${e.message}`);
      const hint = /zip|end of central|幻灯片/i.test(e.message)
        ? '可能是旧版 .ppt 二进制格式，请在 PowerPoint 里「另存为 .pptx」后重试'
        : e.message;
      const msg = `无法解析「${fileName}」：${hint}`;
      return { fileType: 'pptx', fileName, summary: msg, rawText: msg, fields: {} };
    }
  }

  /** 从 OOXML 抽取可读文本：ns='w'(docx) / 'a'(pptx)。按 <ns:t> 收正文，</ns:p> 换行，<ns:br/> 换行，<w:tab/> 制表。 */
  private extractOoxmlText(xml: string, ns: string): string {
    // 注意：<ns:t> 必须紧跟 '>' 或空白，避免误匹配 <w:tbl>/<w:tc>/<a:tbl> 等表格标签
    const re = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|</${ns}:p>|<${ns}:br\\s*/>|<w:tab\\s*/>`, 'g');
    let m: RegExpExecArray | null;
    let out = '';
    while ((m = re.exec(xml)) !== null) {
      if (m[1] !== undefined) out += this.decodeXmlEntities(m[1]);
      else if (m[0].indexOf(':tab') >= 0) out += '\t';
      else out += '\n'; // </ns:p> 或 <ns:br/>
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private decodeXmlEntities(s: string): string {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&');
  }

  private async parseImage(filePath: string, fileName: string): Promise<ParsedFile> {
    const stat = fs.statSync(filePath);
    const ext = path.extname(fileName).replace('.', '').toUpperCase();
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

    // Engine 1: LLM Vision
    try {
      const text = await this.ocrWithVision(filePath);
      if (text) {
        return {
          fileType: 'image', fileName,
          summary: `图片 (${ext}, ${sizeMB}MB)，通过 AI 视觉识别提取文字`,
          rawText: text, fields: this.extractKeyValuePairs(text),
        };
      }
    } catch (err: any) {
      this.logger.warn(`Vision OCR failed for ${fileName}: ${err.message}`);
    }

    // Engine 2: Tesseract fallback
    try {
      const text = await this.ocrWithTesseract(filePath);
      if (text) {
        return {
          fileType: 'image', fileName,
          summary: `图片 (${ext}, ${sizeMB}MB)，通过 Tesseract OCR 提取文字`,
          rawText: text, fields: this.extractKeyValuePairs(text),
        };
      }
    } catch (err: any) {
      this.logger.warn(`Tesseract OCR failed for ${fileName}: ${err.message}`);
    }

    // Fallback: metadata only
    return {
      fileType: 'image', fileName,
      summary: `图片 (${ext}, ${sizeMB}MB)，OCR 不可用`,
      rawText: `[图片文件: ${fileName}, 格式: ${ext}, 大小: ${sizeMB}MB]`,
      fields: {},
    };
  }

  private async ocrWithVision(filePath: string): Promise<string | null> {
    const base64 = fs.readFileSync(filePath).toString('base64');
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff' }[ext] || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Use model router to call a vision-capable model
    const model = this.modelRouter.resolveModelForLevel('coding');
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);
    if (!apiKey) return null;

    const body: any = {
      model: model.id,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: '请提取图片中的所有文字内容。如果有表格，用 markdown 表格格式输出。只输出提取的内容，不要加额外说明。' },
        ],
      }],
      max_tokens: 4096,
    };

    const cfg = this.modelRouter.getConfig();
    const endpoint = model.provider === 'ollama'
      ? `${cfg.localEndpoint}/v1/chat/completions`
      : model.provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : `https://api.${model.provider}.com/v1/chat/completions`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Vision API ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  }

  private async ocrWithTesseract(filePath: string): Promise<string | null> {
    try {
      const tesseract = await import('node-tesseract-ocr');
      const text = await tesseract.recognize(filePath, { lang: 'chi_sim+eng', oem: 1, psm: 3 });
      return text?.trim() || null;
    } catch {
      // Tesseract not installed — silent skip
      return null;
    }
  }

  private extractKeyValuePairs(text: string): Record<string, any> {
    const fields: Record<string, any> = {};
    const patterns = [
      /([A-Za-z\u4e00-\u9fa5][\w\s\u4e00-\u9fa5]*?)\s{2,}([\w\d][\w\d\s.,/$\-()]+)/g,
      /([A-Za-z\u4e00-\u9fa5][\w\s\u4e00-\u9fa5]*?)[:：]\s*([\w\d][\w\d\s.,/$\-()]+)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key.length > 1 && key.length < 40 && value.length > 0 && value.length < 200) {
          fields[key] = value;
        }
      }
    }
    return fields;
  }
}
