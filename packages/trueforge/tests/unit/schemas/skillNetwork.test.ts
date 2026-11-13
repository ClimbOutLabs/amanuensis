import type { ApiServiceDeclaration } from '@truefoundry/trueforge-core/core/connectors/apiServices';
import { SkillManifestSchema, effectiveSkillNetworkHosts, skillNetworkHostsCanSend } from '../../../src/schemas/skill';

const GIT_SKILL = {
  type: 'git' as const,
  name: 'ten-x',
  url: 'https://github.com/example/ten-x',
  ref: 'main',
  description: 'Works with GitHub from the sandbox.',
};

/** The worked example from the design: the ten-x skill's two GitHub hosts. */
const TEN_X_HOSTS = ['github.com', 'api.github.com'];

describe('the skill manifest network_hosts declaration', () => {
  it('accepts exact hosts and keeps them', () => {
    const parsed = SkillManifestSchema.parse({ ...GIT_SKILL, network_hosts: TEN_X_HOSTS });
    expect(parsed.type).toBe('git');
    if (parsed.type !== 'git') throw new Error('expected a git skill');
    expect(parsed.network_hosts).toEqual(TEN_X_HOSTS);
  });

  it('collapses duplicates', () => {
    const parsed = SkillManifestSchema.parse({
      ...GIT_SKILL,
      network_hosts: ['github.com', 'github.com', 'api.github.com'],
    });
    if (parsed.type !== 'git') throw new Error('expected a git skill');
    expect(parsed.network_hosts).toEqual(TEN_X_HOSTS);
  });

  it('a skill declaring nothing parses exactly as before, with no network_hosts', () => {
    const parsed = SkillManifestSchema.parse(GIT_SKILL);
    if (parsed.type !== 'git') throw new Error('expected a git skill');
    expect(parsed.network_hosts).toBeUndefined();
  });

  it.each([
    ['a wildcard', '*.github.com'],
    ['a scheme', 'https://github.com'],
    ['a port', 'github.com:443'],
    ['a path', 'github.com/repos'],
    ['an IPv4 address', '140.82.121.3'],
    ['an IPv6 address', '::1'],
    ['uppercase', 'GitHub.com'],
    ['a single label', 'localhost'],
    ['an empty label', 'github..com'],
    ['a trailing dot', 'github.com.'],
  ])('refuses %s', (_label, host) => {
    expect(SkillManifestSchema.safeParse({ ...GIT_SKILL, network_hosts: [host] }).success).toBe(false);
  });

  it('refuses more than twenty hosts', () => {
    const hosts = Array.from({ length: 21 }, (_, index) => `host-${String(index)}.example.com`);
    expect(SkillManifestSchema.safeParse({ ...GIT_SKILL, network_hosts: hosts }).success).toBe(false);
  });
});

describe('effectiveSkillNetworkHosts', () => {
  it('grants the declared list when the person approved exactly it', () => {
    expect(effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: TEN_X_HOSTS })).toEqual(TEN_X_HOSTS);
  });

  it('grants nothing when there is no approval', () => {
    expect(effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: null })).toBeNull();
  });

  it('shrinks on its own when a host is removed from the declaration', () => {
    expect(effectiveSkillNetworkHosts({ declared: ['github.com'], approved: TEN_X_HOSTS })).toEqual(['github.com']);
  });

  it('grants nothing when a host was added after the approval: the new full list needs its own approval', () => {
    expect(
      effectiveSkillNetworkHosts({ declared: [...TEN_X_HOSTS, 'uploads.github.com'], approved: TEN_X_HOSTS }),
    ).toBeNull();
  });

  it('grants nothing for a skill that declares no hosts, approved or not', () => {
    expect(effectiveSkillNetworkHosts({ declared: undefined, approved: TEN_X_HOSTS })).toBeNull();
    expect(effectiveSkillNetworkHosts({ declared: [], approved: [] })).toBeNull();
  });
});

describe('skillNetworkHostsCanSend', () => {
  it('is true for the mail and calendar sites', () => {
    expect(skillNetworkHostsCanSend(['gmail.googleapis.com'])).toBe(true);
    expect(skillNetworkHostsCanSend(['graph.microsoft.com'])).toBe(true);
    expect(skillNetworkHostsCanSend(['example.com', 'www.googleapis.com'])).toBe(true);
  });

  it('is false for read-shaped sites like the ten-x example', () => {
    expect(skillNetworkHostsCanSend(TEN_X_HOSTS)).toBe(false);
    expect(skillNetworkHostsCanSend([])).toBe(false);
  });

  /**
   * Invented services that exist nowhere else in the codebase. The warning has to follow the
   * service's own declaration, so a service Aman has never heard of is judged by what it
   * declares, never by its name appearing on a list.
   */
  const INVENTED_SEND_SERVICE: ApiServiceDeclaration = {
    service: 'Parchment Post',
    hosts: ['api.parchment-post.example'],
    can_send: true,
  };
  const INVENTED_READ_SERVICE: ApiServiceDeclaration = {
    service: 'Ledger Look',
    hosts: ['api.ledger-look.example'],
    can_send: false,
  };

  it('is true for an invented service that declares it can send', () => {
    expect(skillNetworkHostsCanSend(['api.parchment-post.example'], [INVENTED_SEND_SERVICE])).toBe(true);
  });

  it('is false for an invented service that declares it cannot send', () => {
    expect(skillNetworkHostsCanSend(['api.ledger-look.example'], [INVENTED_READ_SERVICE])).toBe(false);
  });

  it('is false for a site no service declares', () => {
    expect(skillNetworkHostsCanSend(['undeclared.example'], [INVENTED_SEND_SERVICE, INVENTED_READ_SERVICE])).toBe(
      false,
    );
  });
});
