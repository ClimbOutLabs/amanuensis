/**
 * Backend-agnostic behavioural contract for ISkillStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import { SkillNameConflictError, type ISkillStore } from '../../src/db/skillStore';
import type { GitSkill } from '../../src/schemas/skill';

const TENANT = 'default';

function manifest(overrides: Partial<GitSkill> = {}): GitSkill {
  return {
    type: 'git',
    name: 'algorithmic-art',
    url: 'https://github.com/anthropics/skills',
    path: 'skills/algorithmic-art',
    ref: 'main',
    description: 'Creating algorithmic art using p5.js with seeded randomness.',
    ...overrides,
  };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function runSkillStoreContractSuite(getStore: () => ISkillStore): void {
  it('upsert creates a skill and round-trips the manifest', async () => {
    const store = getStore();
    const created = await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest(),
    });

    expect(created.tenant_id).toBe(TENANT);
    expect(created.name).toBe('algorithmic-art');
    expect(created.manifest).toEqual(manifest());
    expect(created.created_at).toMatch(ISO_UTC);
    expect(created.updated_at).toBe(created.created_at);

    const skills = await store.listSkills({ tenant_id: TENANT, names: undefined });
    expect(skills).toEqual([created]);
  });

  it('createSkill inserts and throws SkillNameConflictError on name clash', async () => {
    const store = getStore();
    const created = await store.createSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest(),
    });
    expect(created.name).toBe('algorithmic-art');

    await expect(
      store.createSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() }),
    ).rejects.toBeInstanceOf(SkillNameConflictError);
  });

  it('upsert replaces the whole manifest and preserves created_at', async () => {
    const store = getStore();
    const created = await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest(),
    });

    const replacement = manifest({
      description: 'Updated description for algorithmic art.',
      ref: 'v2',
    });
    const updated = await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: replacement,
    });

    expect(updated.manifest).toEqual(replacement);
    expect(updated.created_at).toBe(created.created_at);
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));

    const skills = await store.listSkills({ tenant_id: TENANT, names: undefined });
    expect(skills).toEqual([updated]);
  });

  it('listSkills returns only the tenant, ordered by name', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'web-artifacts',
      manifest: manifest({
        name: 'web-artifacts',
        path: 'skills/web-artifacts-builder',
        description: 'Build web artifacts.',
      }),
    });
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    await store.upsertSkill({
      tenant_id: 'other-tenant',
      name: 'algorithmic-art',
      manifest: manifest(),
    });

    const skills = await store.listSkills({ tenant_id: TENANT, names: undefined });
    expect(skills.map(skill => skill.name)).toEqual(['algorithmic-art', 'web-artifacts']);
    expect(skills.every(skill => skill.tenant_id === TENANT)).toBe(true);
  });

  it('validateAgentSkills admits known names and rejects the first missing', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'web-artifacts',
      manifest: manifest({
        name: 'web-artifacts',
        path: 'skills/web-artifacts-builder',
        description: 'Build web artifacts.',
      }),
    });

    await expect(
      store.validateAgentSkills({
        tenant_id: TENANT,
        skills: [
          { name: 'web-artifacts', preload: false },
          { name: 'algorithmic-art', preload: false },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(store.validateAgentSkills({ tenant_id: TENANT, skills: [] })).resolves.toBeUndefined();
    await expect(
      store.validateAgentSkills({
        tenant_id: TENANT,
        skills: [
          { name: 'algorithmic-art', preload: false },
          { name: 'missing', preload: false },
        ],
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Unknown skill "missing" — not configured',
    });
  });

  it('listSkills filters by names and returns empty for an empty name list', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'web-artifacts',
      manifest: manifest({
        name: 'web-artifacts',
        path: 'skills/web-artifacts-builder',
        description: 'Build web artifacts.',
      }),
    });
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'demo',
      manifest: manifest({ name: 'demo', path: 'skills/demo', description: 'Demo skill.' }),
    });

    const filtered = await store.listSkills({
      tenant_id: TENANT,
      names: ['demo', 'missing', 'web-artifacts'],
    });
    expect(filtered.map(skill => skill.name)).toEqual(['demo', 'web-artifacts']);

    await expect(store.listSkills({ tenant_id: TENANT, names: [] })).resolves.toEqual([]);
  });

  it('deleteSkill removes the row and reports whether one was deleted', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });

    expect(await store.deleteSkill({ tenant_id: TENANT, name: 'algorithmic-art' })).toBe(true);
    expect(await store.listSkills({ tenant_id: TENANT, names: ['algorithmic-art'] })).toEqual([]);
    expect(await store.deleteSkill({ tenant_id: TENANT, name: 'algorithmic-art' })).toBe(false);
  });

  it('listSkillVersions returns [] in standalone (no registry versions)', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    await expect(store.listSkillVersions({ name: 'algorithmic-art' })).resolves.toEqual([]);
  });

  it('validateAgentSkills and resolveTurnSkills round-trip git skills', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    const skills = [{ name: 'algorithmic-art', preload: false }];
    await expect(store.validateAgentSkills({ tenant_id: TENANT, skills })).resolves.toBeUndefined();
    await expect(store.resolveTurnSkills({ tenant_id: TENANT, skills })).resolves.toEqual([
      {
        type: 'git',
        name: 'algorithmic-art',
        description: 'Creating algorithmic art using p5.js with seeded randomness.',
        url: 'https://github.com/anthropics/skills',
        path: 'skills/algorithmic-art',
        ref: 'main',
      },
    ]);
  });

  it('validateAgentSkills rejects preload on git skills', async () => {
    const store = getStore();
    await store.upsertSkill({ tenant_id: TENANT, name: 'algorithmic-art', manifest: manifest() });
    await expect(
      store.validateAgentSkills({
        tenant_id: TENANT,
        skills: [{ name: 'algorithmic-art', preload: true }],
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Skill "algorithmic-art": preload is not supported for git skills',
    });
  });

  it('a new skill has no network approval', async () => {
    const store = getStore();
    const created = await store.createSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    expect(created.network_approval).toBeNull();
    expect(created.network_approval_code_sha).toBeNull();
  });

  it('setSkillNetworkApproval stores the exact list, and null takes it back', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    const approved = await store.setSkillNetworkApproval({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      hosts: ['github.com', 'api.github.com'],
      code_sha: 'a'.repeat(40),
    });
    expect(approved?.network_approval).toEqual(['github.com', 'api.github.com']);
    expect(approved?.network_approval_code_sha).toBe('a'.repeat(40));
    const [listed] = await store.listSkills({ tenant_id: TENANT, names: ['algorithmic-art'] });
    expect(listed?.network_approval).toEqual(['github.com', 'api.github.com']);
    expect(listed?.network_approval_code_sha).toBe('a'.repeat(40));

    const cleared = await store.setSkillNetworkApproval({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      hosts: null,
      code_sha: null,
    });
    expect(cleared?.network_approval).toBeNull();
    expect(cleared?.network_approval_code_sha).toBeNull();
  });

  it('setSkillNetworkApproval on a missing skill returns undefined', async () => {
    const store = getStore();
    await expect(
      store.setSkillNetworkApproval({ tenant_id: TENANT, name: 'nope', hosts: ['github.com'], code_sha: null }),
    ).resolves.toBeUndefined();
  });

  it('removing the approval keeps the pin while an allowance stands, and the pin clears with the last grant', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    await store.setSkillNetworkApproval({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      hosts: ['github.com', 'api.github.com'],
      code_sha: 'a'.repeat(40),
    });
    await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'allowed',
    });

    const removed = await store.setSkillNetworkApproval({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      hosts: null,
      code_sha: null,
    });
    expect(removed?.network_approval).toBeNull();
    expect(removed?.network_allowed_hosts).toEqual(['uploads.github.com']);
    expect(removed?.network_approval_code_sha).toBe('a'.repeat(40));
    const [listed] = await store.listSkills({ tenant_id: TENANT, names: ['algorithmic-art'] });
    expect(listed?.network_approval_code_sha).toBe('a'.repeat(40));

    const lastGone = await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'none',
    });
    expect(lastGone?.network_allowed_hosts).toEqual([]);
    expect(lastGone?.network_approval_code_sha).toBeNull();
  });

  it('setSkillNetworkCodePin stores the pin beside the grants and overwrites it', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'allowed',
    });
    const pinned = await store.setSkillNetworkCodePin({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      code_sha: 'a'.repeat(40),
    });
    expect(pinned?.network_approval).toBeNull();
    expect(pinned?.network_allowed_hosts).toEqual(['uploads.github.com']);
    expect(pinned?.network_approval_code_sha).toBe('a'.repeat(40));

    const moved = await store.setSkillNetworkCodePin({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      code_sha: 'b'.repeat(40),
    });
    expect(moved?.network_approval_code_sha).toBe('b'.repeat(40));
    const [listed] = await store.listSkills({ tenant_id: TENANT, names: ['algorithmic-art'] });
    expect(listed?.network_approval_code_sha).toBe('b'.repeat(40));

    await expect(
      store.setSkillNetworkCodePin({ tenant_id: TENANT, name: 'nope', code_sha: 'a'.repeat(40) }),
    ).resolves.toBeUndefined();
  });

  it('a new skill has no per-site network decisions', async () => {
    const store = getStore();
    const created = await store.createSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    expect(created.network_allowed_hosts).toEqual([]);
    expect(created.network_denied_hosts).toEqual([]);
  });

  it('setSkillNetworkHostDecision stores one decision per site, and none clears it', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    const allowed = await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'allowed',
    });
    expect(allowed?.network_allowed_hosts).toEqual(['uploads.github.com']);
    expect(allowed?.network_denied_hosts).toEqual([]);

    // A site holds one decision at a time: turning it down replaces the allowance.
    const denied = await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'denied',
    });
    expect(denied?.network_allowed_hosts).toEqual([]);
    expect(denied?.network_denied_hosts).toEqual(['uploads.github.com']);
    const [listed] = await store.listSkills({ tenant_id: TENANT, names: ['algorithmic-art'] });
    expect(listed?.network_denied_hosts).toEqual(['uploads.github.com']);

    const cleared = await store.setSkillNetworkHostDecision({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      host: 'uploads.github.com',
      decision: 'none',
    });
    expect(cleared?.network_allowed_hosts).toEqual([]);
    expect(cleared?.network_denied_hosts).toEqual([]);
  });

  it('setSkillNetworkHostDecision on a missing skill returns undefined', async () => {
    const store = getStore();
    await expect(
      store.setSkillNetworkHostDecision({ tenant_id: TENANT, name: 'nope', host: 'github.com', decision: 'denied' }),
    ).resolves.toBeUndefined();
  });

  it('replacing the manifest keeps the stored approval beside it', async () => {
    const store = getStore();
    await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ network_hosts: ['github.com', 'api.github.com'] }),
    });
    await store.setSkillNetworkApproval({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      hosts: ['github.com', 'api.github.com'],
      code_sha: 'b'.repeat(40),
    });
    const replaced = await store.upsertSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: manifest({ description: 'Updated description for algorithmic art.' }),
    });
    expect(replaced.network_approval).toEqual(['github.com', 'api.github.com']);
    expect(replaced.network_approval_code_sha).toBe('b'.repeat(40));
  });
}
