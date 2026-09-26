/**
 * 对译 llm_wiki/api/services/chunker.py：
 * ~512 token 块、~128 token 重叠、markdown 标题面包屑。token 估算 = len//4。
 */
export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 128;
export const MIN_CHUNK_TOKENS = 32;

export interface Chunk {
  index: number;
  content: string;
  page: number | null;
  start_char: number;
  token_count: number;
  header_breadcrumb: string;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

const HEADER_RE = /^(#{1,6})\s+(.+)$/;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function getOverlap(blocks: string[], targetTokens: number): { blocks: string[]; tokens: number } {
  const result: string[] = [];
  let tokens = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blockTokens = estimateTokens(blocks[i]);
    if (tokens + blockTokens > targetTokens) break;
    result.unshift(blocks[i]);
    tokens += blockTokens;
  }
  return { blocks: result, tokens };
}

export function chunkText(
  content: string,
  opts: { chunkSize?: number; overlap?: number; page?: number | null; startCharOffset?: number } = {},
): Chunk[] {
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const page = opts.page ?? null;
  const startCharOffset = opts.startCharOffset ?? 0;

  if (!content || !content.trim()) return [];

  const paragraphs = splitParagraphs(content);
  let headerStack: Array<[number, string]> = [];
  const chunks: Chunk[] = [];
  let currentBlocks: string[] = [];
  let currentTokens = 0;
  let currentStart = startCharOffset;
  let charPos = startCharOffset;

  const flush = () => {
    const text = currentBlocks.join('\n\n');
    if (estimateTokens(text) >= MIN_CHUNK_TOKENS) {
      chunks.push({
        index: chunks.length,
        content: text,
        page,
        start_char: currentStart,
        token_count: estimateTokens(text),
        header_breadcrumb: headerStack.map(([, t]) => t).join(' > '),
      });
    }
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    const headerMatch = para.match(HEADER_RE);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const heading = headerMatch[2].trim();
      headerStack = headerStack.filter(([l]) => l < level);
      headerStack.push([level, heading]);
    }

    if (currentTokens + paraTokens > chunkSize && currentBlocks.length > 0) {
      flush();
      const { blocks: overlapBlocks, tokens: overlapTokens } = getOverlap(currentBlocks, overlap);
      currentBlocks = overlapBlocks;
      currentTokens = overlapTokens;
      currentStart = charPos - overlapBlocks.reduce((sum, b) => sum + b.length + 2, 0);
    }

    currentBlocks.push(para);
    currentTokens += paraTokens;
    charPos += para.length + 2;
  }

  if (currentBlocks.length > 0) flush();

  return chunks;
}

/** 多页文档分块，保留页码。 */
export function chunkPages(pageContents: Array<[number, string]>): Chunk[] {
  const all: Chunk[] = [];
  for (const [pageNum, content] of pageContents) {
    for (const c of chunkText(content, { page: pageNum })) {
      c.index = all.length;
      all.push(c);
    }
  }
  return all;
}
