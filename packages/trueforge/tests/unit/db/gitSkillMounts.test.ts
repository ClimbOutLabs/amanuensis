import type { Skill as SkillMount } from '@truefoundry/trueforge-core/core';
import { resolveGitTurnSkills } from '../../../src/db/gitSkillMounts';
import type { ISkillStore, SkillRecord } from '../../../src/db/skillStore';
import type { GitSkill } from '../../../src/schemas/skill';

const PIN = 'a'.repeat(40);
const HOSTS = ['github.com', 'api.github.com'] as const;

function manifest(): GitSkill {
  return {
    type: 'git',
    name: 'ten-x',
    url: 'https://github.com/example/ten-x',
    ref: 'main',
    description: 'Works with GitHub from the sandbox.',
    network_hosts: [...HOSTS],
  };
}

function record(input: {
  network_approval: readonly string[] | null;
  network_approval_code_sha?: string | null;
}): SkillRecord {
  return {
    tenant_id: 'default',
    name: 'ten-x',
    manifest: manifest(),
    network_approval: input.network_approval,
    network_approval_code_sha: input.network_approval_code_sha ?? null,
    network_allowed_hosts: [],
    network_denied_hosts: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function storeWith(records: SkillRecord[]): Pick<ISkillStore, 'listSkills'> {
  return { listSkills: async () => records };
}

const TURN = { tenant_id: 'default', skills: [{ name: 'ten-x', preload: false }] };

/** The ref the one mount fetches at; every case here mounts the git skill. */
function mountRef(mounts: SkillMount[]): string {
  const [mount] = mounts;
  if (mount === undefined || mount.type !== 'git') {
    throw new Error('expected exactly one git mount');
  }
  return mount.ref;
}

describe('resolveGitTurnSkills code pin', () => {
  it('mounts at the stored pin while the approval is in force', async () => {
    const mounts = await resolveGitTurnSkills(
      storeWith([record({ network_approval: HOSTS, network_approval_code_sha: PIN })]),
      TURN,
    );
    expect(mounts).toHaveLength(1);
    expect(mountRef(mounts)).toBe(PIN);
  });

  it('mounts at the manifest ref when there is no approval', async () => {
    const mounts = await resolveGitTurnSkills(storeWith([record({ network_approval: null })]), TURN);
    expect(mountRef(mounts)).toBe('main');
  });

  it('mounts at the manifest ref for an approval stored before pins existed', async () => {
    const mounts = await resolveGitTurnSkills(
      storeWith([record({ network_approval: HOSTS, network_approval_code_sha: null })]),
      TURN,
    );
    expect(mountRef(mounts)).toBe('main');
  });

  it('mounts at the manifest ref when the stored approval no longer matches the declared list', async () => {
    const mounts = await resolveGitTurnSkills(
      storeWith([record({ network_approval: ['github.com'], network_approval_code_sha: PIN })]),
      TURN,
    );
    expect(mountRef(mounts)).toBe('main');
  });
});
