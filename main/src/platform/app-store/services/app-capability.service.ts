import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { DbService } from '../../../db/db.service';
import { AppManifest } from '../validators/manifest.schema';

export type CapType = 'tool' | 'skill' | 'agent';

export interface AppSource {
  appId: string;
  name: string;
}

export interface ManifestCapabilities {
  tools: Array<{ id: string; group?: string }>;
  skills: Array<{ name: string }>;
  agents: Array<{ id: string }>;
}

/** 从 manifest 声明解析包内含的工具/技能/智能体清单（纯函数，供详情 API 使用） */
export function parseManifestCapabilities(manifest: AppManifest): ManifestCapabilities {
  const tools: ManifestCapabilities['tools'] = [];
  for (const tp of manifest.backend?.toolProviders ?? []) {
    for (const id of tp.toolIds ?? []) tools.push(tp.group ? { id, group: tp.group } : { id });
  }
  const skills = (manifest.skills ?? []).map(s => ({ name: path.basename(s.dir) }));
  const agents = (manifest.agents ?? []).map(a => ({
    id: path.basename(a.file).replace(/\.(yaml|yml)$/, ''),
  }));
  return { tools, skills, agents };
}

@Injectable()
export class AppCapabilityService {
  private readonly logger = new Logger(AppCapabilityService.name);

  constructor(private readonly db: DbService) {}

  /** 幂等重建某应用的能力映射（安装/升级/启动激活时调用） */
  async replaceForApp(
    appId: string,
    caps: { tools: string[]; skills: string[]; agents: string[] },
  ): Promise<void> {
    await this.db.query(`DELETE FROM jz_app_capabilities WHERE app_id = $1`, [appId]);
    const rows: Array<[string, CapType, string]> = [
      ...caps.tools.map(n => [appId, 'tool', n] as [string, CapType, string]),
      ...caps.skills.map(n => [appId, 'skill', n] as [string, CapType, string]),
      ...caps.agents.map(n => [appId, 'agent', n] as [string, CapType, string]),
    ];
    for (const row of rows) {
      await this.db.query(
        `INSERT INTO jz_app_capabilities (app_id, cap_type, cap_name)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        row,
      );
    }
  }

  async removeForApp(appId: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_app_capabilities WHERE app_id = $1`, [appId]);
  }

  /** cap_type → (cap_name → 来源应用) 映射，供各列表 API 打来源徽章 */
  async getSourceMap(): Promise<Map<CapType, Map<string, AppSource>>> {
    const { rows } = await this.db.query(
      `SELECT c.cap_type, c.cap_name, c.app_id, a.name
       FROM jz_app_capabilities c
       JOIN jz_installed_apps a USING (app_id)
       WHERE a.status = 'active'`,
    );
    const map = new Map<CapType, Map<string, AppSource>>();
    for (const row of rows) {
      const type = row.cap_type as CapType;
      if (!map.has(type)) map.set(type, new Map());
      const name =
        (row.name && typeof row.name === 'object' && (row.name.zh || row.name.en)) || row.app_id;
      map.get(type)!.set(row.cap_name, { appId: row.app_id, name });
    }
    return map;
  }
}
