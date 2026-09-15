import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'system.json');

@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceService.name);
  private root: string;

  constructor() {
    // Must initialize root in constructor (before other services' constructors run)
    this.root = this.loadRoot();
  }

  onModuleInit() {
    this.initWorkspace();
    this.logger.log(`Workspace root: ${this.root}`);
  }

  private loadRoot(): string {
    // Environment variable takes priority (for Docker deployment)
    const envRoot = process.env.WORKSPACE_ROOT;
    if (envRoot) return path.isAbsolute(envRoot) ? envRoot : path.resolve(process.cwd(), envRoot);

    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const raw = cfg.workspaceRoot || './workspace';
      return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    } catch {
      return path.join(process.cwd(), 'workspace');
    }
  }

  private initWorkspace() {
    const dirs = [
      this.root,
      path.join(this.root, 'config'),
      path.join(this.root, 'config', 'skills'),
      path.join(this.root, 'config', 'mcp'),
      path.join(this.root, 'config', 'tools'),
      this.getKnowledgeBaseDir(),
      path.join(this.getKnowledgeBaseDir(), 'wiki'),
      path.join(this.getKnowledgeBaseDir(), '.llmwiki'),
      path.join(this.getKnowledgeBaseDir(), '.llmwiki', 'cache'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Workspace root directory */
  getRoot(): string {
    return this.root;
  }

  /** Knowledge base workspace directory: {root}/knowledge_base/ */
  getKnowledgeBaseDir(): string {
    return path.join(this.root, 'knowledge_base');
  }

  /** Global config directory: {root}/config/ */
  getConfigDir(): string {
    return path.join(this.root, 'config');
  }

  /** Agents config directory (separate from workspace, in project config/) */
  getAgentsDir(): string {
    return path.join(process.cwd(), 'config', 'agents');
  }

  /** Models config file path */
  getModelsConfigPath(): string {
    return path.join(process.cwd(), 'config', 'models.json');
  }

  private validateUserId(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (safe !== userId || userId.includes('..')) {
      throw new Error(`Invalid userId: ${userId}`);
    }
    return safe;
  }

  /** User workspace directory: {root}/{userId}/ */
  getUserDir(userId: string): string {
    this.validateUserId(userId);
    const dir = path.join(this.root, userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** User uploads directory: {root}/{userId}/uploads/ */
  getUploadDir(userId: string): string {
    const dir = path.join(this.getUserDir(userId), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** User file path helper */
  getUserFilePath(userId: string, filename: string): string {
    return path.join(this.getUserDir(userId), filename);
  }

  /** User exports directory: {root}/{userId}/exports/ */
  getExportDir(userId: string): string {
    const dir = path.join(this.getUserDir(userId), 'exports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
