/**
 * 本地 OCR（tesseract.js，移植自 kbs/src/processor/ocr.ts）。
 * - 语言包默认 <main 包根>/tessdata（可用 TESSDATA_PREFIX 覆盖）
 * - worker 惰性单例（chi_sim+eng 联合识别）
 * - 扫描版 PDF：提取每页嵌入位图逐页 OCR（避免 pdfjs Node 渲染挂起）
 */
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import type { PageContents } from './pdf';

export interface OcrOptions {
  tessdataPath?: string;
  langs?: string[];
}

let _worker: any = null;
let _workerLangs = '';

function defaultTessdataPath(): string {
  if (process.env.TESSDATA_PREFIX) return process.env.TESSDATA_PREFIX;
  // dist/knowledge/processor/ocr.js → ../../../tessdata；dev(src/knowledge/processor)同构
  return path.resolve(__dirname, '..', '..', '..', 'tessdata');
}

async function getWorker(langs: string[], tessdataPath: string) {
  const key = langs.join('+');
  if (_worker && _workerLangs === key) return _worker;
  if (_worker) {
    await _worker.terminate().catch(() => {});
    _worker = null;
  }
  const { createWorker } = await import('tesseract.js');
  _worker = await createWorker(langs, 1, {
    langPath: tessdataPath,
    gzip: false,
    cacheMethod: 'none',
  });
  _workerLangs = key;
  return _worker;
}

/** 进程退出前释放 worker（NestJS onModuleDestroy 调用） */
export async function terminateOcrWorker(): Promise<void> {
  if (_worker) {
    await _worker.terminate().catch(() => {});
    _worker = null;
  }
}

/** 识别单张图片（Buffer 或文件路径），返回纯文本 */
export async function ocrImage(input: Buffer | string, opts: OcrOptions = {}): Promise<string> {
  const langs = opts.langs || ['chi_sim', 'eng'];
  const worker = await getWorker(langs, opts.tessdataPath || defaultTessdataPath());
  const { data } = await worker.recognize(input);
  return (data.text || '').trim();
}

// ── 扫描版 PDF ────────────────────────────────────────────────────────────

interface EmbeddedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function extractPageImages(page: any, pdfjs: any): Promise<EmbeddedImage[]> {
  const ops = await page.getOperatorList();
  const images: EmbeddedImage[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintJpegXObject) continue;
    const objId = ops.argsArray[i][0];
    const obj = await new Promise<any>((resolve, reject) => {
      try {
        page.objs.get(objId, resolve);
      } catch (e) {
        reject(e);
      }
      setTimeout(() => reject(new Error(`PDF 内嵌图像解析超时: ${objId}`)), 15000);
    });
    if (obj?.width > 0 && obj?.height > 0 && obj?.data) {
      images.push({ width: obj.width, height: obj.height, data: obj.data });
    }
  }
  return images;
}

async function imageToPng(img: EmbeddedImage): Promise<Buffer> {
  const { width: w, height: h } = img;
  let rgba: Uint8ClampedArray;
  if (img.data.length === w * h * 4) {
    rgba = img.data;
  } else if (img.data.length === w * h * 3) {
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let s = 0, d = 0; s < img.data.length; s += 3, d += 4) {
      rgba[d] = img.data[s];
      rgba[d + 1] = img.data[s + 1];
      rgba[d + 2] = img.data[s + 2];
      rgba[d + 3] = 255;
    }
  } else {
    throw new Error(`无法识别的图像数据格式: ${img.data.length} bytes for ${w}x${h}`);
  }
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').putImageData(new NapiImageData(rgba, w, h) as any, 0, 0);
  return canvas.encode('png');
}

/** 扫描版 PDF：提取每页嵌入位图并逐页 OCR，返回 [(pageNum, text)] */
export async function ocrPdfPages(pdfPath: string, opts: OcrOptions = {}): Promise<PageContents> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true } as any).promise;

  const pages: PageContents = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const images = await extractPageImages(page, pdfjs);
    if (images.length === 0) {
      pages.push([pageNum, '']);
      continue;
    }
    images.sort((a, b) => b.width * b.height - a.width * a.height);
    const png = await imageToPng(images[0]);
    const text = await ocrImage(png, opts);
    pages.push([pageNum, postprocess(text)]);
  }
  await doc.destroy();
  return pages;
}

function postprocess(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 判断 pdfjs 提取结果是否视为"扫描版"（几乎无文本层） */
export function isScannedPdf(pageContents: PageContents): boolean {
  const total = pageContents.reduce((sum, [, t]) => sum + t.replace(/\s/g, '').length, 0);
  return total < 20;
}
