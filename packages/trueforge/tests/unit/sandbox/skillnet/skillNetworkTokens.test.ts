import { SkillNetworkTokenRegistry } from '../../../../src/sandbox/skillnet/skillNetworkTokens';

const INPUT = { tenant_id: 't', created_by: 'o', session_id: 's' };

describe('SkillNetworkTokenRegistry', () => {
  it('issues a token of the grant shape and resolves it with its hosts', () => {
    const registry = new SkillNetworkTokenRegistry();
    const token = registry.issue({ ...INPUT, hosts: ['github.com', 'api.github.com'] });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(registry.resolve(token)).toMatchObject({
      tenant_id: 't',
      created_by: 'o',
      session_id: 's',
      hosts: ['github.com', 'api.github.com'],
    });
  });

  it('returns the same token for the same chat and list, so parallel commands share one grant', () => {
    const registry = new SkillNetworkTokenRegistry();
    const first = registry.issue({ ...INPUT, hosts: ['github.com', 'api.github.com'] });
    expect(registry.issue({ ...INPUT, hosts: ['api.github.com', 'github.com'] })).toBe(first);
  });

  it('issuing for a changed list replaces the chat grant: the old token stops resolving', () => {
    const registry = new SkillNetworkTokenRegistry();
    const wide = registry.issue({ ...INPUT, hosts: ['github.com', 'api.github.com'] });
    const narrow = registry.issue({ ...INPUT, hosts: ['github.com'] });
    expect(narrow).not.toBe(wide);
    expect(registry.resolve(wide)).toBeUndefined();
    expect(registry.resolve(narrow)).toMatchObject({ hosts: ['github.com'] });
  });

  it('revoking the session ends every grant it held', () => {
    const registry = new SkillNetworkTokenRegistry();
    const token = registry.issue({ ...INPUT, hosts: ['github.com'] });
    registry.revokeSession('s');
    expect(registry.resolve(token)).toBeUndefined();
  });

  it('an unknown token resolves to nothing', () => {
    const registry = new SkillNetworkTokenRegistry();
    expect(registry.resolve('f'.repeat(32))).toBeUndefined();
  });
});
