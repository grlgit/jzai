import { Injectable, Logger } from '@nestjs/common';

export interface DelegationRule {
  /** Source agent that delegates (usually 'main') */
  fromAgent: string;
  /** Target agent to switch to */
  targetAgent: string;
  /** Human-readable description of when to delegate */
  description: string;
  /** Keywords that trigger delegation */
  keywords: string[];
  /** App that registered this rule; undefined for static/builtin rules */
  appId?: string;
  /** Lower sortOrder wins on conflict */
  sortOrder?: number;
}

/**
 * Registry for agent delegation rules.
 * L2: loads static rules from YAML at startup.
 * L3: extensions register dynamic rules via register()/remove().
 */
@Injectable()
export class AgentDelegationRegistry {
  private readonly logger = new Logger(AgentDelegationRegistry.name);
  private readonly rules: DelegationRule[] = [];

  register(rule: DelegationRule): void {
    // Conflict check: same fromAgent + same keywords from different apps
    for (const keyword of rule.keywords) {
      const conflict = this.rules.find(
        r =>
          r.fromAgent === rule.fromAgent &&
          r.appId !== rule.appId &&
          r.keywords.includes(keyword),
      );
      if (conflict) {
        this.logger.warn(
          `Delegation keyword conflict: "${keyword}" claimed by both app="${conflict.appId ?? 'builtin'}" and app="${rule.appId ?? 'builtin'}". ` +
            `Using earlier registration (sortOrder lower wins).`,
        );
        // Keep the existing rule if it has equal or lower sortOrder
        if ((conflict.sortOrder ?? 0) <= (rule.sortOrder ?? 0)) {
          continue; // skip this keyword in the new rule
        }
        // Remove conflicting rule
        const idx = this.rules.indexOf(conflict);
        if (idx >= 0) this.rules.splice(idx, 1);
      }
    }
    this.rules.push(rule);
  }

  remove(appId: string): void {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i].appId === appId) {
        this.rules.splice(i, 1);
      }
    }
  }

  /** Get all delegation rules for a given source agent */
  getForAgent(fromAgent: string): DelegationRule[] {
    return this.rules.filter(r => r.fromAgent === fromAgent);
  }

  /** Build the markdown delegation table for injection into system prompt */
  buildDelegationTable(fromAgent: string): string {
    const rules = this.getForAgent(fromAgent);
    if (rules.length === 0) return '';

    const rows = rules
      .map(r => `    | ${r.description} | ${r.targetAgent} | ${r.keywords.map(k => `"${k}"`).join('、')} |`)
      .join('\n');

    return (
      `    | 用户意图 | 目标智能体 | 识别关键词 |\n` +
      `    |---------|-----------|----------|\n` +
      rows
    );
  }
}
