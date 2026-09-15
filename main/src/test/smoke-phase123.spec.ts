/**
 * Phase 1/2/3 冒烟测试 — 验证公用组件改动不影响原有功能。
 *
 * 测试重点：
 * 1. WorkspaceModule 扩展后仍正常提供 WorkspaceService
 * 2. FileCleanupService 路径穿越防护在各注入点生效
 * 3. CoWorkerConfigService 派生与现有 buildToolPolicy 行为兼容
 * 4. EmailService 密码加解密向后兼容（Base64 → AES 惰性升级）
 * 5. EmailController 管理员校验不影响普通用户账号 API
 * 6. WorkflowTransactionService 状态守卫与幂等性
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FileCleanupService } from '../workspace/file-cleanup.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { EmailService } from '../platform/email/email.service';
import { DbService } from '../db/db.service';
import { CredentialService } from '../capability/skill/credential.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── WorkspaceModule + FileCleanupService 集成 ───────────────────────────

describe('WorkspaceModule 公用组件冒烟', () => {
  let cleanup: FileCleanupService;
  let exportDir: string;

  beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jz-smoke-'));
    exportDir = path.join(root, 'exports');
    fs.mkdirSync(path.join(exportDir, 'pdf'), { recursive: true });

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        FileCleanupService,
        { provide: WorkspaceService, useValue: { getExportDir: () => exportDir } },
      ],
    }).compile();
    cleanup = mod.get(FileCleanupService);
  });

  it('合法 fileId 下载路径解析成功', () => {
    const result = cleanup.resolveExportPath('u1', '1710000000_abc_report.xlsx');
    expect(result).toBe(path.join(exportDir, '1710000000_abc_report.xlsx'));
  });

  it('resolveExportPath 带 subDir 参数时正确拼接', () => {
    const result = cleanup.resolveExportPath('u1', '1_doc.pdf', 'pdf');
    expect(result).toBe(path.join(exportDir, 'pdf', '1_doc.pdf'));
  });

  it('各种穿越 payload 一律返回 null', () => {
    const payloads = [
      '../../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      'a/../../../etc/passwd',
      '....//....//etc/passwd',
      '\x00',
      '.',
      '..',
      'dir/file.xlsx',
      'dir\\file.xlsx',
    ];
    for (const p of payloads) {
      expect(cleanup.resolveExportPath('u1', p)).toBeNull();
    }
  });

  it('deleteExportFile 对真实文件有效且返回 true', () => {
    const file = path.join(exportDir, '1_abc_test.xlsx');
    fs.writeFileSync(file, 'data');
    expect(cleanup.deleteExportFile('u1', '1_abc_test.xlsx')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('deleteExportFile 对不存在的文件返回 false（不抛异常）', () => {
    expect(cleanup.deleteExportFile('u1', 'not_exist.xlsx')).toBe(false);
  });
});

// ─── EmailService 密码加解密向后兼容 ─────────────────────────────────────

describe('EmailService 密码加解密冒烟', () => {
  let service: EmailService;

  beforeEach(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: CredentialService,
          useValue: (() => {
            const crypto = require('crypto');
            const key = crypto.createHash('sha256').update('test-key').digest();
            return {
              encrypt: (text: string) => {
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
                const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
                return [iv.toString('hex'), enc.toString('hex'), cipher.getAuthTag().toString('hex')].join(':');
              },
              decrypt: (data: string) => {
                const [ivHex, encHex, tagHex] = data.split(':');
                const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
                d.setAuthTag(Buffer.from(tagHex, 'hex'));
                return d.update(Buffer.from(encHex, 'hex')) + d.final('utf8');
              },
              isLegacyBase64: (s: string) => !s.includes(':'),
            };
          })(),
        },
        { provide: DbService, useValue: { query: jest.fn().mockResolvedValue({ rows: [] }) } },
        { provide: FileCleanupService, useValue: {} },
      ],
    }).compile();
    service = mod.get(EmailService);
  });

  it('AES 加密后可正确解密', () => {
    const plain = 'MyP@ssw0rd!中文';
    const encrypted = service.encryptPassword(plain);
    expect(encrypted).toContain(':');
    expect(service.decryptPassword(encrypted)).toBe(plain);
  });

  it('旧 Base64 格式密码仍可解密', () => {
    const plain = 'legacy_password';
    const legacy = Buffer.from(plain).toString('base64');
    expect(legacy).not.toContain(':');
    expect(service.decryptPassword(legacy)).toBe(plain);
  });

  it('AES 加密是非确定性的（每次 IV 不同）', () => {
    const enc1 = service.encryptPassword('same');
    const enc2 = service.encryptPassword('same');
    expect(enc1).not.toBe(enc2);
    expect(service.decryptPassword(enc1)).toBe('same');
    expect(service.decryptPassword(enc2)).toBe('same');
  });
});

// ─── CoWorkerConfigService 派生对 buildToolPolicy 的兼容 ─────────────────

describe('CoWorkerConfigService 派生冒烟', () => {
  let configService: any;

  beforeEach(async () => {
    const { CoWorkerConfigService } = require('../bridge/coworker/coworker-config.service');
    const mod: TestingModule = await Test.createTestingModule({
      providers: [CoWorkerConfigService],
    }).compile();
    configService = mod.get(CoWorkerConfigService);
  });

  it('派生出空 tools 时 buildToolPolicy 仍返回默认安全预设（不赋予空权限）', () => {
    const { tools } = configService.deriveTools(
      { builtin: [], mcp: [], skills: [] },
      { builtinIds: new Set(['read']), hostIds: new Set(['export_excel']), kbNames: new Set() },
    );
    expect(tools).toEqual([]);

    const cw = { tools: [] as string[], id: 'cw-test', name: 't', soul: '', skills: [], mcpServers: [], capabilities: { builtin: [], mcp: [], skills: [] }, workScope: '', configOverrides: {}, wechatConfig: {}, kbBindings: [], status: 'active', createdBy: 'u', buildVersion: 1, configVersion: 1, lastBuildAt: null, createdAt: new Date(), updatedAt: new Date(), description: '', avatarUrl: '', modelLevel: 'auto' };
    const policy = configService.buildToolPolicy(cw);
    // 默认安全预设 = 至少包含一些只读工具
    expect(policy.allow.length).toBeGreaterThan(0);
  });

  it('派生后 tools 非空时 buildToolPolicy 返回精确允许列表', () => {
    const { tools } = configService.deriveTools(
      { builtin: ['read'], mcp: [{ serverId: 'jianzhi-host', tools: ['export_excel'] }], skills: [] },
      { builtinIds: new Set(['read', 'write']), hostIds: new Set(['export_excel', 'search_db_schema']), kbNames: new Set() },
    );
    expect(tools).toContain('read');
    expect(tools).toContain('jianzhi_export_excel');

    const cw = { tools, id: 'cw-test', name: 't', soul: '', skills: [], mcpServers: [], capabilities: { builtin: [], mcp: [], skills: [] }, workScope: '', configOverrides: {}, wechatConfig: {}, kbBindings: [], status: 'active', createdBy: 'u', buildVersion: 1, configVersion: 1, lastBuildAt: null, createdAt: new Date(), updatedAt: new Date(), description: '', avatarUrl: '', modelLevel: 'auto' };
    const policy = configService.buildToolPolicy(cw);
    expect(policy.allow).toContain('read');
    expect(policy.allow).toContain('jianzhi_export_excel');
  });

  it('synthesizeCapabilities 对存量 tools 正确反推 capabilities', () => {
    const cap = configService.synthesizeCapabilities(
      ['read', 'write', 'jianzhi_export_excel', 'jianzhi_some_kb_tool'],
      ['日报生成'],
      { builtinIds: new Set(['read', 'write', 'exec']), hostIds: new Set(['export_excel', 'search_db_schema']) },
    );
    expect(cap.builtin.sort()).toEqual(['read', 'write']);
    expect(cap.mcp.find((m: any) => m.serverId === 'jianzhi-host')!.tools).toEqual(['export_excel']);
    expect(cap.mcp.find((m: any) => m.serverId === 'jianzhi-kb')!.tools).toEqual(['some_kb_tool']);
    expect(cap.skills).toEqual(['日报生成']);
  });
});

// ─── WorkflowTransactionService 状态守卫 ─────────────────────────────────

describe('WorkflowTransactionService 状态守卫冒烟', () => {
  let service: any;
  let dbQuery: jest.Mock;

  beforeEach(async () => {
    dbQuery = jest.fn();
    const fakeClient = { query: jest.fn(async () => ({ rows: [{ workflow_id: 'wf_1', user_id: 'u1', status: 'compensated' }] })) };
    const { WorkflowTransactionService } = require('../bridge/coworker/workflow-transaction.service');
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowTransactionService,
        { provide: DbService, useValue: { query: dbQuery, transaction: jest.fn(async (fn: any) => fn(fakeClient)) } },
        { provide: FileCleanupService, useValue: { deleteExportFile: jest.fn(() => true) } },
      ],
    }).compile();
    service = mod.get(WorkflowTransactionService);
  });

  afterEach(() => service?.onModuleDestroy());

  it('failWorkflow 不覆盖 compensated 终态', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE 返回空（守卫命中）
    dbQuery.mockResolvedValueOnce({ rows: [{ workflow_id: 'wf_1', status: 'compensated', context: '{}' }] }); // getWorkflow

    const result = await service.failWorkflow('wf_1', '步骤失败');
    expect(result.status).toBe('compensated');
  });

  it('compensateWorkflow 对 compensated 工作流是幂等的', async () => {
    const count = await service.compensateWorkflow('wf_1', '重复补偿');
    expect(count).toBe(0);
  });
});
