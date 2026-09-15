import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance } from '../../agent/tool-bridge/tool-provider.interface';

/**
 * WebToolProvider — web-facing tools (search, fetch, browser, scraping).
 * No external NestJS service dependencies; uses native fetch / dynamic imports.
 */
// 抓取即限长：单次网页/接口结果进上下文的字符上限（控制请求体体积，避免少数大页撑爆）。
// 已抽正文（去脚本/样式/导航），8K 足够承载要点；需要更深可用 firecrawl。
const WEB_FETCH_MAX_CHARS = 8000;

@Injectable()
export class WebToolProvider implements ToolProvider {
  private readonly logger = new Logger(WebToolProvider.name);

  readonly toolIds = ['fetch_url', 'web_search', 'web_fetch', 'browser', 'firecrawl', 'tavily'];

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'fetch_url',   label: '读取网页',          group: 'Web' },
      { id: 'web_search',  label: '网页搜索',          group: 'Web' },
      { id: 'web_fetch',   label: '网页抓取(增强)',     group: 'Web' },
      { id: 'browser',     label: '浏览器自动化',       group: 'Web' },
      { id: 'firecrawl',   label: '深度网页抓取',       group: 'Web' },
      { id: 'tavily',      label: '智能搜索',           group: 'Web' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const { Type } = ctx.piAi ?? {};
    if (!Type) {
      this.logger.warn('piAi.Type unavailable — returning empty tool set');
      return [];
    }

    const tools: ToolInstance[] = [];

    // ── fetch_url ──────────────────────────────────────────────────
    tools.push({
      name: 'fetch_url',
      label: '读取网页',
      description: '读取指定 URL 的网页内容（HTML 转文本）。',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id: string, args: { url: string }) => {
        try {
          const resp = await fetch(args.url, {
            headers: { 'User-Agent': 'JianZhi-Agent/1.0' },
            signal: AbortSignal.timeout(15000),
          });
          if (!resp.ok) return { content: [{ type: 'text' as const, text: `请求失败: ${resp.status}` }], details: null };
          let text = await resp.text();
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('html')) {
            text = text
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{2,}/g, ' ')
              .trim();
          }
          if (text.length > WEB_FETCH_MAX_CHARS) text = text.substring(0, WEB_FETCH_MAX_CHARS) + '\n... (已限长截断)';
          return { content: [{ type: 'text' as const, text }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `读取失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── web_search — DuckDuckGo HTML search ────────────────────────
    tools.push({
      name: 'web_search',
      label: '网页搜索',
      description: '搜索互联网获取最新信息。支持关键词搜索，返回标题、摘要和链接。',
      parameters: Type.Object({
        query: Type.String({ description: '搜索关键词' }),
        maxResults: Type.Optional(Type.Number({ description: '最大返回数量，默认5' })),
      }),
      execute: async (_id: string, args: { query: string; maxResults?: number }) => {
        const max = args.maxResults || 5;
        try {
          const resp = await fetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
            { headers: { 'User-Agent': 'JianZhi-Agent/1.0' }, signal: AbortSignal.timeout(10000) },
          );
          const html = await resp.text();
          const results: string[] = [];
          const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(html)) && results.length < max) {
            const url = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0];
            const title = match[2].replace(/<[^>]+>/g, '').trim();
            const snippet = match[3].replace(/<[^>]+>/g, '').trim();
            if (title) results.push(`**${title}**\n${snippet}\n${decodeURIComponent(url)}`);
          }
          if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: `未找到与"${args.query}"相关的搜索结果` }], details: null };
          }
          return {
            content: [{ type: 'text' as const, text: `## 搜索结果: ${args.query}\n\n${results.join('\n\n---\n\n')}` }],
            details: { count: results.length },
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `搜索失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── web_fetch — enhanced web scraping ──────────────────────────
    tools.push({
      name: 'web_fetch',
      label: '网页抓取(增强)',
      description: '抓取网页内容并提取正文。自动去除导航、广告等噪音，返回干净的 Markdown 文本。支持 JSON API 响应。',
      parameters: Type.Object({
        url: Type.String({ description: '目标 URL' }),
        selector: Type.Optional(Type.String({ description: 'CSS 选择器，仅提取匹配元素' })),
      }),
      execute: async (_id: string, args: { url: string; selector?: string }) => {
        try {
          const resp = await fetch(args.url, {
            headers: { 'User-Agent': 'JianZhi-Agent/1.0', Accept: 'text/html,application/json' },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
          });
          if (!resp.ok) return { content: [{ type: 'text' as const, text: `请求失败: ${resp.status} ${resp.statusText}` }], details: null };
          const ct = resp.headers.get('content-type') || '';

          if (ct.includes('json')) {
            const json = await resp.json();
            const text = JSON.stringify(json, null, 2);
            return {
              content: [{ type: 'text' as const, text: text.length > WEB_FETCH_MAX_CHARS ? text.slice(0, WEB_FETCH_MAX_CHARS) + '\n...(已限长截断)' : text }],
              details: { type: 'json' },
            };
          }

          let html = await resp.text();
          html = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<header[\s\S]*?<\/header>/gi, '');

          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';

          let text = html
            .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n## $1\n\n')
            .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          if (title) text = `# ${title}\n\n${text}`;
          if (text.length > WEB_FETCH_MAX_CHARS) text = text.slice(0, WEB_FETCH_MAX_CHARS) + '\n...(已限长截断，需要更深内容可用 firecrawl)';
          return { content: [{ type: 'text' as const, text }], details: { title, url: args.url } };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `抓取失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── browser — Playwright browser automation ────────────────────
    tools.push({
      name: 'browser_action',
      label: '浏览器自动化',
      description: `使用浏览器执行自动化操作。支持的 action：
- navigate: 打开URL
- screenshot: 截图当前页面
- click: 点击元素（target为CSS选择器）
- fill: 填写表单（target为选择器，value为内容）
- evaluate: 执行JS代码
- content: 获取页面文本内容`,
      parameters: Type.Object({
        action: Type.String({ description: 'navigate|screenshot|click|fill|evaluate|content' }),
        target: Type.Optional(Type.String({ description: 'URL 或 CSS 选择器' })),
        value: Type.Optional(Type.String({ description: '填写内容或 JS 代码' })),
      }),
      execute: async (_id: string, args: { action: string; target?: string; value?: string }) => {
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          let result = '';

          switch (args.action) {
            case 'navigate':
              await page.goto(args.target || 'about:blank', { timeout: 15000 });
              result = `已打开: ${page.url()}\n标题: ${await page.title()}`;
              break;
            case 'screenshot': {
              if (args.target) await page.goto(args.target, { timeout: 15000 });
              const buf = await page.screenshot({ fullPage: false });
              result = `截图完成 (${buf.length} bytes)`;
              break;
            }
            case 'click':
              await page.click(args.target || 'body', { timeout: 5000 });
              result = `已点击: ${args.target}`;
              break;
            case 'fill':
              await page.fill(args.target || 'input', args.value || '', { timeout: 5000 });
              result = `已填写: ${args.target} = ${args.value}`;
              break;
            case 'evaluate':
              result = String(await page.evaluate(args.value || '""'));
              break;
            case 'content': {
              if (args.target) await page.goto(args.target, { timeout: 15000 });
              const text = await page.innerText('body');
              result = text.length > 15000 ? text.slice(0, 15000) + '\n...(截断)' : text;
              break;
            }
            default:
              result = `未知操作: ${args.action}`;
          }

          await browser.close();
          return { content: [{ type: 'text' as const, text: result }], details: { action: args.action } };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `浏览器操作失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── firecrawl — deep web scraping via Playwright ───────────────
    tools.push({
      name: 'firecrawl',
      label: '深度网页抓取',
      description: '深度抓取网页，自动处理 JS 渲染、分页加载、结构化内容提取。比普通 fetch 更强，适合复杂网站。',
      parameters: Type.Object({
        url: Type.String({ description: '目标 URL' }),
        depth: Type.Optional(Type.Number({ description: '抓取深度（跟随链接层数），默认0' })),
      }),
      execute: async (_id: string, args: { url: string; depth?: number }) => {
        try {
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          await page.goto(args.url, { waitUntil: 'networkidle', timeout: 20000 });
          await page.waitForTimeout(2000);
          const title = await page.title();
          const text = await page.innerText('body');
          await browser.close();

          const clean = text.replace(/\n{3,}/g, '\n\n').trim();
          const output = `# ${title}\n\nURL: ${args.url}\n\n${clean.length > 20000 ? clean.slice(0, 20000) + '\n...(截断)' : clean}`;
          return { content: [{ type: 'text' as const, text: output }], details: { title, url: args.url } };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `深度抓取失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── tavily — Tavily search with DuckDuckGo fallback ────────────
    // Keep a reference to the web_search tool we just created for fallback
    const webSearchTool = tools.find(t => t.name === 'web_search')!;

    tools.push({
      name: 'tavily_search',
      label: '智能搜索',
      description: '高质量智能搜索，自动提取并总结最相关的内容。比普通搜索更精准，适合需要深入了解某个话题的场景。',
      parameters: Type.Object({
        query: Type.String({ description: '搜索问题（自然语言）' }),
        searchDepth: Type.Optional(Type.String({ description: 'basic 或 advanced，默认 basic' })),
      }),
      execute: async (_id: string, args: { query: string; searchDepth?: string }) => {
        const apiKey = process.env.TAVILY_API_KEY;
        if (apiKey) {
          try {
            const resp = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: apiKey,
                query: args.query,
                search_depth: args.searchDepth || 'basic',
                max_results: 5,
              }),
              signal: AbortSignal.timeout(15000),
            });
            const data = (await resp.json()) as any;
            const results = (data.results || [])
              .map((r: any) => `**${r.title}**\n${r.content}\n${r.url}`)
              .join('\n\n---\n\n');
            const answer = data.answer ? `## 摘要\n${data.answer}\n\n---\n\n` : '';
            return {
              content: [{ type: 'text' as const, text: `${answer}## 搜索结果\n\n${results || '无结果'}` }],
              details: { count: data.results?.length },
            };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `Tavily 搜索失败: ${err.message}` }], details: null };
          }
        }
        // Fallback to web_search
        if (webSearchTool) {
          return webSearchTool.execute(_id, { query: args.query, maxResults: 5 });
        }
        return { content: [{ type: 'text' as const, text: '搜索服务未配置' }], details: null };
      },
    });

    return tools;
  }
}
