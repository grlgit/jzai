jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, rmSync: jest.fn() };
});

import * as fs from 'fs';
import { AppActivationService } from './app-activation.service';

describe('AppActivationService artifact cleanup', () => {
  let service: AppActivationService;
  let rmSync: jest.Mock;

  beforeEach(() => {
    rmSync = fs.rmSync as unknown as jest.Mock;
    rmSync.mockReset();
    rmSync.mockImplementation((target: string) => {
      if (target.endsWith('blocked.yaml') || target.endsWith('blocked-skill')) {
        throw new Error('EACCES: permission denied, lstat');
      }
    });
    service = new AppActivationService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { loadAll: jest.fn() } as any,
      {
        getAgentsDir: jest.fn().mockReturnValue('/app/main/config/agents'),
        getConfigDir: jest.fn().mockReturnValue('/workspace/config'),
      } as any,
      { replaceForApp: jest.fn(), removeForApp: jest.fn() } as any,
      { append: jest.fn(), read: jest.fn().mockReturnValue([]) } as any,
      { buildFacade: jest.fn().mockReturnValue(undefined) } as any,
    );
  });

  it('returns warnings and continues removing other configuration artifacts', () => {
    const agentWarnings = service.removeAgents({
      agents: [{ file: 'blocked.yaml' }, { file: 'removable.yaml' }],
    } as any);
    const skillWarnings = service.removeSkills({
      skills: [{ dir: 'blocked-skill' }, { dir: 'removable-skill' }],
    } as any);

    expect(agentWarnings).toHaveLength(1);
    expect(agentWarnings[0]).toContain('/app/main/config/agents/blocked.yaml');
    expect(skillWarnings).toHaveLength(1);
    expect(skillWarnings[0]).toContain('/workspace/config/skills/blocked-skill');
    expect(rmSync).toHaveBeenCalledWith('/app/main/config/agents/blocked.yaml', { recursive: false, force: true });
    expect(rmSync).toHaveBeenCalledWith('/app/main/config/agents/removable.yaml', { recursive: false, force: true });
    expect(rmSync).toHaveBeenCalledWith('/workspace/config/skills/blocked-skill', { recursive: true, force: true });
    expect(rmSync).toHaveBeenCalledWith('/workspace/config/skills/removable-skill', { recursive: true, force: true });
  });
});
