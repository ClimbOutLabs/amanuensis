import {
  SkillManifestSchema,
  effectiveSkillNetworkHosts,
  isSkillNetworkHostName,
  skillNetworkHostsCanSend,
} from '../../../src/schemas/skill';

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
    expect(effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: TEN_X_HOSTS, denied: [] })).toEqual(
      TEN_X_HOSTS,
    );
  });

  it('grants nothing when there is no approval', () => {
    expect(effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: null, denied: [] })).toBeNull();
  });

  it('shrinks on its own when a host is removed from the declaration', () => {
    expect(effectiveSkillNetworkHosts({ declared: ['github.com'], approved: TEN_X_HOSTS, denied: [] })).toEqual([
      'github.com',
    ]);
  });

  it('grants nothing when a host was added after the approval: the new full list needs its own approval', () => {
    expect(
      effectiveSkillNetworkHosts({
        declared: [...TEN_X_HOSTS, 'uploads.github.com'],
        approved: TEN_X_HOSTS,
        denied: [],
      }),
    ).toBeNull();
  });

  it('grants nothing for a skill that declares no hosts, approved or not', () => {
    expect(effectiveSkillNetworkHosts({ declared: undefined, approved: TEN_X_HOSTS, denied: [] })).toBeNull();
    expect(effectiveSkillNetworkHosts({ declared: [], approved: [], denied: [] })).toBeNull();
  });

  it('stays in force for the approved sites when another declared site was turned down', () => {
    expect(
      effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: ['github.com'], denied: ['api.github.com'] }),
    ).toEqual(['github.com']);
  });

  it('still grants nothing when a site that was not turned down is missing from the approval', () => {
    expect(effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: [], denied: ['api.github.com'] })).toBeNull();
  });

  it('a newly declared site that was not turned down still needs its own approval', () => {
    expect(
      effectiveSkillNetworkHosts({
        declared: [...TEN_X_HOSTS, 'uploads.github.com'],
        approved: ['github.com'],
        denied: ['api.github.com'],
      }),
    ).toBeNull();
  });

  it('grants nothing when every declared site was turned down', () => {
    expect(
      effectiveSkillNetworkHosts({ declared: TEN_X_HOSTS, approved: TEN_X_HOSTS, denied: TEN_X_HOSTS }),
    ).toBeNull();
  });
});

describe('isSkillNetworkHostName', () => {
  it('accepts the exact site names a skill may declare', () => {
    expect(isSkillNetworkHostName('github.com')).toBe(true);
    expect(isSkillNetworkHostName('gmail.googleapis.com')).toBe(true);
    expect(isSkillNetworkHostName('xn--mnchen-3ya.de')).toBe(true);
  });

  it.each([
    ['a loopback address', '127.0.0.1'],
    ['a private network address', '10.0.0.5'],
    ['a link-local address', '169.254.169.254'],
    ['an IPv6 address', '::1'],
    ['a bracketed IPv6 address', '[::1]'],
    ['a single label', 'localhost'],
    ['a trailing dot', 'github.com.'],
    ['credentials in front', 'user@github.com'],
    ['uppercase', 'GitHub.com'],
  ])('refuses %s', (_label, host) => {
    expect(isSkillNetworkHostName(host)).toBe(false);
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
});
