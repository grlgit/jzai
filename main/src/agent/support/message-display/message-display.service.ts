import { Injectable } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AgentRegistryService } from '../../core/agent-registry.service';

export interface MessageDisplayConfig {
  toolProcess: boolean;
  toolResult: boolean;
  sourceRef: boolean;
  modelUsage: boolean;
}

const ALL_KEYS = ['toolProcess', 'toolResult', 'sourceRef', 'modelUsage'] as const;

@Injectable()
export class MessageDisplayService {
  constructor(
    private readonly db: DbService,
    private readonly agentRegistry: AgentRegistryService,
  ) {}

  async getGlobal(): Promise<MessageDisplayConfig> {
    const { rows } = await this.db.query('SELECT key, enabled FROM jz_message_display_global');
    const cfg: any = { toolProcess: true, toolResult: true, sourceRef: true, modelUsage: false };
    for (const r of rows) cfg[r.key] = r.enabled;
    return cfg;
  }

  async setGlobal(config: Partial<MessageDisplayConfig>) {
    for (const [key, enabled] of Object.entries(config)) {
      if (ALL_KEYS.includes(key as any)) {
        await this.db.query(
          'INSERT INTO jz_message_display_global (key, enabled) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET enabled = $2',
          [key, enabled],
        );
      }
    }
  }

  async getAgentConfigs(): Promise<Record<string, Partial<MessageDisplayConfig>>> {
    const agents = this.agentRegistry.getAll();
    const result: Record<string, Partial<MessageDisplayConfig>> = {};
    for (const a of agents) {
      if (a.messageDisplay) result[a.id] = a.messageDisplay;
    }
    return result;
  }

  async getUserConfig(userId: string): Promise<Record<string, Partial<MessageDisplayConfig>>> {
    const { rows } = await this.db.query(
      'SELECT agent_id, key, enabled FROM jz_message_display_user WHERE user_id = $1',
      [userId],
    );
    const result: Record<string, Partial<MessageDisplayConfig>> = {};
    for (const r of rows) {
      if (!result[r.agent_id]) result[r.agent_id] = {};
      (result[r.agent_id] as any)[r.key] = r.enabled;
    }
    return result;
  }

  async setUserConfig(userId: string, agentId: string, config: Partial<MessageDisplayConfig>) {
    // Delete existing for this user+agent, re-insert
    await this.db.query(
      'DELETE FROM jz_message_display_user WHERE user_id = $1 AND agent_id = $2',
      [userId, agentId],
    );
    for (const [key, enabled] of Object.entries(config)) {
      if (ALL_KEYS.includes(key as any)) {
        await this.db.query(
          'INSERT INTO jz_message_display_user (user_id, agent_id, key, enabled) VALUES ($1, $2, $3, $4)',
          [userId, agentId, key, enabled],
        );
      }
    }
  }

  /** Get full config for a user: global + all agents + user overrides */
  async getFullConfig(userId: string) {
    const [global, agents, user] = await Promise.all([
      this.getGlobal(),
      this.getAgentConfigs(),
      this.getUserConfig(userId),
    ]);
    return { global, agents, user };
  }
}
