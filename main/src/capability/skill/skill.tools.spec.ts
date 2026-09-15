import { SkillToolProvider } from './skill.tools';

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
});
