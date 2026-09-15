import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

export interface AppAsset {
  name: string;
  size: number;
  mimeType: string;
}

@Injectable()
export class AppAssetService {
  private readonly logger = new Logger(AppAssetService.name);

  /**
   * Resolve the absolute path of an asset within an installed app's directory.
   * Prevents path traversal by ensuring the resolved path stays inside installDir.
   */
  resolveAsset(installDir: string, assetPath: string): string | null {
    const resolved = path.resolve(installDir, assetPath);
    if (!resolved.startsWith(path.resolve(installDir) + path.sep)) {
      this.logger.warn(`Path traversal attempt: ${assetPath}`);
      return null;
    }
    return resolved;
  }

  listAssets(installDir: string, subDir = ''): AppAsset[] {
    const base = subDir ? path.join(installDir, subDir) : installDir;
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const full = path.join(base, e.name);
        const stat = fs.statSync(full);
        return { name: e.name, size: stat.size, mimeType: this.guessMime(e.name) };
      });
  }

  readAsset(installDir: string, assetPath: string): Buffer | null {
    const resolved = this.resolveAsset(installDir, assetPath);
    if (!resolved || !fs.existsSync(resolved)) return null;
    return fs.readFileSync(resolved);
  }

  /** MIME type for an asset path (extension-based). */
  mimeOf(assetPath: string): string {
    return this.guessMime(assetPath);
  }

  private guessMime(name: string): string {
    const ext = path.extname(name).toLowerCase();
    const map: Record<string, string> = {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.json': 'application/json',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
