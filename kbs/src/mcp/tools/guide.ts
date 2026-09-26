/**
 * 对译 mcp/tools/guide.py — 工作区配置导览（pg_local 无 schema_config 分支）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolContext, createVaultFS } from './index';
import { ensureTaxonomyLoaded, resolveCategoryTree } from './taxonomy';

const CUSTOM_GUIDE_FILENAME = 'GUIDE.md';

const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese (中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
  ru: 'Russian (Русский)',
  ar: 'Arabic (العربية)',
  tr: 'Turkish (Türkçe)',
};

function languageInstruction(langCode: string): string {
  const langName = LANGUAGE_NAMES[langCode] || langCode;
  return `
## Language Setting

**Target language: ${langName} (\`${langCode}\`)**

ALL wiki content you create or update MUST be written in **${langName}**. This applies to:
- Page titles and descriptions (in frontmatter)
- All body text, headings, summaries, and analysis
- Table headers and cell content
- Mermaid diagram labels and descriptions
- Log entries

**Do NOT translate:**
- Source filenames in citations (keep original filenames)
- Technical codes and identifiers (e.g., ST 201, W05)
- Proper nouns and brand names (e.g., LC Waikiki)
- Frontmatter field names (\`title\`, \`description\`, \`date\`, \`tags\`)

When ingesting a source document in any language, read and understand it in its original language, then write all wiki content in ${langName}.
`;
}

function loadCustomGuide(workspace: string): string | null {
  try {
    const p = path.join(workspace, CUSTOM_GUIDE_FILENAME);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8').trim();
      if (content) return content;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function registerGuide(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'guide',
    {
      description:
        'Get workspace configuration: available knowledge bases, enterprise schema, language setting, and taxonomy. Call this first to discover the KB slug needed for all other tool calls.',
      inputSchema: {},
    },
    async () => {
      const fs0 = createVaultFS(ctx);
      const kbs = await fs0.listKnowledgeBases();

      let text = '# KB Workspace Configuration\n\n';

      const customGuide = loadCustomGuide(ctx.workspace);
      if (customGuide) {
        text += '## Workspace Custom Instructions\n\n' + customGuide + '\n\n';
      }

      const langCode = ctx.wikiLanguage.trim().toLowerCase();
      if (langCode) {
        text += languageInstruction(langCode);
      }

      try {
        await ensureTaxonomyLoaded();
        const tree = resolveCategoryTree();
        if (tree) {
          text += '\n## Knowledge Classification Tree\n\n```\n' + tree + '\n```\n\n';
        }
      } catch {
        /* ignore */
      }

      if (kbs.length === 0) {
        return { content: [{ type: 'text' as const, text: text + '\nNo knowledge bases yet.' }] };
      }

      text += '## Available Knowledge Bases\n\n';
      for (const kb of kbs) {
        text += `- **${kb.name}** — slug: \`${kb.slug}\` (${kb.source_count ?? '?'} sources, ${kb.wiki_count ?? '?'} wiki pages)\n`;
      }
      if (kbs.length === 1) {
        text += `\n> All tool calls MUST include \`knowledge_base="${kbs[0].slug}"\`.\n`;
      } else {
        text += '\n> Every tool call MUST include `knowledge_base="<slug>"` from the list above.\n';
      }

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
