import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Model } from '../pi';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../workspace/workspace.service';
import { EditionService } from '../edition/edition.service';

// Preset cloud provider configs (defaults, can be overridden)
const PRESET_PROVIDERS: Record<string, { id: string; name: string; baseUrl: string; modelsPath: string; isPreset: boolean }> = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelsPath: '/models', isPreset: true },
  openai: { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', modelsPath: '/v1/models', isPreset: true },
  anthropic: { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', modelsPath: '/v1/models', isPreset: true },
  'silicon-flow': { id: 'silicon-flow', name: 'SiliconFlow (硅基流动)', baseUrl: 'https://api.siliconflow.cn', modelsPath: '/v1/models', isPreset: true },
  moonshot: { id: 'moonshot', name: 'Moonshot (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', modelsPath: '/models', isPreset: true },
  qwen: { id: 'qwen', name: 'Qwen (通义千问)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', modelsPath: '/v1/models', isPreset: true },
  // GLM (智谱 Z.AI) - 支持 glm-4, glm-5 等模型
  zai: { id: 'zai', name: 'Z.AI (智谱)', baseUrl: 'https://api.z.ai/api/paas/v4', modelsPath: '/models', isPreset: true },
  // OpenRouter - 统一访问 KIMI、Claude、GPT 等多种模型
  openrouter: { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelsPath: '/models', isPreset: true },
};

// Provider config interface
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelsPath: string;
  isPreset: boolean;
}

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  // Runtime config (mutable, updated via API)
  private localEndpoint: string;
  private localModel: string;
  private cloudProvider: string;
  private cloudModel: string;
  private visionModel: string = ''; // 视觉模型（可选，为空时回退到 cloudModel）
  private cloudApiKey: string;
  private cloudSource: 'self' | 'official' = 'self'; // self=自购云端, official=官方云端
  private monthlyLimit: number;
  private overLimitAction: string;
  private maxContextCharsOverride: number | null = null; // Manual override from config; null = auto from model
  private monthlySpend = 0;

  // Provider configs (mutable, starts with presets)
  private providers: Map<string, ProviderConfig>;

  // Change listeners
  private listeners: Array<() => void> = [];

  constructor(
    private readonly config: ConfigService,
    private readonly workspace: WorkspaceService,
    @Optional() @Inject(forwardRef(() => EditionService)) private readonly edition?: EditionService,
  ) {
    // Initialize providers with presets
    this.providers = new Map(Object.entries(PRESET_PROVIDERS));

    // Defaults from .env
    this.localEndpoint = this.config.get('OLLAMA_ENDPOINT', 'http://localhost:11434');
    this.localModel = this.config.get('LOCAL_MODEL', 'qwen3:4b');
    this.cloudProvider = this.config.get('CLOUD_PROVIDER', 'deepseek');
    this.cloudModel = this.config.get('CLOUD_MODEL', 'deepseek-chat');
    this.cloudApiKey = this.config.get('CLOUD_API_KEY', '');
    this.monthlyLimit = Number(this.config.get('MODEL_BUDGET_LIMIT', '500'));
    this.overLimitAction = 'local_only';

    // Override with persisted config file if exists
    this.loadFromFile();
    this.loadPersistedSpend();

    // Default cloudSource: if no self-purchased API key, use official proxy
    if (!this.cloudApiKey && this.cloudSource === 'self') {
      this.cloudSource = 'official';
    }
  }

  private loadFromFile() {
    try {
      if (fs.existsSync(this.workspace.getModelsConfigPath())) {
        const data = JSON.parse(fs.readFileSync(this.workspace.getModelsConfigPath(), 'utf-8'));
        if (data.localEndpoint) this.localEndpoint = data.localEndpoint;
        if (data.localModel) this.localModel = data.localModel;
        if (data.cloudProvider) this.cloudProvider = data.cloudProvider;
        if (data.cloudModel) this.cloudModel = data.cloudModel;
        if (data.cloudApiKey) this.cloudApiKey = data.cloudApiKey;
        // 兼容历史配置：已废弃的 claude-local 来源回退到官方云端
        if (data.cloudSource) this.cloudSource = data.cloudSource === 'claude-local' ? 'official' : data.cloudSource;
        if (data.budgetLimit !== undefined) this.monthlyLimit = data.budgetLimit;
        if (data.overLimitAction) this.overLimitAction = data.overLimitAction;
        if (data.maxContextChars !== undefined) this.maxContextCharsOverride = data.maxContextChars;
        if (data.visionModel !== undefined) this.visionModel = data.visionModel;

        // Load custom providers
        if (data.providers) {
          // Start with presets
          this.providers = new Map(Object.entries(PRESET_PROVIDERS));
          // Merge with saved providers (allows editing presets and adding custom)
          for (const [id, cfg] of Object.entries(data.providers)) {
            const providerCfg = cfg as Partial<ProviderConfig>;
            this.providers.set(id, { ...providerCfg, id, isPreset: PRESET_PROVIDERS[id]?.isPreset || false } as ProviderConfig);
          }
        }

        this.logger.log(`Config loaded from ${this.workspace.getModelsConfigPath()}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to load config file: ${err.message}`);
    }
  }

  private saveToFile() {
    try {
      const dir = path.dirname(this.workspace.getModelsConfigPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.workspace.getModelsConfigPath(), JSON.stringify({
        localEndpoint: this.localEndpoint,
        localModel: this.localModel,
        cloudProvider: this.cloudProvider,
        cloudModel: this.cloudModel,
        visionModel: this.visionModel,
        cloudApiKey: this.cloudApiKey,
        cloudSource: this.cloudSource,
        budgetLimit: this.monthlyLimit,
        overLimitAction: this.overLimitAction,
        maxContextChars: this.maxContextCharsOverride,
        // Save all providers (including edited presets and custom ones)
        providers: Object.fromEntries(this.providers.entries()),
      }, null, 2));
      this.logger.log(`Config saved to ${this.workspace.getModelsConfigPath()}`);
    } catch (err: any) {
      this.logger.error(`Failed to save config: ${err.message}`);
    }
  }

  /**
   * Subscribe to config changes (AgentService uses this to update model)
   */
  /**
   * Dynamic context budget: derived from the active model's context window.
   * Uses ~30% of model's token-based context window (1 token ≈ 3.5 chars for CJK/mixed).
   * Manual override from models_config.json takes priority.
   * Minimum 80K, maximum 400K to prevent both starvation and runaway.
   */
  getMaxContextChars(): number {
    if (this.maxContextCharsOverride) return this.maxContextCharsOverride;
    const model = this.resolveModel();
    // contextWindow is in tokens; assume ~3.5 chars/token for CJK-heavy content
    // Use 30% of available window to leave room for system prompt + response generation
    const derived = Math.round(model.contextWindow * 3.5 * 0.3);
    // 提升上限到1M字符，充分利用模型上下文窗口能力（约30%的1M tokens）
    return Math.max(80000, Math.min(1000000, derived));
  }

  onConfigChange(fn: () => void) {
    this.listeners.push(fn);
  }

  /**
   * Get current config (for frontend)
   */
  getConfig() {
    return {
      localEndpoint: this.localEndpoint,
      localModel: this.localModel,
      cloudProvider: this.cloudProvider,
      cloudModel: this.cloudModel,
      visionModel: this.visionModel,
      cloudApiKey: this.cloudApiKey ? '***' + this.cloudApiKey.slice(-4) : '',
      hasCloudKey: !!this.cloudApiKey,
      cloudSource: this.cloudSource,
      budgetLimit: this.monthlyLimit,
      budgetSpent: this.monthlySpend,
      overLimitAction: this.overLimitAction,
      maxContextChars: this.getMaxContextChars(),
      maxContextCharsAuto: !this.maxContextCharsOverride,
      // Include providers for frontend management
      providers: Array.from(this.providers.values()).map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        modelsPath: p.modelsPath,
        isPreset: p.isPreset,
      })),
    };
  }

  /**
   * Update config from frontend
   */
  updateConfig(update: Partial<{
    localEndpoint: string; localModel: string;
    cloudProvider: string; cloudModel: string; cloudApiKey: string;
    visionModel: string;
    cloudSource: 'self' | 'official';
    budgetLimit: number; overLimitAction: string;
    providers?: Record<string, ProviderConfig>;
  }>) {
    if (update.localEndpoint !== undefined) this.localEndpoint = update.localEndpoint;
    if (update.localModel !== undefined) this.localModel = update.localModel;
    if (update.cloudProvider !== undefined) this.cloudProvider = update.cloudProvider;
    if (update.cloudModel !== undefined) this.cloudModel = update.cloudModel;
    if (update.visionModel !== undefined) this.visionModel = update.visionModel;
    if (update.cloudApiKey) this.cloudApiKey = update.cloudApiKey;
    if (update.cloudSource !== undefined) this.cloudSource = update.cloudSource;
    if (update.budgetLimit !== undefined) this.monthlyLimit = update.budgetLimit;
    if (update.overLimitAction !== undefined) this.overLimitAction = update.overLimitAction;
    if ((update as any).maxContextChars !== undefined) this.maxContextCharsOverride = (update as any).maxContextChars || null;

    // Update providers if provided
    if (update.providers) {
      for (const [id, cfg] of Object.entries(update.providers)) {
        const isPreset = PRESET_PROVIDERS[id]?.isPreset || false;
        this.providers.set(id, { ...cfg, id, isPreset });
      }
    }

    // Persist to file
    this.saveToFile();

    this.logger.log(`Config updated: local=${this.localModel}@${this.localEndpoint}, cloud=${this.cloudProvider}/${this.cloudModel}`);

    // Notify listeners (AgentService will recreate agents with new model)
    this.listeners.forEach(fn => fn());
  }

  /**
   * Get all providers
   */
  getProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get a single provider by ID
   */
  getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  /**
   * Add or update a provider
   */
  upsertProvider(provider: Omit<ProviderConfig, 'isPreset'>): ProviderConfig {
    const isPreset = PRESET_PROVIDERS[provider.id]?.isPreset || false;
    const cfg: ProviderConfig = { ...provider, isPreset };
    this.providers.set(provider.id, cfg);
    this.saveToFile();
    this.logger.log(`Provider ${provider.id} updated`);
    return cfg;
  }

  /**
   * Delete a custom provider (preset providers cannot be deleted)
   */
  deleteProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    if (provider.isPreset) {
      this.logger.warn(`Cannot delete preset provider ${id}`);
      return false;
    }
    const deleted = this.providers.delete(id);
    if (deleted) {
      this.saveToFile();
      this.logger.log(`Provider ${id} deleted`);
    }
    return deleted;
  }

  /**
   * Reset a preset provider to its default config
   */
  resetProvider(id: string): ProviderConfig | null {
    const preset = PRESET_PROVIDERS[id];
    if (!preset) return null;
    this.providers.set(id, { ...preset });
    this.saveToFile();
    this.logger.log(`Provider ${id} reset to preset defaults`);
    return preset;
  }

  /**
   * Get the active API key for a provider
   */
  /**
   * Get user identity headers for community edition LLM proxy.
   * Returns null for professional edition.
   */
  /**
   * Get user identity headers when using official cloud proxy.
   * Works for both community edition and professional with official cloud source.
   */
  getCommunityUserHeaders(userId: string): Record<string, string> | null {
    if (!this.isUsingOfficialCloud()) return null;
    return {
      'X-User-Id': userId,
      'X-User-Name': userId,
    };
  }

  /**
   * Get the auth token for LLM requests.
   * - Official proxy: returns installationToken (jzi_*)
   * - Self-hosted cloud: returns cloud API key (sk-*)
   */
  getLlmAuthToken(provider: string): string | undefined {
    // Claude本地代理无需鉴权（"任意值均可"），返回哑值避免客户端缺 key 报错
    if (this.isUsingOfficialCloud()) {
      const proxy = this.edition?.getLlmProxyConfig();
      if (proxy) return proxy.installationToken;
    }
    if (provider === this.cloudProvider || provider === 'openai-completions') {
      return this.cloudApiKey || undefined;
    }
    return undefined;
  }

  /**
   * Discover available models from a provider.
   */
  async discoverModels(provider: string, endpoint?: string, apiKey?: string): Promise<DiscoveredModel[]> {
    try {
      if (provider === 'ollama') {
        return this.discoverOllama(endpoint || 'http://localhost:11434');
      }
      return this.discoverCloud(provider, apiKey);
    } catch (err: any) {
      this.logger.error(`Model discovery failed for ${provider}: ${err.message}`);
      return [];
    }
  }

  /**
   * Discover Ollama local models
   */
  private async discoverOllama(endpoint: string): Promise<DiscoveredModel[]> {
    const res = await fetch(`${endpoint}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m: any) => ({
      id: m.name || m.model,
      name: m.name || m.model,
      provider: 'ollama',
      type: 'local' as const,
      size: m.size ? `${(m.size / 1e9).toFixed(1)}GB` : undefined,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
    }));
  }

  /**
   * Discover cloud provider models via OpenAI-compatible /models endpoint
   */
  private async discoverCloud(provider: string, apiKey?: string): Promise<DiscoveredModel[]> {
    const key = apiKey || this.cloudApiKey;
    if (!key) return [];

    const cfg = this.providers.get(provider);
    if (!cfg) {
      return [{ id: 'unknown', name: `${provider} (未知提供商)`, provider, type: 'cloud' }];
    }

    const headers: Record<string, string> = { 'Authorization': `Bearer ${key}` };
    // Anthropic uses different header
    if (provider === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];
    }

    const res = await fetch(`${cfg.baseUrl}${cfg.modelsPath}`, { headers });
    if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
    const data = await res.json();

    const models = data.data || data.models || [];
    return models.map((m: any) => ({
      id: m.id,
      name: m.id,
      provider,
      type: 'cloud' as const,
      ownedBy: m.owned_by,
    }));
  }

  /**
   * Resolve the model to use based on current config and budget.
   */
 resolveModel(): Model<any> {
    // Community edition: always route through website proxy
    if (this.edition?.isCommunity()) {
      const proxy = this.edition.getLlmProxyConfig();
      if (proxy) return this.buildOfficialProxyModel(proxy);
      return this.buildLocalModel();
    }
    // Professional with "official" cloud source: also route through website proxy
    if (this.cloudSource === 'official') {
      const proxy = this.edition?.getLlmProxyConfig();
      if (proxy) return this.buildOfficialProxyModel(proxy);
    }
    // Professional with "self" cloud: use own API key
    if (this.cloudApiKey && this.cloudModel && this.monthlySpend < this.monthlyLimit) {
      return this.buildCloudModel();
    }
    return this.buildLocalModel();
  }

  /**
   * Resolve model by task level.
   * Level is encoded in the model id (jianzhi-<level>) so the website proxy
   * can look up the corresponding cloud model from its pricing config.
   * Levels: 'chat' | 'summary' | 'coding' | 'reasoning' | 'vision' | 'embedding'
   */
  resolveModelForLevel(level: string): Model<any> {
    // Normalize: 'default' → 'chat'
    const normalized = (!level || level === 'default') ? 'chat' : level;

    // Community/official: route through website proxy with level-aware model id
    if (this.edition?.isCommunity() || this.cloudSource === 'official') {
      const proxy = this.edition?.getLlmProxyConfig();
      if (proxy) {
        return this.buildOfficialProxyModel({ ...proxy, model: `jianzhi-${normalized}` });
      }
    }
    // Self-hosted cloud: vision level uses dedicated visionModel if configured
    if (normalized === 'vision' && this.cloudApiKey && (this.visionModel || this.cloudModel)) {
      return this.buildCloudModelWithId(this.visionModel || this.cloudModel);
    }
    // Self-hosted cloud: non-chat tasks force cloud model
    if (normalized !== 'chat' && normalized !== 'summary') {
      if (this.cloudApiKey && this.cloudModel) return this.buildCloudModel();
    }
    return this.resolveModel();
  }

  /**
   * Get vision model endpoint info for direct fetch calls (e.g. DrawingVisionService).
   * Returns null if no cloud API key is configured.
   */
  getVisionEndpointInfo(): { endpoint: string; apiKey: string; modelId: string } | null {
    if (!this.cloudApiKey) return null;
    const modelId = this.visionModel || this.cloudModel;
    if (!modelId) return null;
    const cfg = this.providers.get(this.cloudProvider);
    const baseUrl = cfg?.baseUrl || 'https://api.deepseek.com';
    const finalBaseUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v4') ? baseUrl : `${baseUrl}/v1`;
    return {
      endpoint: `${finalBaseUrl}/chat/completions`,
      apiKey: this.cloudApiKey,
      modelId,
    };
  }

  private buildCloudModelWithId(modelId: string): Model<any> {
    const cfg = this.providers.get(this.cloudProvider);
    const baseUrl = cfg?.baseUrl || '';
    const finalBaseUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v4') ? baseUrl : `${baseUrl}/v1`;
    return {
      id: modelId,
      name: `Cloud ${modelId}`,
      api: 'openai-completions',
      provider: this.cloudProvider,
      baseUrl: finalBaseUrl,
      reasoning: false,
      input: ['text', 'image'] as any,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 8192,
    };
  }

  /** Check if currently using official cloud proxy */
  isUsingOfficialCloud(): boolean {
    return this.edition?.isCommunity() || this.cloudSource === 'official';
  }

  private buildLocalModel(): Model<any> {
    return {
      id: this.localModel,
      name: `Local ${this.localModel}`,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: `${this.localEndpoint}/v1`,
      reasoning: false,
      input: ['text'] as any,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    };
  }

  private buildOfficialProxyModel(proxy: { baseUrl: string; installationToken: string; model: string }): Model<any> {
    return {
      id: proxy.model,
      name: '官方云端',
      api: 'openai-completions',
      provider: 'jianzhi-proxy',
      baseUrl: proxy.baseUrl,
      reasoning: false,
      input: ['text'] as any,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Costs tracked by website
      contextWindow: 1000000,
      maxTokens: 8192,
    };
  }

  private buildCloudModel(): Model<any> {
    const cfg = this.providers.get(this.cloudProvider);
    const baseUrl = cfg?.baseUrl || '';
    // 避免重复添加 /v1（moonshot, openrouter, zai 的 baseUrl 已包含版本路径）
    const finalBaseUrl = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v4') ? baseUrl : `${baseUrl}/v1`;
    return {
      id: this.cloudModel,
      name: `Cloud ${this.cloudModel}`,
      api: 'openai-completions',
      provider: this.cloudProvider,
      baseUrl: finalBaseUrl,
      reasoning: false,
      input: ['text'] as any,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 8192,
    };
  }

  recordCost(cost: number) {
    this.monthlySpend += cost;
    // Persist to config file (debounced — written every ~10 calls)
    if (Math.random() < 0.1) this.persistSpend();
  }

  private persistSpend() {
    try {
      const spendFile = path.join(path.dirname(this.workspace.getModelsConfigPath()), 'budget_spend.json');
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      let data: any = {};
      try { data = JSON.parse(fs.readFileSync(spendFile, 'utf-8')); } catch { /* new file */ }
      if (data.month !== month) { data = { month, spend: 0 }; } // monthly reset
      data.spend = this.monthlySpend;
      fs.writeFileSync(spendFile, JSON.stringify(data));
    } catch { /* non-critical */ }
  }

  private loadPersistedSpend() {
    try {
      const spendFile = path.join(path.dirname(this.workspace.getModelsConfigPath()), 'budget_spend.json');
      const data = JSON.parse(fs.readFileSync(spendFile, 'utf-8'));
      const month = new Date().toISOString().slice(0, 7);
      if (data.month === month) this.monthlySpend = data.spend || 0;
    } catch { /* no prior data */ }
  }

  getStats() {
    return {
      monthlySpend: this.monthlySpend,
      monthlyLimit: this.monthlyLimit,
      budgetUsedPercent: Math.round((this.monthlySpend / this.monthlyLimit) * 100),
    };
  }
}

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  type: 'local' | 'cloud';
  size?: string;
  parameterSize?: string;
  quantization?: string;
  ownedBy?: string;
}
