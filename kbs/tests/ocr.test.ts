/**
 * OCR 管线冒烟：生成含中英文文本的图片 → tesseract.js 识别；
 * 嵌入单页 PDF（模拟扫描件）→ ocrPdfPages。
 * 真实执行 OCR，耗时较长（chi_sim 模型加载 ~秒级），超时放宽。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ocrImage, ocrPdfPages, isScannedPdf, terminateOcrWorker } from '../src/processor/ocr';

async function renderTextImage(): Promise<Buffer> {
  const canvas = createCanvas(1200, 400);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = '#000000';
  ctx.font = '48px sans-serif';
  ctx.fillText('麒麟芯片良率分析报告', 60, 120);
  ctx.font = '36px sans-serif';
  ctx.fillText('Xuanwu Architecture Yield 92 percent', 60, 220);
  ctx.fillText('玄武架构显著提升能效比', 60, 320);
  return canvas.encode('png');
}

async function makeScannedPdf(png: Buffer, outPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  const page = pdf.addPage([1200, 400]);
  page.drawImage(img, { x: 0, y: 0, width: 1200, height: 400 });
  fs.writeFileSync(outPath, await pdf.save());
}

afterAll(async () => {
  await terminateOcrWorker();
});

describe('OCR 管线（tesseract.js）', () => {
  it('图片 OCR：识别中英文', async () => {
    const png = await renderTextImage();
    const text = await ocrImage(png);
    expect(text).toContain('Yield');
    expect(text).toContain('92');
    // 中文关键字（允许个别字误差，取识别稳定的片段）
    expect(text.replace(/\s/g, '')).toContain('良率');
  }, 120000);

  it('扫描版 PDF：逐页识别 + isScannedPdf 判定', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-ocr-')), 'scan.pdf');
    await makeScannedPdf(await renderTextImage(), tmp);

    // 扫描件 → pdfjs 文本层应为空（isScannedPdf=true）
    const { extractPdfPages } = await import('../src/processor/pdf');
    const textPages = await extractPdfPages(tmp);
    expect(isScannedPdf(textPages)).toBe(true);

    const pages = await ocrPdfPages(tmp);
    expect(pages.length).toBe(1);
    expect(pages[0][1]).toContain('Yield');
    expect(pages[0][1].replace(/\s/g, '')).toContain('良率');
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }, 120000);
});
