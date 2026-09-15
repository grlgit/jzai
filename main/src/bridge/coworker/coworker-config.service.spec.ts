import { Test, TestingModule } from '@nestjs/testing';
import { CoWorkerConfigService } from './coworker-config.service';
import { CoWorker } from './coworker.service';

describe('CoWorkerConfigService', () => {
  let service: CoWorkerConfigService;

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [CoWorkerConfigService],
    }).compile();
    service = mod.get(CoWorkerConfigService);
  });

  const baseCw: CoWorker = {
    id: 'cw-test',
    name: 't',
    description: '',
    avatarUrl: '',
    soul: '',
    modelLevel: 'auto',
    tools: [],
    skills: [],
    mcpServers: [],
    capabilities: { builtin: [], mcp: [], skills: [] },
    workScope: '',
    configOverrides: {},
    wechatConfig: {},
    kbBindings: [],
    status: 'active',
    createdBy: 'u',
    buildVersion: 1,
    configVersion: 1,
    lastBuildAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  const parse = (cw: CoWorker) => JSON.parse(service.generateConfigJson(cw, 'http://t:1111'));

  describe('人格指令下发', () => {
    it('soul 不写入 agents.defaults，改由 SOUL.md 下发', () => {
      const cw = { ...baseCw, soul: '  你是一名严谨的质检员  ' };
      const json = parse(cw);
      expect(json.agents.defaults.systemPromptOverride).toBeUndefined();
      expect(json.agents.defaults.systemPrompt).toBeUndefined();
      expect(service.generateSoulMarkdown(cw)).toBe('你是一名严谨的质检员');
    });

    it('soul 为空时 SOUL.md 内容为空', () => {
      const cw = { ...baseCw, soul: '   ' };
      const json = parse(cw);
      expect(json.agents.defaults.systemPromptOverride).toBeUndefined();
      expect(service.generateSoulMarkdown(cw)).toBe('');
    });
  });

  describe('plugins.allow 白名单', () => {
    it('下发配置含全量白名单,且不含企业微信残留', () => {
      const json = parse({ ...baseCw });
      expect(json.plugins.allow).toEqual([
        'openclaw-weixin',
        'jianzhi-bridge',
        'duckduckgo',
        'browser',
        'device-pair',
        'file-transfer',
        'memory-core',
        'phone-control',
        'talk-voice',
      ]);
      expect(json.plugins.allow).not.toContain('wecom-openclaw-plugin');
    });
  });

  describe('configOverrides sanitize', () => {
    const dirty = {
      agents: { defaults: { systemPrompt: 'x', systemPromptOverride: 'x' } },
      session: { idleResetMinutes: 30 },
      skills: { paths: ['/x'] },
      configLock: true,
      jianzhi: { foo: 1 },
      models: { providers: [{ id: 'a' }] }, // 数组非法
      gateway: { bind: '0.0.0.0' }, // 非法 bind
      mcp: { servers: { 'jianzhi-kb': { transport: 'http' } } }, // 非法 transport
    };

    it('剔除所有非法/废弃字段,模板自带正确值保留,产物对 strict schema 合规', () => {
      const json = parse({ ...baseCw, configOverrides: dirty });

      // 形状/枚举:模板值因 override 非法被忽略而保留
      expect(Array.isArray(json.models.providers)).toBe(false);
      expect(json.models.providers).toEqual(expect.any(Object));
      expect(json.gateway.bind).toBe('lan');
      expect(json.mcp.servers['jianzhi-kb'].transport).toBe('streamable-http');

      // 废弃键不在产物里
      expect(json.agents.defaults.systemPrompt).toBeUndefined();
      expect(json.agents.defaults.systemPromptOverride).toBeUndefined();
      expect(json.session.idleResetMinutes).toBeUndefined();
      expect(json.skills?.paths).toBeUndefined();
      expect(json.configLock).toBeUndefined();
      expect(json.jianzhi).toBeUndefined();
    });

    it('合法 override 保留生效', () => {
      const ok = { gateway: { bind: 'loopback' }, agents: { defaults: { maxConcurrent: 5 } } };
      const json = parse({ ...baseCw, configOverrides: ok });
      expect(json.gateway.bind).toBe('loopback');
      expect(json.agents.defaults.maxConcurrent).toBe(5);
    });

    it('sanitize 不修改入参(深拷贝)', () => {
      const input = { agents: { defaults: { systemPrompt: 'x' } }, gateway: { bind: '0.0.0.0' } };
      const snapshot = JSON.stringify(input);
      (service as any).sanitizeOverrides(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('干净 overrides 不触发告警,非法 overrides 触发 warn 日志', () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      warnSpy.mockClear();
      parse({ ...baseCw, configOverrides: { agents: { defaults: { maxConcurrent: 3 } } } });
      expect(warnSpy).not.toHaveBeenCalled();

      parse({ ...baseCw, configOverrides: dirty });
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/剔除非法\/废弃字段/);
      warnSpy.mockRestore();
    });
  });

  describe('capabilities → tools 派生', () => {
    const registry = {
      builtinIds: new Set(['read', 'write', 'exec']),
      hostIds: new Set(['export_excel', 'update_excel_cells', 'search_db_schema']),
      kbNames: new Set(['kb_search', 'kb_fetch']),
      skillNames: new Set(['报价', '排产']),
    };

    it('三个命名空间各自派生:内置裸 id,主台/知识库加 jianzhi_ 前缀', () => {
      const { tools, rejected } = service.deriveTools({
        builtin: ['read', 'write'],
        mcp: [
          { serverId: 'jianzhi-host', tools: ['export_excel', 'search_db_schema'] },
          { serverId: 'jianzhi-kb', tools: ['kb_search'] },
        ],
        skills: [],
      }, registry);

      expect(tools).toEqual(['jianzhi_export_excel', 'jianzhi_kb_search', 'jianzhi_search_db_schema', 'read', 'write']);
      expect(rejected).toEqual([]);
    });

    it('主台工具在 builtin 中也派生为 jianzhi_ 前缀（与内置工具混合）', () => {
      const { tools, rejected } = service.deriveTools({
        builtin: ['read', 'export_excel', 'search_db_schema'],
        mcp: [{ serverId: 'jianzhi-host', tools: ['mcp'] }],
        skills: [],
      }, { ...registry, hostIds: new Set([...registry.hostIds, 'mcp']) });

      expect(tools).toEqual(['jianzhi_export_excel', 'jianzhi_mcp', 'jianzhi_search_db_schema', 'read']);
      expect(rejected).toEqual([]);
    });

    it('server 条目 tools 为空表示该 server 全部工具,派生时显式展开', () => {
      const { tools } = service.deriveTools({
        builtin: [],
        mcp: [{ serverId: 'jianzhi-host', tools: [] }],
        skills: [],
      }, registry);

      expect(tools).toEqual(['jianzhi_export_excel', 'jianzhi_search_db_schema', 'jianzhi_update_excel_cells']);
      expect(tools.some(t => t.includes('*'))).toBe(false);
    });

    it('未知 id 与未知 serverId 进 rejected,不抛异常', () => {
      const { tools, rejected } = service.deriveTools({
        builtin: ['read', 'no_such_builtin'],
        mcp: [
          { serverId: 'jianzhi-host', tools: ['export_excel', 'no_such_host_tool'] },
          { serverId: 'some-other-server', tools: ['x'] },
        ],
        skills: ['报价', '不存在的技能'],
      }, registry);

      expect(tools).toEqual(['jianzhi_export_excel', 'read']);
      expect(rejected).toEqual([
        'no_such_builtin',
        'jianzhi-host/no_such_host_tool',
        'some-other-server/x',
        'skill/不存在的技能',
      ]);
    });

    it('MCP 注册表服务器派生 mcp_{server}_{tool} 工具名', () => {
      const mcpRegistry = {
        ...registry,
        mcpServerTools: new Map([
          ['erp', new Set(['get_orders', 'create_order'])],
          ['db-mysql', new Set(['query'])],
        ]),
      };

      const { tools, rejected } = service.deriveTools({
        builtin: ['read'],
        mcp: [
          { serverId: 'mcp-erp', tools: ['get_orders'] },
          { serverId: 'mcp-db-mysql', tools: [] },
          { serverId: 'mcp-unknown', tools: ['x'] },
        ],
        skills: [],
      }, mcpRegistry);

      expect(tools).toEqual(['mcp_db-mysql_query', 'mcp_erp_get_orders', 'read']);
      expect(rejected).toEqual(['mcp-unknown/x']);
    });

    it('skills 镜像到扁平列(coworker-build 遍历 cw.skills 构建镜像)', () => {
      const { skills } = service.deriveTools(
        { builtin: [], mcp: [], skills: ['排产', '报价'] },
        registry,
      );
      expect(skills).toEqual(['报价', '排产']);
    });

    it('capabilities 为空/缺省时派生出空列表,不抛异常', () => {
      expect(service.deriveTools(null, registry)).toEqual({ tools: [], skills: [], rejected: [] });
      expect(service.deriveTools({}, registry)).toEqual({ tools: [], skills: [], rejected: [] });
    });

    it('tools 为空时 buildToolPolicy 仍走默认安全预设', () => {
      const preset = (service as any).buildToolPolicy({ ...baseCw, tools: [] });
      expect(preset.allow).toContain('read');
      expect(preset.allow).toContain('web_search');
      expect(preset.allow).not.toContain('jianzhi_export_excel');
      expect(preset.allow).not.toContain('image');
      expect(preset.allow).toContain('jianzhi-kb__*');
      expect(preset.allow).toContain('jianzhi-host__*');

      // 非空 tools 时：管理员选的工具与必需内置工具合并去重，加上 MCP 通配
      const explicit = (service as any).buildToolPolicy({ ...baseCw, tools: ['read', 'jianzhi_export_excel'] });
      expect(explicit.allow).toContain('read');
      expect(explicit.allow).toContain('jianzhi_export_excel');
      expect(explicit.allow).toContain('write');
      expect(explicit.allow).toContain('exec');
      expect(explicit.allow).toContain('web_search');
      expect(explicit.allow).toContain('memory_search');
      expect(explicit.allow).toContain('jianzhi-kb__*');
      expect(explicit.allow).toContain('jianzhi-host__*');
      expect(explicit.allow).not.toContain('image');
    });
  });

  describe('存量 tools 反推 capabilities', () => {
    const registry = {
      builtinIds: new Set(['read', 'write']),
      hostIds: new Set(['export_excel', 'mcp']),
    };

    it('裸 id 归内置,MCP 归 jianzhi-host,其余主台名归 builtin,其余前缀名归 jianzhi-kb', () => {
      const cap = service.synthesizeCapabilities(
        ['read', 'jianzhi_mcp', 'jianzhi_export_excel', 'jianzhi_kb_search'],
        ['报价'],
        registry,
      );

      expect(cap.builtin).toEqual(['read']);
      expect(cap.mcp).toEqual([
        { serverId: 'jianzhi-host', serverName: '主台MCP连接', tools: ['mcp', 'export_excel'] },
        { serverId: 'jianzhi-kb', serverName: '见智知识库', tools: ['kb_search'] },
      ]);
      expect(cap.skills).toEqual(['报价']);
    });

    it('mcp_{server}_{tool} 反推为 mcp-{server} 条目', () => {
      const cap = service.synthesizeCapabilities(
        ['read', 'mcp_erp_get_orders', 'mcp_db-mysql_query', 'jianzhi_export_excel'],
        [],
        { ...registry, mcpServerTools: new Map([
          ['erp', new Set(['get_orders', 'create_order'])],
          ['db-mysql', new Set(['query'])],
        ]) },
      );

      expect(cap.builtin).toEqual(['read']);
      expect(cap.mcp).toContainEqual({ serverId: 'mcp-erp', serverName: 'erp', tools: ['get_orders'] });
      expect(cap.mcp).toContainEqual({ serverId: 'mcp-db-mysql', serverName: 'db-mysql', tools: ['query'] });
      expect(cap.mcp).toContainEqual({ serverId: 'jianzhi-host', serverName: '主台MCP连接', tools: ['export_excel'] });
    });
  });

  describe('能力目录', () => {
    it('MCP 工具进 mcp[jianzhi-host],其余主台工具进 builtin,email 分组归一为邮件', () => {
      const catalog = service.getCapabilityCatalog(
        [{ name: 'kb_search', description: 'kb' }],
        [],
        undefined,
        [
          { id: 'mcp', label: 'MCP Connectors', group: '连接' },
          { id: 'export_excel', label: '导出 Excel', group: '数据' },
          { id: 'email_send', label: '发送邮件', group: 'email' },
        ],
      );

      // MCP 工具在 mcp[jianzhi-host]
      expect(catalog.mcp.map(m => m.serverId)).toEqual(['jianzhi-host', 'jianzhi-kb']);
      expect(catalog.mcp[0].source).toBe('host');
      expect(catalog.mcp[0].tools).toEqual([{ name: 'mcp', description: '连接/MCP Connectors' }]);

      // 其余主台工具在 builtin 的「主台工具」分区
      const hostSection = catalog.builtin.find(s => s.section === '主台工具');
      expect(hostSection).toBeDefined();
      expect(hostSection!.tools).toEqual([
        { id: 'export_excel', label: '导出 Excel', description: '数据/导出 Excel' },
        { id: 'email_send', label: '发送邮件', description: '邮件/发送邮件' },
      ]);
    });
  });
});
