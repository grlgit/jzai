/**
 * PDF 文本提取（pdfjs-dist，移植自 kbs/src/processor/pdf.ts）。
 * 输出 [(pageNum, markdownText)]，页码从 1 开始；无内容页返回空串。
 */
import * as fs from 'fs';

export type PageContents = Array<[number, string]>;

export async function extractPdfPages(pdfPath: string): Promise<PageContents> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
  } as any);
  const doc = await loadingTask.promise;

  const pages: PageContents = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    const cleaned = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    pages.push([pageNum, cleaned]);
  }
  await doc.destroy();
  return pages;
}
