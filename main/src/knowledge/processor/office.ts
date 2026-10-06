/**
 * Office 文档处理（移植自 kbs/src/processor/office.ts）：
 *   - docx → mammoth.convertToHtml → 正文提取（cheerio）
 *   - pptx → JSZip + slide XML 提取（每 slide 一页）
 *   - 旧二进制格式（doc/ppt）→ 明确报错
 */
import * as fs from 'fs';
import * as cheerio from 'cheerio';
import type { PageContents } from './pdf';

export class UnsupportedOfficeFormatError extends Error {
  constructor(fileType: string) {
    super(
      `不支持旧版二进制 .${fileType} 格式（纯 TS 管线无 LibreOffice）。` +
        `请转换为 .${fileType}x 后重新上传。`,
    );
  }
}

// ── docx ──────────────────────────────────────────────────────────────────

function htmlToBlocks(html: string): string {
  const $ = cheerio.load(html);
  const blocks: string[] = [];
  $('h1, h2, h3, h4, h5, h6, p, li, td, th').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const tag = (el as any).tagName?.toLowerCase() || '';
    if (/^h[1-6]$/.test(tag)) blocks.push(`${'#'.repeat(parseInt(tag[1], 10))} ${text}`);
    else if (tag === 'li') blocks.push(`- ${text}`);
    else blocks.push(text);
  });
  const deduped = blocks.filter((b, i) => i === 0 || b !== blocks[i - 1]);
  return deduped.join('\n\n');
}

async function extractDocx(filePath: string): Promise<{ pages: PageContents; parser: string }> {
  const mammoth = await import('mammoth');
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.convertToHtml({ buffer });
  const content = htmlToBlocks(result.value);
  return { pages: [[1, content]], parser: 'mammoth' };
}

// ── pptx ──────────────────────────────────────────────────────────────────

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

async function extractPptx(filePath: string): Promise<{ pages: PageContents; parser: string }> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));

  const slideFiles = Object.keys(zip.files)
    .map((p) => ({ p, m: p.match(SLIDE_RE) }))
    .filter((x) => x.m)
    .sort((a, b) => parseInt(a.m![1], 10) - parseInt(b.m![1], 10));

  if (slideFiles.length === 0) throw new Error('pptx 中未找到幻灯片 (ppt/slides/slideN.xml)');

  const pages: PageContents = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i].p].async('string');
    const $ = cheerio.load(xml, { xml: true });
    const lines: string[] = [];
    let current: string[] = [];
    $('a\\:p').each((_, p) => {
      current = [];
      $(p)
        .find('a\\:t')
        .each((_, t) => {
          current.push($(t).text());
        });
      const line = current.join('').trim();
      if (line) lines.push(line);
    });
    pages.push([i + 1, lines.join('\n')]);
  }
  return { pages, parser: 'pptx-xml' };
}

// ── 入口 ──────────────────────────────────────────────────────────────────

export async function processOfficeDocument(
  fileType: string,
  filePath: string,
): Promise<{ pages: PageContents; parser: string }> {
  if (fileType === 'docx') return extractDocx(filePath);
  if (fileType === 'pptx') return extractPptx(filePath);
  throw new UnsupportedOfficeFormatError(fileType);
}
