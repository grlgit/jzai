import { SkillToolProvider } from './skill.tools';
import { createUserPrincipal } from '../../platform/app-store/runtime/invocation-principal';

const mockSkillRegistry = {
  getAll: () => [{ name: 'test', description: 'Test skill', confirmForm: [] }],
  getKnowledgeDomains: () => [],
  getInstructions: () => '',
  loadAll: () => {},
};
const mockSkillExecutor = { execute: jest.fn().mockResolvedValue({ success: true, message: 'ok' }) };
const mockToolRegistry = { getAll: () => [], loadAll: () => {} };
const mockMcpRegistry = { getAll: () => [], loadAll: () => {} };
const mockAgentPool = { keys: () => [], clear: () => {}, getSessionId: () => null };
const mockSession = { bindSkill: jest.fn() };
const mockConfirm = { requestConfirmation: jest.fn() };

const mockType = {
  Object: (p: any) => p, String: (o?: any) => 'string', Optional: (t: any) => t,
  Number: () => 'number', Boolean: () => 'boolean', Any: () => 'any',
  Record: (k: any, v: any) => 'record', Array: (t: any) => 'array',
};

describe('SkillToolProvider', () => {
  const provider = new SkillToolProvider(
    mockSkillRegistry as any, mockSkillExecutor as any, mockToolRegistry as any,
    mockMcpRegistry as any, mockAgentPool as any, mockSession as any, mockConfirm as any,
  );

  beforeEach(() => {
    mockSkillExecutor.execute.mockClear();
  });

  test('toolIds has 5 entries', () => {
    expect(provider.toolIds).toHaveLength(5);
  });

  test('getCatalog returns 5 entries', () => {
    expect(provider.getCatalog()).toHaveLength(5);
  });

  test('createTools returns skills + 4 utility tools', async () => {
    const tools = await provider.createTools({ piAi: { Type: mockType } });
    const names = tools.map(t => t.name);
    // 1 skill (skill_test) + test_skill + reload_skills + skill_workshop + taskflow = 5
    expect(names).toContain('skill_test');
    expect(names).toContain('test_skill');
    expect(names).toContain('reload_skills');
    expect(names).toContain('skill_workshop');
    expect(names).toContain('taskflow');
    expect(tools.length).toBe(5);
  });

  test('createTools returns empty when no piAi.Type', async () => {
    const tools = await provider.createTools({});
    expect(tools).toHaveLength(0);
  });

  test('passes the complete invocation principal to a nested skill execution', async () => {
    const principal = createUserPrincipal({
      id: 'user-1',
      role: { id: 'planner', permissions: ['cfg:model'] },
      departmentIds: ['operations'],
      tokenId: 'token-1',
      issuedAt: 1000,
      expiresAt: 9999999999999,
    }, 'agent:test');
    const tools = await provider.createTools({ piAi: { Type: mockType }, principal });
    const skill = tools.find(tool => tool.name === 'skill_test');

    await skill!.execute('call-1', { input: 'payload' });

    expect(mockSkillExecutor.execute).toHaveBeenCalledWith(
      'test',
      { input: 'payload' },
      principal,
    );
  });

  test('passes the complete invocation principal through test_skill', async () => {
    const principal = createUserPrincipal({
      id: 'user-1',
      role: { id: 'planner', permissions: ['cfg:model'] },
    }, 'agent:test');
    const tools = await provider.createTools({ piAi: { Type: mockType }, principal });
    const testSkill = tools.find(tool => tool.name === 'test_skill');

    await testSkill!.execute('call-1', { skillName: 'test', testParams: { value: 1 } });

    expect(mockSkillExecutor.execute).toHaveBeenCalledWith(
      'test',
      { value: 1 },
      principal,
    );
  });
});
