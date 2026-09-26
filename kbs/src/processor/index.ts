/**
 * 文档提取管线编排 — 对译 domain/pg_local_processor.py::process_document。
 * 串行队列避免并发解析打满 CPU（P5 可按需改 worker_threads）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../shared/db';
import { ChunkRepository } from '../shared/chunk-repository';
import { chunkPages, chunkText } from '../shared/chunker';
import { extractPdfPages, PageContents } from './pdf';
import { processOfficeDocument, UnsupportedOfficeFormatError } from './office';
import { extractSpreadsheet } from './spreadsheet';
import { extractHtmlContent } from './html';
import { extractPdfViaMistral } from './mistral';
import { ocrImage, ocrPdfPages, isScannedPdf } from './ocr';

const PDF_TYPES = new Set(['pdf']);
const SPREADSHEET_TYPES = new Set(['xlsx', 'xls']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const OFFICE_TYPES = new Set(['pptx', 'ppt', 'docx', 'doc']);

export interface ProcessorOptions {
  workspace: string;
  pdfBackend: string; // 'pdfjs' | 'mistral'
  mistralApiKey: string;
}

async function storePageContents(
  db: Db,
  docId: string,
  pageContents: PageContents,
  parser: string,
): Promise<void> {
  const chunkRepo = new ChunkRepository(db);
  await chunkRepo.storePages(docId, pageContents);
  const fullContent = pageContents.map(([, md]) => md).join('\n\n---\n\n');
  await chunkRepo.storeChunks(docId, chunkPages(pageContents));
  await db.query(
    "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = $3, " +
      'parser = $4, updated_at = NOW() WHERE id = $1',
    [docId, fullContent, pageContents.length, parser],
  );
}

export async function processDocument(db: Db, docId: string, opts: ProcessorOptions): Promise<void> {
  const { rows } = await db.query(
    'SELECT id, filename, file_type, relative_path, status FROM jz_kb_documents WHERE id = $1',
    [docId],
  );
  const doc = rows[0];
  if (!doc) return;
  if (!['pending', 'processing'].includes(doc.status)) return;

  const fileType: string = doc.file_type || '';
  const filePath = path.join(opts.workspace, doc.relative_path);
  const workspace = opts.workspace;

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    await db.query(
      "UPDATE jz_kb_documents SET status = 'failed', error_message = 'File not found', updated_at = NOW() WHERE id = $1",
      [docId],
    );
    return;
  }

  await db.query("UPDATE jz_kb_documents SET status = 'processing', updated_at = NOW() WHERE id = $1", [docId]);

  try {
    if (PDF_TYPES.has(fileType)) {
      if (opts.pdfBackend === 'mistral' && opts.mistralApiKey) {
        const pages = await extractPdfViaMistral(filePath, opts.mistralApiKey);
        await storePageContents(db, docId, pages, 'mistral');
      } else {
        let pages = await extractPdfPages(filePath);
        if (isScannedPdf(pages)) {
          // 无文本层（扫描件）→ 本地 OCR（tesseract.js）
          pages = await ocrPdfPages(filePath);
          await storePageContents(db, docId, pages, 'tesseract');
        } else {
          await storePageContents(db, docId, pages, 'pdfjs');
        }
      }
    } else if (OFFICE_TYPES.has(fileType)) {
      const { pages, parser } = await processOfficeDocument(fileType, filePath);
      await storePageContents(db, docId, pages, parser);
    } else if (SPREADSHEET_TYPES.has(fileType)) {
      const sheets = extractSpreadsheet(filePath);
      const chunkRepo = new ChunkRepository(db);
      const pageContents: PageContents = sheets.map((s) => [s.page, s.content]);
      const elements = new Map(sheets.map((s) => [s.page, JSON.stringify({ sheet_name: s.sheetName })]));
      await chunkRepo.storePages(docId, pageContents, elements);
      const fullContent = sheets.map((s) => `## ${s.sheetName}\n\n${s.content}`).join('\n\n');
      await chunkRepo.storeChunks(docId, chunkPages(pageContents));
      await db.query(
        "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = $3, " +
          "parser = 'xlsx', updated_at = NOW() WHERE id = $1",
        [docId, fullContent, sheets.length],
      );
    } else if (IMAGE_TYPES.has(fileType)) {
      // 图片：本地 OCR 提取文本；识别不到内容时保持原语义（ready 无 content）
      let ocrText = '';
      try {
        ocrText = await ocrImage(filePath);
      } catch (err: any) {
        console.warn(`[kbs] 图片 OCR 失败 ${doc.filename}: ${err.message}`);
      }
      if (ocrText) {
        const chunkRepo = new ChunkRepository(db);
        await chunkRepo.storeChunks(docId, chunkText(ocrText));
        await db.query(
          "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = 1, " +
            "parser = 'tesseract', updated_at = NOW() WHERE id = $1",
          [docId, ocrText],
        );
      } else {
        await db.query(
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
      const chunkRepo = new ChunkRepository(db);
      await chunkRepo.storeChunks(docId, chunkText(content));
      await db.query(
        "UPDATE jz_kb_documents SET status = 'ready', content = $2, page_count = 1, " +
          "parser = 'webmd', updated_at = NOW() WHERE id = $1",
        [docId, content],
      );
    } else {
      await db.query("UPDATE jz_kb_documents SET status = 'ready', updated_at = NOW() WHERE id = $1", [docId]);
    }
  } catch (err: any) {
    const msg = err instanceof UnsupportedOfficeFormatError
      ? err.message
      : String(err?.message || err).slice(0, 500);
    await db.query(
      "UPDATE jz_kb_documents SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
      [docId, msg],
    );
    console.error(`[kbs] 文档处理失败 ${doc.filename}: ${msg}`);
  }
}

// ── 串行队列 ──────────────────────────────────────────────────────────────

let _queue: Promise<unknown> = Promise.resolve();

/** 后台排队处理（fire-and-forget，对齐 Python asyncio.create_task 语义） */
export function enqueueProcessing(db: Db, docId: string, opts: ProcessorOptions): void {
  _queue = _queue
    .then(() => processDocument(db, docId, opts))
    .catch((err) => console.error(`[kbs] 处理队列异常: ${err?.message || err}`));
}
