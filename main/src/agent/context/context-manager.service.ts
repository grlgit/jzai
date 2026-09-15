import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { WorkspaceService } from '../../workspace/workspace.service';

export interface PageContext {
  panel?: string;
  title?: string;
  nav?: string;
  url?: string;
  labels?: string[];
}

@Injectable()
export class ContextManagerService {
  private readonly logger = new Logger(ContextManagerService.name);
  private pageContexts = new Map<string, PageContext>();
  private currentAttachments = new Map<string, { fileName: string; filePath: string }[]>();

  constructor(private readonly workspace: WorkspaceService) {}

  // ── Page context ────────────────────────────────────────────────
  setPageContext(key: string, ctx: PageContext) {
    this.pageContexts.set(key, ctx);
  }

  getPageContext(key: string): PageContext | undefined {
    return this.pageContexts.get(key);
  }

  // ── Attachment context ──────────────────────────────────────────
  setAttachments(key: string, attachments: { fileName: string; filePath: string }[]) {
    this.currentAttachments.set(key, attachments);
  }

  clearAttachments(key: string) {
    this.currentAttachments.delete(key);
  }

  getAttachments(key: string): { fileName: string; filePath: string }[] | undefined {
    return this.currentAttachments.get(key);
  }

  // ── Cleanup ─────────────────────────────────────────────────────
  removeSession(key: string) {
    this.pageContexts.delete(key);
    this.currentAttachments.delete(key);
  }

  // ── Page memory (persistent) ────────────────────────────────────
  async loadPageMemory(userId: string): Promise<Record<string, any>> {
    const filePath = this.workspace.getUserFilePath(userId, 'page_memory.json');
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async savePageMemory(userId: string, memory: Record<string, any>) {
    const filePath = this.workspace.getUserFilePath(userId, 'page_memory.json');
    await fs.writeFile(filePath, JSON.stringify(memory, null, 2), 'utf-8');
  }
}
