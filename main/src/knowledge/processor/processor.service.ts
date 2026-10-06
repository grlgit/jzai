/**
 * 文档提取管线（移植自 kbs/src/processor/index.ts，NestJS 化）：
 * 串行队列避免并发解析打满 CPU；文件路径按空间根解析。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../../db/db.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { ChunkRepository } from '../shared/repository';
import { chunkPages, chunkText } from '../shared/chunker';
import { loadKnowledgeConfig, KnowledgeConfig } from '../knowledge.config';
import { extractPdfPages, PageContents } from './pdf';
import { processOfficeDocument, UnsupportedOfficeFormatError } from './office';
import { extractSpreadsheet } from './spreadsheet';
import { extractHtmlContent } from './html';
import { extractPdfViaMistral } from './mistral';
import { ocrImage, ocrPdfPages, isScannedPdf, terminateOcrWorker } from './ocr';

const PDF_TYPES = new Set(['pdf']);
const SPREADSHEET_TYPES = new Set(['xlsx', 'xls']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const OFFICE_TYPES = new Set(['pptx', 'ppt', 'docx', 'doc']);

@Injectable()
export class ProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessorService.name);
  private config: KnowledgeConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
  ) {}

  onModuleInit() {
    this.config = loadKnowledgeConfig(this.workspace.getKnowledgeBaseDir());
  }

  async onModuleDestroy() {
    await terminateOcrWorker();
  }

  /** 后台排队处理（fire-and-forget） */
  enqueue(docId: string): void {
    this.queue = this.queue
      .then(() => this.processDocument(docId))
      .catch((err) => this.logger.error(`处理队列异常: ${err?.message || err}`));
  }

  /** 同步处理（等待完成，供 OCR 服务等内部调用） */
  processNow(docId: string): Promise<void> {
    const task = this.queue.then(() => this.processDocument(docId));
    this.queue = task.catch((err) => this.logger.error(`处理队列异常: ${err?.message || err}`));
    return task;
  }

  private async storePageContents(docId: string, pageContents: PageContents, parser: string): Promise<void> {
    const chunkRepo = new ChunkRepository(this.db);
    await chunkRepo.storePages(docId, pageContents);
    const fullContent = pageContents.map(([, md]) => md).join('\n\n---\n\n');
    await chunkRepo.storeChunks(docId, chunkPages(pageContents));
    await this.db.query(
      "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = $3, " +
        'parser = $4, updated_at = NOW() WHERE id = $1',
      [docId, fullContent, pageContents.length, parser],
    );
  }

  async processDocument(docId: string): Promise<void> {
    const { rows } = await this.db.query(
      'SELECT d.id, d.filename, d.file_type, d.relative_path, d.status, s.slug AS space_slug ' +
        'FROM jz_kb_documents d JOIN jz_kb_spaces s ON s.id = d.space_id WHERE d.id = $1',
      [docId],
    );
    const doc = rows[0];
    if (!doc) return;
    if (!['pending', 'processing'].includes(doc.status)) return;

    const fileType: string = doc.file_type || '';
    const spaceRoot = path.join(this.config.workspacePath, 'spaces', doc.space_slug);
    const filePath = path.join(spaceRoot, doc.relative_path);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await this.db.query(
        "UPDATE jz_kb_documents SET status = 'failed', error_message = 'File not found', updated_at = NOW() WHERE id = $1",
        [docId],
      );
      return;
    }

    await this.db.query("UPDATE jz_kb_documents SET status = 'processing', updated_at = NOW() WHERE id = $1", [docId]);

    try {
      if (PDF_TYPES.has(fileType)) {
        if (this.config.pdfBackend === 'mistral' && this.config.mistralApiKey) {
          const pages = await extractPdfViaMistral(filePath, this.config.mistralApiKey);
          await this.storePageContents(docId, pages, 'mistral');
        } else {
          let pages = await extractPdfPages(filePath);
          if (isScannedPdf(pages)) {
            pages = await ocrPdfPages(filePath);
            await this.storePageContents(docId, pages, 'tesseract');
          } else {
            await this.storePageContents(docId, pages, 'pdfjs');
          }
        }
      } else if (OFFICE_TYPES.has(fileType)) {
        const { pages, parser } = await processOfficeDocument(fileType, filePath);
        await this.storePageContents(docId, pages, parser);
      } else if (SPREADSHEET_TYPES.has(fileType)) {
        const sheets = extractSpreadsheet(filePath);
        const chunkRepo = new ChunkRepository(this.db);
        const pageContents: PageContents = sheets.map((s) => [s.page, s.content]);
        const elements = new Map(sheets.map((s) => [s.page, JSON.stringify({ sheet_name: s.sheetName })]));
        await chunkRepo.storePages(docId, pageContents, elements);
        const fullContent = sheets.map((s) => `## ${s.sheetName}\n\n${s.content}`).join('\n\n');
        await chunkRepo.storeChunks(docId, chunkPages(pageContents));
        await this.db.query(
          "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = $3, " +
            "parser = 'xlsx', updated_at = NOW() WHERE id = $1",
          [docId, fullContent, sheets.length],
        );
      } else if (IMAGE_TYPES.has(fileType)) {
        let ocrText = '';
        try {
          ocrText = await ocrImage(filePath);
        } catch (err: any) {
          this.logger.warn(`图片 OCR 失败 ${doc.filename}: ${err.message}`);
        }
        if (ocrText) {
          const chunkRepo = new ChunkRepository(this.db);
          await chunkRepo.storeChunks(docId, chunkText(ocrText));
          await this.db.query(
            "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = 1, " +
              "parser = 'tesseract', updated_at = NOW() WHERE id = $1",
            [docId, ocrText],
          );
        } else {
          await this.db.query(
            "UPDATE jz_kb_documents SET status = 'ready', page_count = 1, parser = 'native', updated_at = NOW() WHERE id = $1",
            [docId],
          );
        }
      } else if (fileType === 'html' || fileType === 'htm') {
        const rawHtml = fs.readFileSync(filePath, 'utf-8');
        let content: string;
        try {
          content = extractHtmlContent(rawHtml);
        } catch {
          content = rawHtml;
        }
        const chunkRepo = new ChunkRepository(this.db);
        await chunkRepo.storeChunks(docId, chunkText(content));
        await this.db.query(
          "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = 1, " +
            "parser = 'webmd', updated_at = NOW() WHERE id = $1",
          [docId, content],
        );
      } else {
        await this.db.query("UPDATE jz_kb_documents SET status = 'ready', updated_at = NOW() WHERE id = $1", [docId]);
      }
    } catch (err: any) {
      const msg = err instanceof UnsupportedOfficeFormatError
        ? err.message
        : String(err?.message || err).slice(0, 500);
      await this.db.query(
        "UPDATE jz_kb_documents SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
        [docId, msg],
      );
      this.logger.error(`文档处理失败 ${doc.filename}: ${msg}`);
    }
  }
}
