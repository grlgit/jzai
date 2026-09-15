import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { OcrService } from './ocr.service';

/**
 * MediaToolProvider — OCR, document extraction, image understanding/editing,
 * whisper transcription, and content summarization.
 */
@Injectable()
export class MediaToolProvider implements ToolProvider {
  readonly toolIds = ['ocr', 'document_extract', 'image_understand', 'image_edit', 'whisper', 'summarize'];

  constructor(private readonly ocrService: OcrService) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'ocr', label: 'OCR文档提取', group: '资料处理' },
      { id: 'document_extract', label: '文档提取', group: '资料处理' },
      { id: 'image_understand', label: '图片理解', group: '资料处理' },
      { id: 'image_edit', label: '图片编辑', group: '资料处理' },
      { id: 'whisper', label: '语音转文字', group: '资料处理' },
      { id: 'summarize', label: '内容摘要', group: '资料处理' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    const tools: ToolInstance[] = [];

    // ── ocr ──────────────────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'ocr_extract',
        label: 'OCR文档提取',
        description: `提取文档中的文字内容（支持PDF、Office、图片、表格）。
使用 Mistral OCR 引擎识别复杂表格和版面布局，或使用 opendataloader 结构化提取。
返回按页分组的 Markdown 格式文本。适合需要高质量文字识别的场景（扫描件、复杂排版PDF、表格密集文档）。`,
        parameters: Type.Object({
          filePath: Type.String({ description: '要提取的文件绝对路径' }),
          pages: Type.Optional(Type.String({ description: '提取指定页码范围，如 "1-5" 或 "3,7,10"（仅PDF有效）' })),
        }),
        execute: async (_id: string, args: { filePath: string; pages?: string }) => {
          try {
            const result = await this.ocrService.extract(args.filePath);
            let output = `## OCR提取结果\n- 引擎: ${result.parser}\n- 页数: ${result.pageCount}\n\n`;

            // Filter pages if specified
            let pages = result.pages;
            if (args.pages && result.pages.length > 1) {
              const pageNums = this.parsePageRange(args.pages, result.pageCount);
              pages = result.pages.filter(p => pageNums.has(p.page));
              output += `(已筛选页码: ${args.pages})\n\n`;
            }

            for (const page of pages) {
              output += `### 第 ${page.page} 页\n\n${page.content}\n\n`;
            }

            if (result.images?.length) {
              output += `\n提取的图片 (${result.images.length} 张) 已保存到: ${result.images[0].replace(/\/[^/]+$/, '/')}\n`;
            }

            // Truncate if too long
            if (output.length > 30000) {
              output = output.substring(0, 30000) + '\n\n... (内容已截断，共 ' + output.length + ' 字符)';
            }

            return { content: [{ type: 'text' as const, text: output }], details: { parser: result.parser, pageCount: result.pageCount } };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `OCR提取失败: ${err.message}` }], details: null };
          }
        },
      });
    }

    // ── document_extract ─────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'document_extract',
        label: '文档提取',
        description: '从各类文档（PDF、Word、Excel、PPT、TXT、CSV）提取文本内容。支持中文文档。',
        parameters: Type.Object({
          filePath: Type.String({ description: '文件绝对路径' }),
        }),
        execute: async (_id: string, args: { filePath: string }) => {
          try {
            const result = await this.ocrService.extract(args.filePath);
            let output = `## 文档提取\n- 引擎: ${result.parser}\n- 页数: ${result.pageCount}\n\n`;
            for (const page of result.pages) {
              output += `### 第 ${page.page} 页\n\n${page.content}\n\n`;
            }
            if (output.length > 30000) output = output.slice(0, 30000) + '\n...(截断)';
            return { content: [{ type: 'text' as const, text: output }], details: { parser: result.parser, pageCount: result.pageCount } };
          } catch (err: any) {
            // Fallback: try reading as text, but only for actual text files
            const ext = path.extname(args.filePath).toLowerCase();
            const textExts = new Set(['.txt', '.csv', '.tsv', '.md', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.ini', '.cfg', '.conf']);
            if (textExts.has(ext)) {
              try {
                const text = fs.readFileSync(args.filePath, 'utf-8');
                return { content: [{ type: 'text' as const, text: text.length > 30000 ? text.slice(0, 30000) + '\n...(截断)' : text }], details: { parser: 'text' } };
              } catch {}
            }
            return { content: [{ type: 'text' as const, text: `文档提取失败: ${err.message}。文件类型 ${ext} 可能需要安装额外的解析器。` }], details: null };
          }
        },
      });
    }

    // ── summarize ────────────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'summarize',
        label: '内容摘要',
        description: '对长文本、文档、网页内容生成结构化摘要。自动识别要点，输出简洁的摘要。',
        parameters: Type.Object({
          content: Type.String({ description: '要摘要的文本内容' }),
          style: Type.Optional(Type.String({ description: 'brief(简要) 或 detailed(详细)，默认 brief' })),
          language: Type.Optional(Type.String({ description: '输出语言，默认中文' })),
        }),
        execute: async (_id: string, args: { content: string; style?: string; language?: string }) => {
          const text = args.content.length > 8000 ? args.content.slice(0, 8000) + '...(截断)' : args.content;
          const prompt = args.style === 'detailed'
            ? `请对以下内容做详细摘要，包含所有关键要点、数据和结论。用${args.language || '中文'}输出。\n\n${text}`
            : `请用3-5个要点概括以下内容的核心信息。用${args.language || '中文'}输出。\n\n${text}`;
          return { content: [{ type: 'text' as const, text: `[摘要工具已接收 ${args.content.length} 字内容，请基于以下提示生成摘要]\n\n${prompt}` }], details: { length: args.content.length, style: args.style || 'brief' } };
        },
      });
    }

    // ── image_understand ─────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'image_understand',
        label: '图片理解',
        description: '分析图片内容，识别文字(OCR)、物体、场景、图表数据。支持截图、照片、扫描件。',
        parameters: Type.Object({
          filePath: Type.String({ description: '图片文件路径' }),
          question: Type.Optional(Type.String({ description: '关于图片的具体问题' })),
        }),
        execute: async (_id: string, args: { filePath: string; question?: string }) => {
          try {
            const result = await this.ocrService.extract(args.filePath);
            const text = result.pages.map(p => p.content).join('\n\n');
            const output = args.question
              ? `## 图片分析\n\n提取内容:\n${text}\n\n[请结合上述提取内容回答: ${args.question}]`
              : `## 图片内容\n\n${text || '(未提取到文字内容)'}`;
            return { content: [{ type: 'text' as const, text: output }], details: { parser: result.parser } };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `图片分析失败: ${err.message}` }], details: null };
          }
        },
      });
    }

    // ── image_edit ────────────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'image_edit',
        label: '图片编辑',
        description: `图片编辑工具（仅支持图片格式：PNG/JPG/WebP，不支持PDF）。
支持操作：
- 裁剪 (crop): 指定区域裁剪，参数 left/top/width/height
- 缩放 (resize): 按尺寸或比例缩放，参数 width/height/fit(cover/contain/fill/inside)
- 旋转 (rotate): 按角度旋转，参数 angle
- 格式转换 (convert): 转换格式，参数 format(png/jpg/webp/avif)
- 去白底 (removeBackground): 将白色/浅色背景变为透明
- 气泡标注 (drawBubble): 在图纸上绘制序号气泡，参数 x/y/number
- 信息 (info): 获取图片尺寸、格式等元数据
可以组合多个操作，按顺序执行。`,
        parameters: Type.Object({
          filePath: Type.String({ description: '源图片文件路径' }),
          outputPath: Type.Optional(Type.String({ description: '输出路径（留空则覆盖原文件，或自动加后缀）' })),
          operations: Type.Array(Type.Object({
            type: Type.String({ description: '操作类型: crop / resize / rotate / convert / removeBackground / drawBubble / info' }),
            left: Type.Optional(Type.Number({ description: '裁剪起始X' })),
            top: Type.Optional(Type.Number({ description: '裁剪起始Y' })),
            width: Type.Optional(Type.Number({ description: '裁剪/缩放宽度' })),
            height: Type.Optional(Type.Number({ description: '裁剪/缩放高度' })),
            fit: Type.Optional(Type.String({ description: '缩放模式: cover/contain/fill/inside/outside' })),
            angle: Type.Optional(Type.Number({ description: '旋转角度（度）' })),
            format: Type.Optional(Type.String({ description: '转换格式: png/jpg/webp/avif' })),
            quality: Type.Optional(Type.Number({ description: '输出质量 1-100（jpg/webp）' })),
            threshold: Type.Optional(Type.Number({ description: '去白底阈值 0-255，默认240' })),
            x: Type.Optional(Type.Number({ description: '气泡中心X坐标（drawBubble）' })),
            y: Type.Optional(Type.Number({ description: '气泡中心Y坐标（drawBubble）' })),
            number: Type.Optional(Type.Number({ description: '气泡序号（drawBubble）' })),
          }), { description: '操作列表，按顺序执行' }),
        }),
        execute: async (_id: string, args: { filePath: string; outputPath?: string; operations: any[] }) => {
          try {
            const sharp = (await import('sharp')).default;

            if (!fs.existsSync(args.filePath)) {
              return { content: [{ type: 'text' as const, text: `文件不存在: ${args.filePath}` }], details: null };
            }

            let img = sharp(args.filePath);
            const meta = await img.metadata();
            const results: string[] = [`源文件: ${args.filePath} (${meta.width}x${meta.height}, ${meta.format})`];

            for (const op of args.operations) {
              switch (op.type) {
                case 'info':
                  results.push(`尺寸: ${meta.width}x${meta.height}, 格式: ${meta.format}, 通道: ${meta.channels}, 大小: ${meta.size ? Math.round(meta.size / 1024) + 'KB' : '未知'}`);
                  break;

                case 'crop':
                  if (op.left != null && op.top != null && op.width && op.height) {
                    img = img.extract({ left: op.left, top: op.top, width: op.width, height: op.height });
                    results.push(`裁剪: (${op.left},${op.top}) ${op.width}x${op.height}`);
                  } else {
                    results.push('裁剪: 参数不完整，需要 left/top/width/height');
                  }
                  break;

                case 'resize': {
                  const resizeOpts: any = {};
                  if (op.width) resizeOpts.width = op.width;
                  if (op.height) resizeOpts.height = op.height;
                  if (op.fit) resizeOpts.fit = op.fit;
                  resizeOpts.background = { r: 0, g: 0, b: 0, alpha: 0 };
                  img = img.resize(resizeOpts);
                  results.push(`缩放: ${op.width || 'auto'}x${op.height || 'auto'} (${op.fit || 'cover'})`);
                  break;
                }

                case 'rotate':
                  img = img.rotate(op.angle || 0, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
                  results.push(`旋转: ${op.angle}°`);
                  break;

                case 'convert':
                  if (op.format === 'jpg' || op.format === 'jpeg') {
                    img = img.jpeg({ quality: op.quality || 85 });
                  } else if (op.format === 'webp') {
                    img = img.webp({ quality: op.quality || 80 });
                  } else if (op.format === 'avif') {
                    img = img.avif({ quality: op.quality || 60 });
                  } else {
                    img = img.png();
                  }
                  results.push(`格式转换: ${op.format}${op.quality ? ' (质量' + op.quality + ')' : ''}`);
                  break;

                case 'removeBackground': {
                  const threshold = op.threshold || 240;
                  const rawMeta = await sharp(args.filePath).metadata();
                  const rawBuf = await sharp(args.filePath).ensureAlpha().raw().toBuffer();
                  for (let i = 0; i < rawBuf.length; i += 4) {
                    if (rawBuf[i] > threshold && rawBuf[i + 1] > threshold && rawBuf[i + 2] > threshold) {
                      rawBuf[i + 3] = 0;
                    }
                  }
                  img = sharp(rawBuf, { raw: { width: rawMeta.width!, height: rawMeta.height!, channels: 4 } }).png();
                  results.push(`去白底: 阈值=${threshold}`);
                  break;
                }

                case 'drawBubble': {
                  // 在图纸上绘制序号气泡（用于机械图纸标注）
                  const bx = op.x || 0;
                  const by = op.y || 0;
                  const num = op.number || 1;
                  const radius = 20;

                  // 创建SVG气泡
                  const svgString = `
                    <svg width="${radius * 2}" height="${radius * 2}" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="${radius}" cy="${radius}" r="${radius - 2}" fill="white" stroke="#e74c3c" stroke-width="2"/>
                      <text x="${radius}" y="${radius}" font-family="Arial,sans-serif" font-size="16" font-weight="bold"
                            fill="#e74c3c" text-anchor="middle" dominant-baseline="middle">${num}</text>
                    </svg>
                  `;
                  const svgBuffer = Buffer.from(svgString);

                  img = img.composite([{
                    input: svgBuffer,
                    left: Math.round(bx - radius),
                    top: Math.round(by - radius),
                  }]);
                  results.push(`气泡 #${num} 在 (${Math.round(bx)}, ${Math.round(by)})`);
                  break;
                }

                default:
                  results.push(`未知操作: ${op.type}`);
              }
            }

            // Determine output path
            let outPath = args.outputPath;
            if (!outPath) {
              const ext = path.extname(args.filePath);
              const base = args.filePath.slice(0, -ext.length);
              outPath = `${base}_edited${ext}`;
            }

            await img.toFile(outPath);
            const outMeta = await sharp(outPath).metadata();
            results.push(`输出: ${outPath} (${outMeta.width}x${outMeta.height}, ${outMeta.format})`);

            return {
              content: [{ type: 'text' as const, text: results.join('\n') }],
              details: { outputPath: outPath, width: outMeta.width, height: outMeta.height, format: outMeta.format },
            };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `图片编辑失败: ${err.message}` }], details: null };
          }
        },
      });
    }

    // ── whisper ───────────────────────────────────────────────────────
    if (Type) {
      tools.push({
        name: 'whisper_transcribe',
        label: '语音转文字',
        description: '使用 Whisper 将音频/视频文件转为文字。支持中英文及多语言。',
        parameters: Type.Object({
          filePath: Type.String({ description: '音频或视频文件路径' }),
          language: Type.Optional(Type.String({ description: '语言代码（zh/en/ja），默认自动检测' })),
        }),
        execute: async (_id: string, args: { filePath: string; language?: string }) => {
          const apiKey = process.env.OPENAI_API_KEY || process.env.CLOUD_API_KEY;
          if (!apiKey) return { content: [{ type: 'text' as const, text: 'Whisper 服务未配置（需要 OPENAI_API_KEY）' }], details: null };
          try {
            const formData = new FormData();
            const fileBuffer = fs.readFileSync(args.filePath);
            const blob = new Blob([fileBuffer]);
            formData.append('file', blob, args.filePath.split('/').pop() || 'audio.mp3');
            formData.append('model', 'whisper-1');
            if (args.language) formData.append('language', args.language);

            const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}` },
              body: formData,
              signal: AbortSignal.timeout(60000),
            });
            if (!resp.ok) throw new Error(`API error: ${resp.status}`);
            const data = await resp.json() as any;
            return { content: [{ type: 'text' as const, text: `## 转写结果\n\n${data.text || '(空)'}` }], details: { duration: data.duration } };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `语音转写失败: ${err.message}` }], details: null };
          }
        },
      });
    }

    return tools;
  }

  /** Parse page range spec like "1-5" or "3,7,10" into a Set of page numbers */
  private parsePageRange(spec: string, maxPage: number): Set<number> {
    const pages = new Set<number>();
    for (const part of spec.split(',')) {
      const trimmed = part.trim();
      const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Math.max(1, parseInt(range[1]));
        const end = Math.min(maxPage, parseInt(range[2]));
        for (let i = start; i <= end; i++) pages.add(i);
      } else {
        const num = parseInt(trimmed);
        if (!isNaN(num) && num >= 1 && num <= maxPage) pages.add(num);
      }
    }
    return pages;
  }
}
