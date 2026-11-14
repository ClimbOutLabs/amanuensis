import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const FOLDER = '/workspace/.aman/skills/ai-news';

function services({ switchOn }: { switchOn: boolean }): SentinelServices {
  const result = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  result.sandboxWithoutAsking = () => Promise.resolve(switchOn);
  result.isOffline = () => Promise.resolve(false);
  return result;
}

function ctx({ svc, network }: { svc: SentinelServices; network: 'none' | 'reachable' }): ClassifyContext {
  return {
    services: svc,
    sandbox_network: network === 'none' ? 'none' : undefined,
    path_resolution: 'remote',
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: '/workspace',
    agent_intent: 'get the AI news',
    web_search: createWebSearchTurnState(),
  };
}

function run(params: Record<string, unknown> = {}): SentinelAction {
  return {
    tool_name: 'run_skill_script',
    canonical_params: {
      skill: 'ai-news',
      script: 'scripts/fetch.py',
      args: ['--days', '3'],
      skill_folder: FOLDER,
      ...params,
    },
    tool_type: 'truefoundry-system',
    mcp_hints: {},
  };
}

function trackInFolder(svc: SentinelServices, file: string): void {
  svc.tracked_store.track({
    scope: {
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      repository_id: null,
      workspace_cwd: '/workspace',
    },
    file_identity: file,
  });
}

describe('running a skill script', () => {
  test.each([true, false])('runs without a card on a sandbox with no network (switch on: %s)', async switchOn => {
    const decision = await classifyTier(run(), ctx({ svc: services({ switchOn }), network: 'none' }));
    expect(decision.tier).toBe(1);
    expect(decision.card).toBeNull();
    expect(decision.reason_detail).toContain('ai-news');
  });

  test('asks on a sandbox that can reach a network, naming the skill and the script', async () => {
    const decision = await classifyTier(run(), ctx({ svc: services({ switchOn: true }), network: 'reachable' }));
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe('Run a script from the ai-news skill?');
    expect(decision.card?.parsed_command).toBe('scripts/fetch.py --days 3');
  });

  test("asks when Aman changed a file in the skill's folder in this chat", async () => {
    const svc = services({ switchOn: true });
    trackInFolder(svc, `${FOLDER}/scripts/helper.py`);
    const decision = await classifyTier(run(), ctx({ svc, network: 'none' }));
    expect(decision.tier).toBe(3);
  });

  test("a change in another skill's folder with a longer name does not count", async () => {
    const svc = services({ switchOn: false });
    trackInFolder(svc, `${FOLDER}-extra/scripts/fetch.py`);
    const decision = await classifyTier(run(), ctx({ svc, network: 'none' }));
    expect(decision.tier).toBe(1);
  });

  test('a call without the server-worked-out folder asks', async () => {
    const decision = await classifyTier(
      run({ skill_folder: null }),
      ctx({ svc: services({ switchOn: true }), network: 'none' }),
    );
    expect(decision.tier).toBe(3);
  });
});
