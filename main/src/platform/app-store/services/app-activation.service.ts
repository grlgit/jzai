import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AppManifest } from '../validators/manifest.schema';
import { AppRegistryService } from './app-registry.service';
import { AppPoolService } from './app-pool.service';
import { AppSchemaService } from './app-schema.service';
import { DynamicModuleLoader } from '../runtime/dynamic-module.loader';
import type { AppDeactivateReason } from '../runtime/dynamic-module.loader';
import { CompanionServiceManager } from '../runtime/companion-service.manager';
import { AppContext } from '../runtime/app-context';
import { createServicePrincipal } from '../runtime/invocation-principal';
import { DynamicToolProviderRegistry } from '../../../agent/tool-bridge/dynamic-tool-provider.registry';
import { AgentDelegationRegistry } from '../../../agent/core/agent-delegation.registry';
import { PanelMessageRegistry } from '../../../agent/panel/panel-message-registry.service';
import { PanelService } from '../../panel/panel.service';
import { AgentRegistryService } from '../../../agent/core/agent-registry.service';
import { SkillRegistryService } from '../../../capability/skill/skill-registry.service';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { ToolProvider } from '../../../agent/tool-bridge/tool-provider.interface';
import { AppCapabilityService } from './app-capability.service';
import { AppLogService } from './app-log.service';
import { AppPlatformService } from './app-platform.service';
import { AppConnectionBindingService } from './app-connection-binding.service';
import { AppCredentialService } from './app-credential.service';
import { ModelRouterService } from '../../../model-router/model-router.service';
import { ToolBridgeService } from '../../../agent/tool-bridge/tool-bridge.service';

export const APP_CONFIG_ARTIFACT_PERMISSION = 'APP_CONFIG_ARTIFACT_PERMISSION';

/**
 * Activates installed apps at runtime:
 * - registers app panels
 * - copies agents/skills into the workspace config
 * - reloads agent/skill registries
 * - loads backend modules and registers their tool providers
 */
@Injectable()
export class AppActivationService {
  private readonly logger = new Logger(AppActivationService.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly pools: AppPoolService,
    private readonly schema: AppSchemaService,
    private readonly loader: DynamicModuleLoader,
    private readonly skillRegistry: SkillRegistryService,
    private readonly workspace: WorkspaceService,
    private readonly capabilities: AppCapabilityService,
    private readonly logBuffer: AppLogService,
    private readonly appPlatform: AppPlatformService,
  ) {}

  /** Activate all apps marked active in the registry. Called once at startup. */
  async activateAll(): Promise<void> {
    const apps = await this.registry.findAll();
    for (const app of apps.filter(a => a.status === 'active')) {
      try {
        const installDir = await this.ensureVersionedLayout(app.appId, app.installDir || '', app.version);
        await this.activateApp(app.appId, installDir, app.manifest);
      } catch (err: any) {
        this.logger.error(`Failed to activate app ${app.appId}: ${err.message}`);
      }
    }
  }

  /**
   * 旧布局兼容迁移（PLAT-009）：早期安装为 app-store/<shortName> 单目录，
   * 现协议为 app-store/<shortName>/versions/<version>。启动时幂等搬移：
   * 整体 rename 到临时名 → 建 versions 父目录 → rename 到位 → 更新 extract_dir。
   * 已是版本目录布局（路径含 versions 段）或目录缺失时原样返回。
   */
  private async ensureVersionedLayout(appId: string, installDir: string, version: string): Promise<string> {
    if (!installDir || installDir.split(path.sep).includes('versions')) return installDir;
    if (!fs.existsSync(path.join(installDir, 'manifest.json'))) return installDir;

    const versionDir = path.join(installDir, 'versions', version);
    if (fs.existsSync(versionDir)) return versionDir; // 已迁移但 DB 未更新，直接采用

    const parent = path.dirname(installDir);
    const tmp = path.join(parent, `.layout-migrate-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.renameSync(installDir, tmp);
      fs.mkdirSync(path.join(installDir, 'versions'), { recursive: true });
      fs.renameSync(tmp, versionDir);
      await this.registry.updateManifest(appId, (await this.registry.findOne(appId))!.manifest, versionDir);
      this.logger.log(`Migrated app ${appId} install dir to versioned layout: ${versionDir}`);
      return versionDir;
    } catch (err: any) {
      // 搬移失败保底：尝试恢复原位，用旧路径激活
      this.logger.error(`Failed to migrate install dir layout for ${appId}: ${err.message}`);
      try {
        if (fs.existsSync(tmp) && !fs.existsSync(installDir)) fs.renameSync(tmp, installDir);
      } catch {}
      return installDir;
    }
  }

  /** Register panels/agents/skills and load backend for a single app. */
  async activateApp(appId: string, installDir: string, manifest: AppManifest): Promise<void> {
    await this.ensureDatabasePool(appId, manifest);
    await this.registerPanels(manifest, appId);
    await this.copyAgents(manifest, installDir);
    await this.copySkills(manifest, installDir);
    this.reloadRegistries();
    this.registerDelegations(manifest, appId);
    await this.recordCapabilities(appId, manifest);
    await this.loadBackend(appId, installDir, manifest);
  }

  /**
   * 把本应用注册的工具/技能/智能体写入 jz_app_capabilities（幂等重建），
   * 供 /api/tools、/api/skills、/api/agents 打"来源应用"徽章。
   * cap_name 与各列表 API 的条目标识严格对齐：
   * - tool：manifest 声明的 toolId
   * - skill：SKILL.md frontmatter name（按目录名反查，兜底目录名）
   * - agent：yaml id 或文件名去扩展（与 AgentRegistryService.loadAll 同规则）
   */
  private async recordCapabilities(appId: string, manifest: AppManifest): Promise<void> {
    try {
      const tools = (manifest.backend?.toolProviders ?? []).flatMap(tp => tp.toolIds ?? []);

      const loadedSkills = this.skillRegistry.getAll();
      const skills = (manifest.skills ?? []).map(skill => {
        const dirName = path.basename(skill.dir);
        return loadedSkills.find(s => s.dirName === dirName)?.name ?? dirName;
      });

      const agentsDir = this.workspace.getAgentsDir();
      const agents = (manifest.agents ?? []).map(agent => {
        const base = path.basename(agent.file);
        const fallback = base.replace(/\.ya?ml$/, '');
        try {
          const file = path.join(agentsDir, base);
          if (!fs.existsSync(file)) return fallback;
          const raw = yaml.load(fs.readFileSync(file, 'utf-8')) as any;
          const a = raw?.agent || raw;
          return a?.id || fallback;
        } catch {
          return fallback;
        }
      });

      await this.capabilities.replaceForApp(appId, { tools, skills, agents });
    } catch (err: any) {
      // 能力映射只影响列表徽章展示，不阻断激活
      this.logger.error(`Failed to record capabilities for app ${appId}: ${err.message}`);
    }
  }

  /**
   * 连接池是进程内存态：install 时建池，但进程重启后池消失，且 role 密码是
   * install 时随机生成、不落盘——重启后所有 AppContext.query 都会
   * "No connection pool"。这里在激活时幂等重建：重新生成随机密码并
   * ALTER ROLE（restoreSchemaAndRole 内部即此语义），再以新密码建池。
   * install/upgrade 路径已建池 → hasPool 短路，不会重复 ALTER。
   */
  private async ensureDatabasePool(appId: string, manifest: AppManifest): Promise<void> {
    if (!manifest.database || this.pools.hasPool(appId)) return;
    try {
      const rolePassword = crypto.randomBytes(32).toString('hex');
      await this.schema.restoreSchemaAndRole(manifest, rolePassword);
      const connection = this.getDatabaseConnection();
      await this.pools.createPool(appId, {
        ...connection,
        user: this.schema.getRoleName(manifest)!,
        password: rolePassword,
        max: manifest.database.poolMax ?? 3,
      });
      this.logger.log(`Rebuilt database pool for app ${appId} (role password rotated)`);
    } catch (err: any) {
      // 建池失败不阻断激活：无 DB 依赖的工具/面板仍可用，首次查询会再报错
      this.logger.error(`Failed to rebuild database pool for app ${appId}: ${err.message}`);
    }
  }

  private getDatabaseConnection(): { host: string; port: number; database: string } {
    const connectionUrl = process.env.DATABASE_URL;
    if (connectionUrl) {
      const connection = new URL(connectionUrl);
      return {
        host: connection.hostname,
        port: parseInt(connection.port || '5432'),
        database: connection.pathname.slice(1),
      };
    }
    return {
      host: process.env.PG_HOST ?? 'localhost',
      port: Number(process.env.PG_PORT ?? '5432'),
      database: process.env.PG_DATABASE ?? 'jianzhi',
    };
  }

  /**
   * Unload backend and unregister tools/panels for an app.
   * 先进入 draining（新调用被拒绝），等待 onDeactivate 排空后卸载。
   */
  async deactivateApp(appId: string, reason: AppDeactivateReason = 'uninstall'): Promise<void> {
    this.getToolRegistry()?.markDraining(appId);
    try {
      await this.loader.unload(appId, reason);
      this.getToolRegistry()?.unregister(appId);
      this.getDelegationRegistry()?.remove(appId);
    } finally {
      this.getToolRegistry()?.clearDraining(appId);
      // PLAT-016：回收伴随服务（升级路径由 deactivate→activate 次序自然覆盖：
      // 旧版本服务在此停止，新版本服务在随后的 activateApp 中拉起）。
      try {
        await this.getPlatformService(CompanionServiceManager)?.stopForApp(appId, reason);
      } catch (err: any) {
        this.logger.warn(`Failed to stop companion services for ${appId}: ${err.message}`);
      }
    }
  }

  /** APP 是否正在停用（draining）：invoke/tool 入口据此拒绝新调用 */
  isDraining(appId: string): boolean {
    return this.getToolRegistry()?.isDraining(appId) ?? false;
  }

  /**
   * Publish manifest-declared delegation rules so app agents can be routed to.
   * Without this the rules only live in the manifest and never reach the registry —
   * the static table in main.yaml stays the sole source of delegation.
   */
  registerDelegations(manifest: AppManifest, appId: string): void {
    const registry = this.getDelegationRegistry();
    if (!registry) return;

    registry.remove(appId); // 幂等：避免重复激活时规则叠加
    for (const entry of manifest.agentDelegation ?? []) {
      registry.register({
        fromAgent: entry.fromAgent ?? 'main',
        targetAgent: entry.targetAgent,
        keywords: entry.keywords,
        description: entry.description ?? `${manifest.name.zh}（扩展包）`,
        appId,
      });
    }
  }

  async registerPanels(manifest: AppManifest, appId: string): Promise<void> {
    const panelService = this.getPanelService();
    if (!panelService) return;
    for (const panel of manifest.panels ?? []) {
      await panelService.registerAppPanel(panel, appId);
      this.registerPanelMessageSchema(panel, appId);
    }
  }

  /**
   * 登记面板消息校验器（决策 9 的簿记侧）。
   * 真正的动态加载发生在前端（page.tsx 按 sidebar 返回的 messageSchema
   * 动态 import 校验器模块）；这里让 /api/panel/message-handlers 可见可审计。
   */
  private registerPanelMessageSchema(panel: { id: string; messageSchema?: string }, appId: string): void {
    if (!panel.messageSchema) return;
    this.getPanelMessageRegistry()?.register(panel.id, { appId, description: panel.messageSchema });
  }

  async removePanels(appId: string): Promise<void> {
    const panelService = this.getPanelService();
    await panelService?.removeAppPanels(appId);
    this.getPanelMessageRegistry()?.removeByApp(appId);
  }

  copyAgents(manifest: AppManifest, installDir: string): void {
    const agentsDir = this.workspace.getAgentsDir();
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const agent of manifest.agents ?? []) {
      const src = path.join(installDir, agent.file);
      const dest = path.join(agentsDir, path.basename(agent.file));
      if (fs.existsSync(src) && !this.isMacMetadata(path.basename(src))) {
        this.writeFileContent(src, dest);
      }
    }
  }

  removeAgents(manifest: AppManifest): string[] {
    const agentsDir = this.workspace.getAgentsDir();
    return (manifest.agents ?? []).flatMap(agent =>
      this.removeArtifact(path.join(agentsDir, path.basename(agent.file))),
    );
  }

  copySkills(manifest: AppManifest, installDir: string): void {
    const skillBaseDir = path.join(this.workspace.getConfigDir(), 'skills');
    for (const skill of manifest.skills ?? []) {
      const src = path.join(installDir, skill.dir);
      const dest = path.join(skillBaseDir, path.basename(skill.dir));
      if (fs.existsSync(src) && !this.isMacMetadata(path.basename(src))) {
        fs.rmSync(dest, { recursive: true, force: true });
        this.copyDirectory(src, dest);
      }
    }
  }

  removeSkills(manifest: AppManifest): string[] {
    const skillBaseDir = path.join(this.workspace.getConfigDir(), 'skills');
    return (manifest.skills ?? []).flatMap(skill =>
      this.removeArtifact(path.join(skillBaseDir, path.basename(skill.dir)), true),
    );
  }

  private removeArtifact(target: string, recursive = false): string[] {
    try {
      fs.rmSync(target, { recursive, force: true });
      return [];
    } catch (err: any) {
      const warning = `App configuration artifact remains at ${target}: ${err.message}`;
      this.logger.warn(warning);
      return [warning];
    }
  }

  private copyDirectory(source: string, destination: string): void {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (this.isMacMetadata(entry.name)) continue;
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        this.copyDirectory(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        this.writeFileContent(sourcePath, destinationPath);
      }
    }
  }

  private writeFileContent(source: string, destination: string): void {
    const destinationDir = path.dirname(destination);
    const content = fs.readFileSync(source);
    fs.mkdirSync(destinationDir, { recursive: true });

    let tempDir: string | undefined;
    try {
      tempDir = fs.mkdtempSync(path.join(destinationDir, '.app-artifact-'));
      const tempFile = path.join(tempDir, 'content');
      fs.writeFileSync(tempFile, content, { mode: 0o644 });
      fs.renameSync(tempFile, destination);
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        throw new Error(`${APP_CONFIG_ARTIFACT_PERMISSION}: ${destination}`);
      }
      throw err;
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  private isMacMetadata(fileName: string): boolean {
    return fileName.startsWith('._') || fileName === '.DS_Store';
  }

  reloadRegistries(): void {
    this.getAgentRegistry()?.loadAll();
    this.skillRegistry.loadAll();
  }

  private async loadBackend(appId: string, installDir: string, manifest: AppManifest): Promise<void> {
    if (!manifest.backend) return;
    const entry = path.join(installDir, manifest.backend.entry);
    if (!fs.existsSync(entry)) {
      throw new Error(`Backend entry not found for ${appId}: ${entry}`);
    }

    const record = await this.registry.findOne(appId);
    const toolBridge = this.getPlatformService(ToolBridgeService);
    const connectionBindings = this.getPlatformService(AppConnectionBindingService);
    // secret:// 引用在激活时解析为内存真值，仅存在于 APP backend 进程内存；
    // 引用失效（已删除/错误引用）时明确失败，不静默注入 null。
    const credentials = this.getPlatformService(AppCredentialService);
    const rawConfig = (record?.config ?? {}) as Record<string, unknown>;
    const config = credentials ? await credentials.resolveConfig(appId, rawConfig) : rawConfig;
    // PLAT-016：伴随服务拉起 + 健康门 + endpoint 运行时注入（不落库）。
    // 失败即激活失败——install 走清理路径；activateAll 记错误日志（与既有失败处理一致）。
    const companions = this.getPlatformService(CompanionServiceManager);
    if (companions && manifest.services?.length) {
      const injected = await companions.startForApp({
        appId,
        shortName: record?.shortName ?? manifest.shortName,
        version: manifest.version,
        installDir,
        services: manifest.services,
        resolvedConfig: config as Record<string, unknown>,
      });
      Object.assign(config, injected);
    }
    const servicePrincipal = createServicePrincipal(appId, 'runtime', ['platform:tools']);
    const ctx = new AppContext(appId, undefined, {
      pools: this.pools,
      config,
      workspace: this.workspace,
      shortName: record?.shortName ?? manifest.shortName,
      modelRouter: this.getPlatformService(ModelRouterService),
      logBuffer: this.logBuffer,
      usesPlatformTools: manifest.usesPlatformTools ?? [],
      toolExecutor: toolBridge
        ? (toolId, params) => toolBridge.callTool(toolId, params, servicePrincipal)
        : undefined,
      connections: connectionBindings?.createServiceClient(appId),
      platform: this.appPlatform.buildFacade(manifest),
    });
    const loaded = await this.loader.load(appId, entry, manifest.backend.module, ctx);
    const providers = ((loaded.moduleRef as any)?.toolProviders ?? []) as ToolProvider[];

    // manifest.backend.toolProviders[].tokenLimits 是声明式来源（决策 11），
    // 与 provider 类上的 tokenLimits getter 合并后一起写入注册表。
    const manifestTokenLimits: Record<string, number> = {};
    for (const tp of manifest.backend.toolProviders ?? []) {
      Object.assign(manifestTokenLimits, tp.tokenLimits ?? {});
    }

    this.getToolRegistry()?.register(appId, providers, manifestTokenLimits);
    this.registerSkillTokenLimits(manifest, appId);

    // 工具注册完成后再执行 onActivate（worker 恢复、lease 重建等异步初始化）
    const onActivate = (loaded.moduleRef as { onActivate?: () => void | Promise<void> })?.onActivate;
    if (typeof onActivate === 'function') {
      await onActivate.call(loaded.moduleRef);
    }
    this.logger.log(`Activated app ${appId} backend with ${providers.length} tool provider(s)`);
  }

  /**
   * Skill 工具（skill_<dir名>）由平台 SkillToolProvider 静态创建，不属于扩展包 provider，
   * 它们的输出截断上限只能经 manifest.skills[].tokenLimit 声明并在此写入注册表。
   * （同时把工具归属记到 appId，未授权用户调用技能时会被 ToolBridge 拦截。）
   */
  private registerSkillTokenLimits(manifest: AppManifest, appId: string): void {
    const limits: Record<string, number> = {};
    for (const skill of manifest.skills ?? []) {
      if (skill.tokenLimit) {
        limits[`skill_${path.basename(skill.dir)}`] = skill.tokenLimit;
      }
    }
    if (Object.keys(limits).length > 0) {
      this.getToolRegistry()?.registerTokenLimits(appId, limits);
    }
  }

  private getToolRegistry(): DynamicToolProviderRegistry | undefined {
    return this.getPlatformService(DynamicToolProviderRegistry);
  }

  private getPanelService(): PanelService | undefined {
    return this.getPlatformService(PanelService);
  }

  private getAgentRegistry(): AgentRegistryService | undefined {
    return this.getPlatformService(AgentRegistryService);
  }

  private getDelegationRegistry(): AgentDelegationRegistry | undefined {
    return this.getPlatformService(AgentDelegationRegistry);
  }

  private getPanelMessageRegistry(): PanelMessageRegistry | undefined {
    return this.getPlatformService(PanelMessageRegistry);
  }

  private getPlatformService<T>(cls: new (...args: any[]) => T): T | undefined {
    const app = (global as any).nestApp;
    if (!app) return undefined;
    try {
      return app.get(cls, { strict: false });
    } catch {
      return undefined;
    }
  }
}
