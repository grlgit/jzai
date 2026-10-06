/**
 * HTML 正文提取（cheerio，移植自 kbs/src/processor/html.ts）：
 * 去 script/style 等非内容节点 → 优先 article/main → 块级元素按段落拼接。
 */
import * as cheerio from 'cheerio';

export function extractHtmlContent(rawHtml: string): string {
  const $ = cheerio.load(rawHtml);
  $('script, style, noscript, iframe, svg, nav, footer, header, form, button').remove();

  const root = ($('article').length
    ? $('article').first()
    : $('main').length
      ? $('main').first()
      : $('body').length
        ? $('body')
        : $.root()) as cheerio.Cheerio<any>;

  const blocks: string[] = [];
  root.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th, caption').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const tag = (el as any).tagName?.toLowerCase() || '';
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`${'#'.repeat(parseInt(tag[1], 10))} ${text}`);
    } else if (tag === 'li') {
      blocks.push(`- ${text}`);
    } else {
      blocks.push(text);
    }
  });

  const deduped = blocks.filter((b, i) => i === 0 || b !== blocks[i - 1]);
  return deduped.join('\n\n') || root.text().replace(/\s+/g, ' ').trim();
}
