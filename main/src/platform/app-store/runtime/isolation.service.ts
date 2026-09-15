import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppPoolService } from '../services/app-pool.service';
import { AppContext } from './app-context';

/**
 * v4 scope: file-path validation + AppContext creation only.
 * SQL-text prefix checking is intentionally removed — the DB SCHEMA/role boundary
 * is enforced by PostgreSQL itself (AppPoolService creates each app's dedicated role).
 */
@Injectable()
export class IsolationService {
  private readonly logger = new Logger(IsolationService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly pools: AppPoolService,
  ) {}

  /**
   * Resolve and validate a file path within an app's install directory.
   * Rejects path traversal, absolute paths, and symlinks pointing outside the root.
   */
  async validateFilePath(appId: string, requested: string): Promise<string> {
    const root = path.resolve(this.workspace.getRoot(), 'app-store', appId);
    const target = path.resolve(root, requested);

    if (!target.startsWith(root + path.sep)) {
      throw new ForbiddenException('路径越界');
    }

    try {
      const real = await fs.promises.realpath(target).catch(() => target);
      if (!real.startsWith(root + path.sep)) {
        throw new ForbiddenException('符号链接越界');
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // File does not exist — allowed (caller can decide)
    }

    return target;
  }

  /**
   * Create an AppContext bound to the app's own connection pool.
   * Note: config/llm are not wired here (no callers today); activation-time
   * construction in AppActivationService.loadBackend provides the full deps.
   */
  createAppContext(appId: string, userId?: string): AppContext {
    return new AppContext(appId, userId, { pools: this.pools, workspace: this.workspace });
  }
}
