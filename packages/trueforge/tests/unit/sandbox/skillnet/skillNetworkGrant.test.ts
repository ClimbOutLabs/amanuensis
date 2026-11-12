import type { ISkillStore, SkillRecord } from '../../../../src/db/skillStore';
import { resolveSkillNetworkGrant } from '../../../../src/sandbox/skillnet/skillNetworkGrant';
import { SkillNetworkTokenRegistry } from '../../../../src/sandbox/skillnet/skillNetworkTokens';
import type { GitSkill } from '../../../../src/schemas/skill';

/** The worked example from the design: the ten-x skill's two GitHub hosts. */
const TEN_X_HOSTS = ['github.com', 'api.github.com'];

function gitManifest(overrides: Partial<GitSkill> = {}): GitSkill {
  return {
    type: 'git',
    name: 'ten-x',
    url: 'https://github.com/example/ten-x',
    ref: 'main',
    description: 'Works with GitHub from the sandbox.',
    ...overrides,
  };
}

function record(input: { manifest: GitSkill; network_approval: readonly string[] | null }): SkillRecord {
  return {
    tenant_id: 'default',
    name: input.manifest.name,
    manifest: input.manifest,
    network_approval: input.network_approval,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function storeWith(records: SkillRecord[]): ISkillStore {
  const unused = (): Promise<never> => Promise.reject(new Error('unused in this test'));
  return {
    listSkills: async input =>
      records.filter(
        r => r.tenant_id === input.tenant_id && (input.names === undefined || input.names.includes(r.name)),
      ),
    createSkill: unused,
    upsertSkill: unused,
    deleteSkill: unused,
    setSkillNetworkApproval: unused,
    listSkillVersions: async () => [],
    validateAgentSkills: async () => undefined,
    resolveTurnSkills: async () => [],
  };
}

const CALL = { tenant_id: 'default', created_by: 'owner', session_id: 'session-1' };

describe('resolveSkillNetworkGrant', () => {
  it('issues a grant for the union of the mounted skills approved sites', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
      record({
        manifest: gitManifest({ name: 'docs', network_hosts: ['docs.example.com'] }),
        network_approval: ['docs.example.com'],
      }),
    ]);
    const grant = await resolveSkillNetworkGrant({
      store,
      registry,
      ...CALL,
      skillNames: ['ten-x', 'docs'],
    });
    expect(grant?.hosts).toEqual(['api.github.com', 'docs.example.com', 'github.com']);
    expect(grant !== undefined && registry.resolve(grant.token)?.hosts).toEqual(grant?.hosts);
  });

  it('returns nothing for a skill that declares hosts but was never approved', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
  });

  it('returns nothing for a skill with no declaration, exactly as today', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([record({ manifest: gitManifest(), network_approval: null })]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
  });

  it('grants only the skills in this chat, not every approved skill in the store', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['someone-else'] }),
    ).resolves.toBeUndefined();
  });

  it('a removed approval ends the grant on the next read and revokes the session tokens', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const approved = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    const first = await resolveSkillNetworkGrant({
      store: approved,
      registry,
      ...CALL,
      skillNames: ['ten-x'],
    });
    if (first === undefined) throw new Error('expected a grant');
    expect(registry.resolve(first.token)).toBeDefined();

    const revoked = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    await expect(
      resolveSkillNetworkGrant({ store: revoked, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
    expect(registry.resolve(first.token)).toBeUndefined();
  });

  it('a host added to the declaration after approval grants nothing until the new list is approved', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: [...TEN_X_HOSTS, 'uploads.github.com'] }),
        network_approval: TEN_X_HOSTS,
      }),
    ]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
  });
});
