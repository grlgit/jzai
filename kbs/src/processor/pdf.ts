/**
 * PDF 文本提取（pdfjs-dist）— 替代 opendataloader-pdf（Java）。
 * 输出 [(pageNum, markdownText)]，页码从 1 开始；无内容页返回空串（保持页码对齐）。
 *
 * 已知取舍：不提取图片、不识别标题层级（纯文本流），
 * 与 opendataloader 的结构化 markdown 存在格式差异（见计划风险#3）。
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
    // 折叠空行、规整段落（双换行分段，对齐 chunker 段落语义）
    const cleaned = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    pages.push([pageNum, cleaned]);
  }
  await doc.destroy();
  return pages;
}
