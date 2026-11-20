import { resolvePinnedSetup } from '../../../../src/runtime/goals/goalPinning';
import {
  AGENT_ID,
  FIXED_NOW,
  FakeSkillStore,
  TENANT_ID,
  fundraiserAgent,
  fundraiserManifest,
} from './fundraiserFixture';

describe('goal setup pinning', () => {
  it('resolves the same digest for an unchanged setup', async () => {
    const skills = new FakeSkillStore();
    const first = await resolvePinnedSetup({
      agent: fundraiserAgent(),
      skillStore: skills,
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    const second = await resolvePinnedSetup({
      agent: fundraiserAgent(),
      skillStore: skills,
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    expect(second.digest).toBe(first.digest);
    expect(first.agent_id).toBe(AGENT_ID);
    expect(first.skills).toEqual([{ name: 'venue-finder', preload: true, digest: expect.any(String) }]);
  });

  it('changes the digest when the instructions or the model change', async () => {
    const skills = new FakeSkillStore();
    const base = await resolvePinnedSetup({
      agent: fundraiserAgent(),
      skillStore: skills,
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    const reworded = await resolvePinnedSetup({
      agent: fundraiserAgent(fundraiserManifest('Different instructions entirely.')),
      skillStore: skills,
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    expect(reworded.digest).not.toBe(base.digest);

    const otherModel = fundraiserManifest();
    const remodelled = await resolvePinnedSetup({
      agent: fundraiserAgent({ ...otherModel, model: { name: 'test/other-model' } }),
      skillStore: skills,
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    expect(remodelled.digest).not.toBe(base.digest);
  });

  it('pins references and digests only, never credential material', async () => {
    const setup = await resolvePinnedSetup({
      agent: fundraiserAgent(),
      skillStore: new FakeSkillStore(),
      tenant_id: TENANT_ID,
      now: FIXED_NOW,
    });
    // The connector is named, as the agent spec names it. Nothing about how to
    // sign in to it is in the snapshot: no keys, tokens, or passwords anywhere.
    expect(setup.spec.mcp_servers?.map(server => server.name)).toEqual(['mail']);
    const serialised = JSON.stringify(setup).toLowerCase();
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('api_key');
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('bearer');
    // The skill is pinned by digest, not by carrying its source address.
    expect(serialised).not.toContain('github.com');
  });

  it('refuses to resolve when a named skill is not in the store', async () => {
    await expect(
      resolvePinnedSetup({
        agent: fundraiserAgent(),
        skillStore: new FakeSkillStore([]),
        tenant_id: TENANT_ID,
        now: FIXED_NOW,
      }),
    ).rejects.toThrow('venue-finder');
  });
});
