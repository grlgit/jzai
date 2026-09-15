import { Injectable, Logger } from '@nestjs/common';
import { HarAnalyzerService, AnalyzedWorkflow, WorkflowStep } from './har-analyzer.service';
import { SkillRegistryService, SkillDefinition } from './skill-registry.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import * as fs from 'fs';
import * as path from 'path';

export interface GenerationResult {
  success: boolean;
  message: string;
  skill?: SkillDefinition;
  workflow?: AnalyzedWorkflow;
  handlerCode?: string;
  error?: string;
}

@Injectable()
export class SkillGeneratorService {
  private readonly logger = new Logger(SkillGeneratorService.name);

  constructor(
    private readonly harAnalyzer: HarAnalyzerService,
    private readonly modelRouter: ModelRouterService,
    private readonly registry: SkillRegistryService,
  ) {}

  async generateFromHar(params: {
    harFile: Buffer;
    description: string;
    skillName: string;
    systemName: string;
    credentials?: { username: string; password: string };
  }): Promise<GenerationResult> {
    // 1. Parse HAR
    let harJson: any;
    try {
      harJson = JSON.parse(params.harFile.toString('utf-8'));
    } catch (err: any) {
      return { success: false, message: `HAR 文件解析失败: ${err.message}` };
    }

    // 2. Analyze workflow
    const workflow = this.harAnalyzer.analyze(harJson);
    this.logger.log(`Workflow: ${workflow.steps.length} steps, ${workflow.parameters.length} parameters`);

    if (workflow.steps.length === 0) {
      return { success: false, message: '未从 HAR 中识别出有效的工作流步骤' };
    }

    // Save workflow analysis
    const skillDir = path.join(process.cwd(), 'config', 'skills', params.skillName);
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'workflow.json'),
      JSON.stringify(workflow, null, 2),
      'utf-8',
    );

    // 3. Generate handler via LLM
    let handlerCode: string;
    try {
      handlerCode = await this.generateHandler(workflow, params.description, params.credentials);
    } catch (err: any) {
      this.logger.error(`LLM generation failed: ${err.message}`);
      return { success: false, message: `LLM 生成失败: ${err.message}`, workflow };
    }

    // 4. Build skill definition (Agent Skills standard)
    const agentDesc = this.buildAgentDescription(workflow, params.description);
    const paramsList = workflow.parameters.map(p => `- **${p.name}** (${p.type}${p.required ? ', 必填' : ''}): ${p.description}`).join('\n');
    const instructions = `## 工作流程\n\n${agentDesc}\n\n## 参数\n\n${paramsList}\n\n## API\n\n- 目标: ${workflow.submitStep?.api.url || workflow.baseUrl}\n- 方法: ${workflow.submitStep?.api.method || 'POST'}`;

    const skill: SkillDefinition = {
      name: params.skillName,
      description: `${params.systemName} - ${this.getWorkflowTitle(workflow)}`,
      instructions,
      metadata: { system: params.systemName, version: '1.0' },
      dirName: params.skillName,
      hasHandler: !!handlerCode,
      hasReferences: false,
      hasAssets: false,
    };

    // 5. Save
    this.registry.save(skill, handlerCode);
    this.logger.log(`Generated skill: ${params.skillName}`);

    return {
      success: true,
      message: `Skill "${params.skillName}" 生成成功，包含 ${workflow.steps.length} 个步骤、${workflow.parameters.length} 个参数`,
      skill,
      workflow,
      handlerCode,
    };
  }

  private async generateHandler(
    workflow: AnalyzedWorkflow,
    description: string,
    credentials?: { username: string; password: string },
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(workflow, description);

    this.logger.log(`Calling LLM for handler generation (prompt: ${userPrompt.length} chars)`);
    const response = await this.callLlm(systemPrompt, userPrompt);

    // Extract handler code from response
    const codeMatch = response.match(/```(?:typescript|javascript|ts|js)?\n([\s\S]*?)```/);
    if (!codeMatch) {
      this.logger.warn('No code block found in LLM response, using full response');
      return response;
    }
    return codeMatch[1].trim();
  }

  private buildSystemPrompt(): string {
    return `你是一个企业自动化系统(见智 JianZhi)的代码生成器。

你需要生成 handler.ts 文件，该文件在沙盒环境中执行多步骤 API 工作流。

## 执行环境

handler 中只有一个可用对象 ctx，包含：

- ctx.http: HTTP 客户端（自动维护 cookie，跨请求保持会话）
  - ctx.http.get(url, headers?)
  - ctx.http.post(url, body?, headers?)
  - ctx.http.put(url, body?, headers?)
  - ctx.http.request(method, url, body?, headers?)
  所有方法返回: { status: number, headers: Record<string,string>, data: any }
  body 参数：字符串(form-urlencoded) 或对象(JSON)
  默认 Content-Type 是 application/json，可通过 headers 参数覆盖

- ctx.params: Record<string, any> — 用户提供的参数
- ctx.credentials: { username: string, password: string } — 登录凭证

## 输出要求

handler 必须定义一个 async function execute(ctx) 函数，返回:
  { success: boolean, message: string, data?: any }

## 重要规则

1. 禁止使用 import、require、export 语句
2. form-urlencoded 请求，body 传字符串，设置 Content-Type header
3. 用正则匹配解析非标准 JSON 响应（单引号、无引号的 key）
4. 每个步骤都要检查错误，失败时 return { success: false, message: '...' }
5. 返回消息使用中文
6. 查询可能返回空结果时，包含条件逻辑（不存在则创建）
7. 把中间步骤的关键结果放在最终 data 字段中方便调试
8. 不要添加 TypeScript 类型注解（如 : string, : any, : Promise<>），只写纯 JavaScript`;
  }

  private buildUserPrompt(workflow: AnalyzedWorkflow, description: string): string {
    let prompt = `## 用户描述的操作过程\n${description}\n\n`;
    prompt += `## 基础 URL\n${workflow.baseUrl}\n\n`;
    prompt += `## 分析出的 API 工作流\n\n`;

    for (const step of workflow.steps) {
      prompt += `### ${step.id}: ${step.label} (${step.role})\n`;
      prompt += `API: ${step.api.method} ${step.api.path}\n`;
      prompt += `Content-Type: ${step.api.requestContentType || 'N/A'}\n`;

      const bodyStr = JSON.stringify(step.api.requestBody, null, 2);
      prompt += `请求 Body:\n\`\`\`json\n${bodyStr.substring(0, 800)}\n\`\`\`\n`;

      if (step.api.responseBody) {
        const respStr = typeof step.api.responseBody === 'string'
          ? step.api.responseBody
          : JSON.stringify(step.api.responseBody, null, 2);
        prompt += `响应样例:\n\`\`\`\n${respStr.substring(0, 500)}\n\`\`\`\n`;
      }

      if (step.dependsOn.length > 0) {
        prompt += `依赖: ${step.dependsOn.join(', ')}\n`;
      }
      if (step.inputMappings.length > 0) {
        const mappings = step.inputMappings.map(m => `${m.field} ← ${m.fromStep}.${m.fromField}`);
        prompt += `数据来源: ${mappings.join(', ')}\n`;
      }
      if (step.isConditional) {
        prompt += `⚠️ 条件执行: ${step.conditionDescription}\n`;
      }
      prompt += '\n';
    }

    prompt += `## 用户面向参数\n`;
    prompt += `以下参数由用户通过 ctx.params 传入:\n`;
    for (const p of workflow.parameters) {
      prompt += `- ${p.name} (${p.type}${p.required ? ', 必填' : ''}): ${p.description}`;
      if (p.sampleValue !== undefined) {
        prompt += ` — 样例值: ${JSON.stringify(p.sampleValue)}`;
      }
      prompt += '\n';
    }

    prompt += `\n## 任务\n`;
    prompt += `生成完整的 handler.ts，包含 async function execute(ctx) 函数。要求：\n`;
    prompt += `1. 按上述工作流步骤顺序执行所有 API 调用\n`;
    prompt += `2. 正确处理数据依赖（如从查询结果获取 dbId 传给后续步骤）\n`;
    prompt += `3. 处理条件步骤（查询为空则创建）\n`;
    prompt += `4. 用 ctx.params 中的用户参数构建请求 body\n`;
    prompt += `5. form-urlencoded 格式：body 为字符串，如 "key=" + encodeURIComponent(JSON.stringify(obj))\n`;
    prompt += `6. 每步检查 status 和 success 字段\n`;
    prompt += `7. 最终返回 { success, message, data: { 关键ID和结果 } }\n`;

    return prompt;
  }

  private async callLlm(systemPrompt: string, userPrompt: string): Promise<string> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);

    if (!apiKey && model.provider !== 'ollama') {
      throw new Error(`No API key for provider: ${model.provider}`);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 8192,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${text.substring(0, 500)}`);
    }

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM returned empty response');
    }

    this.logger.log(`LLM response: ${content.length} chars`);
    return content;
  }

  private getWorkflowTitle(workflow: AnalyzedWorkflow): string {
    const submitStep = workflow.submitStep;
    if (submitStep) return submitStep.label;
    return workflow.steps[workflow.steps.length - 1]?.label || '未知操作';
  }

  private buildAgentDescription(workflow: AnalyzedWorkflow, description: string): string {
    const paramList = workflow.parameters
      .filter(p => p.required)
      .map(p => p.description)
      .join('、');

    const stepList = workflow.steps
      .map(s => s.label)
      .join(' → ');

    return `${description}\n\n执行流程：${stepList}\n\n必填参数：${paramList || '无'}`;
  }
}
