import type { ISkillStore, SkillRecord } from '../../../../src/db/skillStore';
import {
  SKILL_CODE_PIN_REFUSAL,
  SkillCodePinRefusedError,
  drainSkillNetworkCards,
  recordSkillNetworkAnswer,
  resolveSkillNetworkGrant,
} from '../../../../src/sandbox/skillnet/skillNetworkGrant';
import { SkillNetworkTokenRegistry } from '../../../../src/sandbox/skillnet/skillNetworkTokens';
import type { GitSkill, TrueFoundryRegistrySkill } from '../../../../src/schemas/skill';

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

function record(input: {
  manifest: GitSkill | TrueFoundryRegistrySkill;
  network_approval: readonly string[] | null;
  network_approval_code_sha?: string | null;
  network_allowed_hosts?: readonly string[];
  network_denied_hosts?: readonly string[];
}): SkillRecord {
  return {
    tenant_id: 'default',
    name: input.manifest.name,
    manifest: input.manifest,
    network_approval: input.network_approval,
    network_approval_code_sha: input.network_approval_code_sha ?? null,
    network_allowed_hosts: input.network_allowed_hosts ?? [],
    network_denied_hosts: input.network_denied_hosts ?? [],
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
    setSkillNetworkHostDecision: unused,
    setSkillNetworkCodePin: unused,
    listSkillVersions: async () => [],
    validateAgentSkills: async () => undefined,
    resolveTurnSkills: async () => [],
  };
}

/** A store whose records the card answers can change, like the real stores. */
function mutableStore(initial: SkillRecord[]): { store: ISkillStore; records: Map<string, SkillRecord> } {
  const records = new Map(initial.map(r => [r.name, { ...r }]));
  const unused = (): Promise<never> => Promise.reject(new Error('unused in this test'));
  const store: ISkillStore = {
    listSkills: async input =>
      [...records.values()].filter(
        r => r.tenant_id === input.tenant_id && (input.names === undefined || input.names.includes(r.name)),
      ),
    createSkill: unused,
    upsertSkill: unused,
    deleteSkill: unused,
    setSkillNetworkApproval: async input => {
      const current = records.get(input.name);
      if (current === undefined) return undefined;
      // The pin follows the grants, like the real stores: removing the approval keeps the
      // pin while allowances remain and clears it when none do.
      const next = {
        ...current,
        network_approval: input.hosts === null ? null : [...input.hosts],
        network_approval_code_sha:
          input.hosts !== null
            ? input.code_sha
            : current.network_allowed_hosts.length > 0
              ? current.network_approval_code_sha
              : null,
      };
      records.set(input.name, next);
      return next;
    },
    setSkillNetworkHostDecision: async input => {
      const current = records.get(input.name);
      if (current === undefined) return undefined;
      const allowed = new Set(current.network_allowed_hosts);
      const denied = new Set(current.network_denied_hosts);
      if (input.decision === 'allowed') {
        allowed.add(input.host);
        denied.delete(input.host);
      } else if (input.decision === 'denied') {
        denied.add(input.host);
        allowed.delete(input.host);
      } else {
        allowed.delete(input.host);
        denied.delete(input.host);
      }
      const next = {
        ...current,
        network_allowed_hosts: [...allowed].sort(),
        network_denied_hosts: [...denied].sort(),
        network_approval_code_sha:
          current.network_approval === null && allowed.size === 0 ? null : current.network_approval_code_sha,
      };
      records.set(input.name, next);
      return next;
    },
    setSkillNetworkCodePin: async input => {
      const current = records.get(input.name);
      if (current === undefined) return undefined;
      const next = { ...current, network_approval_code_sha: input.code_sha };
      records.set(input.name, next);
      return next;
    },
    listSkillVersions: async () => [],
    validateAgentSkills: async () => undefined,
    resolveTurnSkills: async () => [],
  };
  return { store, records };
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

  it('grants a site allowed on its own even with no approval of the declared list', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: null,
        network_allowed_hosts: ['api.github.com'],
      }),
    ]);
    const grant = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(grant?.hosts).toEqual(['api.github.com']);
  });

  it('never grants a turned-down site, even one on the approved list', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: TEN_X_HOSTS,
        network_denied_hosts: ['api.github.com'],
      }),
    ]);
    const grant = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(grant?.hosts).toEqual(['github.com']);
  });

  it('reads the records fresh, so clearing one allowed site ends its grant on the next read', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: null,
        network_allowed_hosts: ['api.github.com'],
      }),
    ]);
    const first = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(first?.hosts).toEqual(['api.github.com']);
    await store.setSkillNetworkHostDecision({
      tenant_id: 'default',
      name: 'ten-x',
      host: 'api.github.com',
      decision: 'none',
    });
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual([]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
  });
});

describe('drainSkillNetworkCards', () => {
  it('raises one first-use card for the whole declared list at first mount', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'first_use', code_pin: null }]);
  });

  it('raises no first-use card when the approval is in force', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('raises the first-use card once per chat until an answer lands', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('asks only for the declared sites still missing, and not for turned-down ones', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: null,
        network_allowed_hosts: ['github.com'],
        network_denied_hosts: ['api.github.com'],
      }),
    ]);
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('raises a card for a refused site the skill never declared', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    registry.recordRefusal({ session_id: CALL.session_id, host: 'uploads.example.com' });
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([
      { skill_name: 'ten-x', hosts: ['uploads.example.com'], reason: 'undeclared_host', code_pin: null },
    ]);
    // The refusal was drained as it was read, so it is not handed out twice.
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('raises no card for a refused site that is already granted or turned down', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: TEN_X_HOSTS,
        network_denied_hosts: ['blocked.example.com'],
      }),
    ]);
    registry.recordRefusal({ session_id: CALL.session_id, host: 'github.com' });
    registry.recordRefusal({ session_id: CALL.session_id, host: 'blocked.example.com' });
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });
});

describe('recordSkillNetworkAnswer', () => {
  it('allow once grants the sites for this chat only', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const resolveCodeSha = async () => 'a'.repeat(40);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'allow_once',
      resolveCodeSha,
    });
    const grant = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'], resolveCodeSha });
    expect(grant?.hosts).toEqual(['api.github.com', 'github.com']);
    const nextCommand = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(nextCommand?.hosts).toEqual(['api.github.com', 'github.com']);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, session_id: 'another-chat', skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
  });

  it('always allow on a first-use card approves the declared list itself, pinned to the code', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const pin = 'a'.repeat(40);
    const resolveCodeSha = async () => pin;
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(pin);
    const grant = await resolveSkillNetworkGrant({
      store,
      registry,
      ...CALL,
      session_id: 'another-chat',
      skillNames: ['ten-x'],
      resolveCodeSha,
    });
    expect(grant?.hosts).toEqual(['api.github.com', 'github.com']);
  });

  it('always allow on a first-use card carries in the declared sites already allowed one by one', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: null,
        network_allowed_hosts: ['github.com'],
      }),
    ]);
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: ['api.github.com'], reason: 'first_use', code_pin: null }]);
    const resolveCodeSha = async () => 'a'.repeat(40);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['api.github.com'],
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(['api.github.com', 'github.com']);
    const grant = await resolveSkillNetworkGrant({
      store,
      registry,
      ...CALL,
      session_id: 'another-chat',
      skillNames: ['ten-x'],
      resolveCodeSha,
    });
    expect(grant?.hosts).toEqual(['api.github.com', 'github.com']);
  });

  it('always allow on a first-use card grants the approved sites even when another declared site was turned down', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: null,
        network_denied_hosts: ['api.github.com'],
      }),
    ]);
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: ['github.com'], reason: 'first_use', code_pin: null }]);
    const resolveCodeSha = async () => 'a'.repeat(40);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['github.com'],
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha,
    });
    // The turned-down site is never written into the approval, and the approval still takes
    // effect for the site the person did approve: the grant resolves, and no card asks again.
    expect(records.get('ten-x')?.network_approval).toEqual(['github.com']);
    const grant = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(grant?.hosts).toEqual(['github.com']);
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);

    // Clearing the denial grants nothing on its own: the stored approval never named the
    // turned-down site, so the list needs a fresh approval and a card asks for it whole again.
    await store.setSkillNetworkHostDecision({
      tenant_id: 'default',
      name: 'ten-x',
      host: 'api.github.com',
      decision: 'none',
    });
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();
    const cardsAfterClear = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cardsAfterClear).toEqual([{ skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'first_use', code_pin: null }]);
  });

  it('an answer about a bare address stores nothing, so no grant for one can ever be created', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['169.254.169.254'],
      reason: 'undeclared_host',
      answer: 'always_allow',
    });
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual([]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['127.0.0.1'],
      reason: 'undeclared_host',
      answer: 'allow_once',
    });
    expect(registry.sessionHosts({ session_id: CALL.session_id, skill_name: 'ten-x' })).toEqual([]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['10.0.0.5'],
      reason: 'undeclared_host',
      answer: 'deny',
    });
    expect(records.get('ten-x')?.network_denied_hosts).toEqual([]);
  });

  it('a refused bare address raises no card', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    registry.recordRefusal({ session_id: CALL.session_id, host: '127.0.0.1' });
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('always allow on a first-use card does not approve a site the declaration gained after the card was raised', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'first_use', code_pin: null }]);
    const current = records.get('ten-x');
    if (current === undefined) throw new Error('expected the ten-x record');
    records.set('ten-x', {
      ...current,
      manifest: gitManifest({ network_hosts: [...TEN_X_HOSTS, 'uploads.github.com'] }),
    });
    const resolveCodeSha = async () => 'a'.repeat(40);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    const cardsAfter = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cardsAfter).toEqual([
      { skill_name: 'ten-x', hosts: [...TEN_X_HOSTS, 'uploads.github.com'], reason: 'first_use', code_pin: null },
    ]);
  });

  it('always allow on an undeclared site stores it beside the declared list, which stays unchanged', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: TEN_X_HOSTS }),
    ]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
      answer: 'always_allow',
    });
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual(['uploads.example.com']);
    expect(records.get('ten-x')?.manifest).toEqual(gitManifest({ network_hosts: TEN_X_HOSTS }));
    const grant = await resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(grant?.hosts).toEqual(['api.github.com', 'github.com', 'uploads.example.com']);
  });

  it('deny stores the sites as turned down, raises no more cards, and clearing brings the question back', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'deny',
    });
    expect(records.get('ten-x')?.network_denied_hosts).toEqual(['api.github.com', 'github.com']);
    await expect(drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] })).resolves.toEqual([]);
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...CALL, skillNames: ['ten-x'] }),
    ).resolves.toBeUndefined();

    for (const host of TEN_X_HOSTS) {
      await store.setSkillNetworkHostDecision({ tenant_id: 'default', name: 'ten-x', host, decision: 'none' });
    }
    const cards = await drainSkillNetworkCards({ store, registry, ...CALL, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'first_use', code_pin: null }]);
  });
});

describe('the code pin on the approval', () => {
  const PIN_A = 'a'.repeat(40);
  const PIN_B = 'b'.repeat(40);

  it('grants as before while the code is still at the pin, resolving once per chat', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const store = storeWith([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: TEN_X_HOSTS,
        network_approval_code_sha: PIN_A,
      }),
    ]);
    let resolutions = 0;
    const resolveCodeSha = async () => {
      resolutions += 1;
      return PIN_A;
    };
    const call = { ...CALL, session_id: 'pin-same' };
    const first = await resolveSkillNetworkGrant({ store, registry, ...call, skillNames: ['ten-x'], resolveCodeSha });
    expect(first?.hosts).toEqual(['api.github.com', 'github.com']);
    const second = await resolveSkillNetworkGrant({ store, registry, ...call, skillNames: ['ten-x'], resolveCodeSha });
    expect(second?.hosts).toEqual(['api.github.com', 'github.com']);
    expect(resolutions).toBe(1);
  });

  it('a moved branch grants nothing, clears the approval and its allowances, and raises the code-changed card', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: TEN_X_HOSTS,
        network_approval_code_sha: PIN_A,
        network_allowed_hosts: ['uploads.example.com'],
      }),
    ]);
    const resolveCodeSha = async () => PIN_B;
    const call = { ...CALL, session_id: 'pin-moved' };
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...call, skillNames: ['ten-x'], resolveCodeSha }),
    ).resolves.toBeUndefined();
    expect(records.get('ten-x')?.network_approval).toBeNull();
    expect(records.get('ten-x')?.network_approval_code_sha).toBeNull();
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual([]);
    const cards = await drainSkillNetworkCards({ store, registry, ...call, skillNames: ['ten-x'] });
    expect(cards).toEqual([
      {
        skill_name: 'ten-x',
        hosts: [...TEN_X_HOSTS, 'uploads.example.com'],
        reason: 'code_changed',
        code_pin: PIN_B,
      },
    ]);
  });

  it('an unreadable code version grants nothing this time and keeps the approval and its card state', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({
        manifest: gitManifest({ network_hosts: TEN_X_HOSTS }),
        network_approval: TEN_X_HOSTS,
        network_approval_code_sha: PIN_A,
      }),
    ]);
    const resolveCodeSha = async (): Promise<string> => {
      throw new Error('repository unreachable');
    };
    const call = { ...CALL, session_id: 'pin-unreadable' };
    await expect(
      resolveSkillNetworkGrant({ store, registry, ...call, skillNames: ['ten-x'], resolveCodeSha }),
    ).resolves.toBeUndefined();
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(PIN_A);
    await expect(drainSkillNetworkCards({ store, registry, ...call, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('allow-once sites count while the code is unchanged', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const resolveCodeSha = async () => PIN_A;
    const call = { ...CALL, session_id: 'pin-once-same' };
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'allow_once',
      resolveCodeSha,
    });
    const grant = await resolveSkillNetworkGrant({ store, registry, ...call, skillNames: ['ten-x'], resolveCodeSha });
    expect(grant?.hosts).toEqual(['api.github.com', 'github.com']);
  });

  it('allow-once sites stop counting when the code has moved since they were allowed', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const call = { ...CALL, session_id: 'pin-once-moved' };
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'allow_once',
      resolveCodeSha: async () => PIN_A,
    });
    await expect(
      resolveSkillNetworkGrant({
        store,
        registry,
        ...call,
        skillNames: ['ten-x'],
        resolveCodeSha: async () => PIN_B,
      }),
    ).resolves.toBeUndefined();
  });

  it('approving is refused in plain words, storing nothing, when the code version cannot be read', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const attempt = recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      session_id: 'pin-refused',
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha: async (): Promise<string> => {
        throw new Error('repository unreachable');
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(SkillCodePinRefusedError);
    await expect(attempt).rejects.toThrow(SKILL_CODE_PIN_REFUSAL);
    expect(records.get('ten-x')?.network_approval).toBeNull();
    expect(records.get('ten-x')?.network_approval_code_sha).toBeNull();
  });

  it('the code-changed round trip: approve, the branch moves, the card answers, grants resume at the new commit', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const approveCall = { ...CALL, session_id: 'pin-round-trip-approve' };
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...approveCall,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'first_use',
      answer: 'always_allow',
      resolveCodeSha: async () => PIN_A,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(PIN_A);
    const before = await resolveSkillNetworkGrant({
      store,
      registry,
      ...approveCall,
      skillNames: ['ten-x'],
      resolveCodeSha: async () => PIN_A,
    });
    expect(before?.hosts).toEqual(['api.github.com', 'github.com']);

    // The branch moves: the next chat's check cancels the approval and raises the card.
    const movedCall = { ...CALL, session_id: 'pin-round-trip-moved' };
    await expect(
      resolveSkillNetworkGrant({
        store,
        registry,
        ...movedCall,
        skillNames: ['ten-x'],
        resolveCodeSha: async () => PIN_B,
      }),
    ).resolves.toBeUndefined();
    expect(records.get('ten-x')?.network_approval).toBeNull();
    expect(records.get('ten-x')?.network_approval_code_sha).toBeNull();
    const cards = await drainSkillNetworkCards({ store, registry, ...movedCall, skillNames: ['ten-x'] });
    expect(cards).toEqual([{ skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'code_changed', code_pin: PIN_B }]);

    // Answering the card stores the approval again, pinned to the new commit.
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...movedCall,
      skill_name: 'ten-x',
      hosts: TEN_X_HOSTS,
      reason: 'code_changed',
      answer: 'always_allow',
      resolveCodeSha: async () => PIN_B,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(PIN_B);
    const resumed = await resolveSkillNetworkGrant({
      store,
      registry,
      ...CALL,
      session_id: 'pin-round-trip-resumed',
      skillNames: ['ten-x'],
      resolveCodeSha: async () => PIN_B,
    });
    expect(resumed?.hosts).toEqual(['api.github.com', 'github.com']);
    await expect(drainSkillNetworkCards({ store, registry, ...movedCall, skillNames: ['ten-x'] })).resolves.toEqual([]);
  });

  it('allowances alone are bound to the pin, cleared when the code moves, and named on the code-changed card', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const call = { ...CALL, session_id: 'pin-allowances' };
    registry.recordRefusal({ session_id: call.session_id, host: 'uploads.example.com' });
    const firstCards = await drainSkillNetworkCards({ store, registry, ...call, skillNames: ['ten-x'] });
    expect(firstCards).toEqual([
      { skill_name: 'ten-x', hosts: TEN_X_HOSTS, reason: 'first_use', code_pin: null },
      { skill_name: 'ten-x', hosts: ['uploads.example.com'], reason: 'undeclared_host', code_pin: null },
    ]);
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
      answer: 'always_allow',
      resolveCodeSha: async () => PIN_A,
    });
    expect(records.get('ten-x')?.network_approval).toBeNull();
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual(['uploads.example.com']);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(PIN_A);
    const granted = await resolveSkillNetworkGrant({
      store,
      registry,
      ...call,
      skillNames: ['ten-x'],
      resolveCodeSha: async () => PIN_A,
    });
    expect(granted?.hosts).toEqual(['uploads.example.com']);

    // The branch moves: the allowance is cleared, nothing is granted, and the card names it.
    const movedCall = { ...CALL, session_id: 'pin-allowances-moved' };
    await expect(
      resolveSkillNetworkGrant({
        store,
        registry,
        ...movedCall,
        skillNames: ['ten-x'],
        resolveCodeSha: async () => PIN_B,
      }),
    ).resolves.toBeUndefined();
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual([]);
    expect(records.get('ten-x')?.network_approval_code_sha).toBeNull();
    const cards = await drainSkillNetworkCards({ store, registry, ...movedCall, skillNames: ['ten-x'] });
    expect(cards).toEqual([
      {
        skill_name: 'ten-x',
        hosts: [...TEN_X_HOSTS, 'uploads.example.com'],
        reason: 'code_changed',
        code_pin: PIN_B,
      },
    ]);

    // Answering restores each grant as the kind it was, under the new pin.
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...movedCall,
      skill_name: 'ten-x',
      hosts: [...TEN_X_HOSTS, 'uploads.example.com'],
      reason: 'code_changed',
      answer: 'always_allow',
      resolveCodeSha: async () => PIN_B,
    });
    expect(records.get('ten-x')?.network_approval).toEqual(TEN_X_HOSTS);
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual(['uploads.example.com']);
    expect(records.get('ten-x')?.network_approval_code_sha).toBe(PIN_B);
    const restored = await resolveSkillNetworkGrant({
      store,
      registry,
      ...movedCall,
      skillNames: ['ten-x'],
      resolveCodeSha: async () => PIN_B,
    });
    expect(restored?.hosts).toEqual(['api.github.com', 'github.com', 'uploads.example.com']);
  });

  it('allowing a site is refused in plain words, storing nothing, when the code version cannot be read', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store, records } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const attempt = recordSkillNetworkAnswer({
      store,
      registry,
      ...CALL,
      session_id: 'pin-allowance-refused',
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
      answer: 'always_allow',
      resolveCodeSha: async (): Promise<string> => {
        throw new Error('repository unreachable');
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(SkillCodePinRefusedError);
    await expect(attempt).rejects.toThrow(SKILL_CODE_PIN_REFUSAL);
    expect(records.get('ten-x')?.network_allowed_hosts).toEqual([]);
    expect(records.get('ten-x')?.network_approval_code_sha).toBeNull();
  });

  it('allow-once sites keep the stamp of the answer that allowed them when a later answer allows more', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const { store } = mutableStore([
      record({ manifest: gitManifest({ network_hosts: TEN_X_HOSTS }), network_approval: null }),
    ]);
    const call = { ...CALL, session_id: 'pin-stamps-split' };
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: 'ten-x',
      hosts: ['one.example.com'],
      reason: 'undeclared_host',
      answer: 'allow_once',
      resolveCodeSha: async () => PIN_A,
    });
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: 'ten-x',
      hosts: ['two.example.com'],
      reason: 'undeclared_host',
      answer: 'allow_once',
      resolveCodeSha: async () => PIN_B,
    });
    expect(
      registry.sessionHostsWithPin({ session_id: call.session_id, skill_name: 'ten-x', code_sha: PIN_A })?.hosts,
    ).toEqual(['one.example.com']);
    expect(
      registry.sessionHostsWithPin({ session_id: call.session_id, skill_name: 'ten-x', code_sha: PIN_B })?.hosts,
    ).toEqual(['two.example.com']);
    // At the new code only the sites allowed under it count; the earlier stamp is not re-based.
    const grant = await resolveSkillNetworkGrant({
      store,
      registry,
      ...call,
      skillNames: ['ten-x'],
      resolveCodeSha: async () => PIN_B,
    });
    expect(grant?.hosts).toEqual(['two.example.com']);
  });

  it('a registry skill whose version changes loses its allowances and raises the code-changed card', async () => {
    const registry = new SkillNetworkTokenRegistry();
    const oldFqn = 'agent-skill:acme/team-a/echo:3';
    const newFqn = 'agent-skill:acme/team-a/echo:4';
    const registryManifest = (name: string, version: number): TrueFoundryRegistrySkill => ({
      type: 'truefoundry',
      name,
      display_name: 'echo',
      description: 'Echo skill',
      repository_name: 'team-a',
      version,
    });
    const { store, records } = mutableStore([
      record({
        manifest: registryManifest(oldFqn, 3),
        network_approval: null,
        network_approval_code_sha: oldFqn,
        network_allowed_hosts: ['uploads.example.com'],
      }),
    ]);
    const call = { ...CALL, session_id: 'pin-registry-moved' };
    const before = await resolveSkillNetworkGrant({ store, registry, ...call, skillNames: [oldFqn] });
    expect(before?.hosts).toEqual(['uploads.example.com']);

    // A version-changing upsert replaces the manifest and keeps the grants beside it.
    const current = records.get(oldFqn);
    if (current === undefined) throw new Error('expected the registry record');
    records.set(oldFqn, { ...current, manifest: registryManifest(newFqn, 4) });
    await expect(resolveSkillNetworkGrant({ store, registry, ...call, skillNames: [oldFqn] })).resolves.toBeUndefined();
    expect(records.get(oldFqn)?.network_allowed_hosts).toEqual([]);
    expect(records.get(oldFqn)?.network_approval_code_sha).toBeNull();
    const cards = await drainSkillNetworkCards({ store, registry, ...call, skillNames: [oldFqn] });
    expect(cards).toEqual([
      { skill_name: oldFqn, hosts: ['uploads.example.com'], reason: 'code_changed', code_pin: newFqn },
    ]);

    // Answering the card restores the allowance under the new version.
    await recordSkillNetworkAnswer({
      store,
      registry,
      ...call,
      skill_name: oldFqn,
      hosts: ['uploads.example.com'],
      reason: 'code_changed',
      answer: 'always_allow',
    });
    expect(records.get(oldFqn)?.network_approval).toBeNull();
    expect(records.get(oldFqn)?.network_allowed_hosts).toEqual(['uploads.example.com']);
    expect(records.get(oldFqn)?.network_approval_code_sha).toBe(newFqn);
    const restored = await resolveSkillNetworkGrant({ store, registry, ...call, skillNames: [oldFqn] });
    expect(restored?.hosts).toEqual(['uploads.example.com']);
  });
});
