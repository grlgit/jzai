/**
 * full-app 后端入口 —— 完整型演示：数据库 + controller + agent 工具。
 * 加载契约：平台 require(dist/backend/index.js)，取导出类 static forApp(ctx)。
 */
import type {
  AppContext, AppModuleShape,
  ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance,
} from '../types/backend';

interface Note {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

// ── ToolProvider：注册给 agent 的工具 ──
class NoteToolProvider implements ToolProvider {
  readonly toolIds = ['fa_note_add'];

  constructor(private readonly app: AppContext) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{
      id: 'fa_note_add',
      label: '记笔记',
      group: '备忘',
      description: '向备忘本写入一条笔记（标题 + 内容），返回新笔记 id 与当前笔记总数',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '笔记标题' },
          content: { type: 'string', description: '笔记内容' },
        },
        required: ['title', 'content'],
      },
    }];
  }

  async createTools(_ctx: ToolContext): Promise<ToolInstance[]> {
    return [{
      name: 'fa_note_add',
      description: '向备忘本写入一条笔记（标题 + 内容）',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
      execute: async (_id: string, args: { title: string; content: string }) => {
        const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await this.app.query(
          `INSERT INTO fa_notes (id, title, content) VALUES ($1, $2, $3)`,
          [noteId, args.title, args.content],
        );
        // 返回给 LLM 的内容保持聚合摘要，不回灌整表
        const [{ count }] = await this.app.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM fa_notes`,
        );
        return { noteId, total: Number(count) };
      },
    }];
  }
}

// ── Controller：面板经 invoke 入口调用（方法须在 manifest handlers 白名单）──
class NoteController {
  constructor(private readonly app: AppContext) {}

  async listNotes(_body: unknown): Promise<{ notes: Note[] }> {
    const notes = await this.app.query<Note>(
      `SELECT id, title, content, created_at FROM fa_notes ORDER BY created_at DESC`,
    );
    return { notes };
  }

  async addNote(body: { title?: string; content?: string }) {
    const title = body?.title?.trim();
    if (!title) throw new Error('title 不能为空');
    const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.app.query(
      `INSERT INTO fa_notes (id, title, content) VALUES ($1, $2, $3)`,
      [noteId, title, body?.content ?? ''],
    );
    return { ok: true, noteId };
  }

  async deleteNote(body: { id?: string }) {
    if (!body?.id) throw new Error('id 不能为空');
    await this.app.query(`DELETE FROM fa_notes WHERE id = $1`, [body.id]);
    return { ok: true };
  }
}

export class FullAppModule {
  static forApp(ctx: AppContext): AppModuleShape {
    return {
      toolProviders: [new NoteToolProvider(ctx)],
      controllers: { NoteController: new NoteController(ctx) },
    };
  }
}

export default FullAppModule;
