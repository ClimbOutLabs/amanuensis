import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** A sandbox whose files the server cannot see: nothing at /workspace exists on this machine. */
const ROOT = '/workspace';

function servicesWith({ sandbox_without_asking }: { sandbox_without_asking: boolean }): SentinelServices {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.sandboxWithoutAsking = () => Promise.resolve(sandbox_without_asking);
  return services;
}

/** A remote sandbox holding `existing`; `asked` records every path the server asked it about. */
function remoteSandbox({
  services,
  existing,
  network = 'none',
  canAsk = true,
}: {
  services: SentinelServices;
  existing: readonly string[];
  network?: 'none' | 'reachable';
  canAsk?: boolean;
}): { ctx: ClassifyContext; asked: string[] } {
  const asked: string[] = [];
  const ctx: ClassifyContext = {
    services,
    sandbox_network: network === 'none' ? 'none' : undefined,
    path_resolution: 'remote',
    path_missing: canAsk
      ? path => {
          asked.push(path);
          return Promise.resolve(!existing.includes(path));
        }
      : undefined,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: ROOT,
    agent_intent: 'make a small script',
    web_search: createWebSearchTurnState(),
  };
  return { ctx, asked };
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

function createPatch(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    '+one',
    '',
  ].join('\n');
}

function editPatch(file: string): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '-one', '+two', ''].join(
    '\n',
  );
}

describe('file writes in a sandbox the server cannot see, with the switch on', () => {
  test('a new file is written without a card', async () => {
    const { ctx, asked } = remoteSandbox({ services: servicesWith({ sandbox_without_asking: true }), existing: [] });
    const decision = await classifyTier(action('write_file', { path: 'src/app.py', content: 'print(1)' }), ctx);
    expect(decision.tier).toBe(1);
    expect(decision.reason).toBe('sandbox_file_write');
    expect(asked).toEqual([`${ROOT}/src/app.py`]);
  });

  test('a file that is already there keeps its card', async () => {
    const { ctx } = remoteSandbox({
      services: servicesWith({ sandbox_without_asking: true }),
      existing: [`${ROOT}/README.md`],
    });
    for (const call of [
      action('write_file', { path: 'README.md', content: 'changed' }),
      action('replace_text', { path: 'README.md', old_text: 'a', new_text: 'b' }),
      action('apply_patch', { patch: editPatch('README.md'), cwd: ROOT }),
    ]) {
      const decision = await classifyTier(call, ctx);
      expect(decision.tier).toBe(2);
      expect(decision.card).not.toBeNull();
    }
  });

  test('a file Aman created in this chat is edited without a card', async () => {
    const services = servicesWith({ sandbox_without_asking: true });
    const { ctx } = remoteSandbox({ services, existing: [`${ROOT}/notes.py`] });
    services.tracked_store.track({
      scope: { tenant_id: 't1', created_by: 'u1', conversation_id: 'conv-1', repository_id: null, workspace_cwd: ROOT },
      file_identity: `${ROOT}/notes.py`,
    });
    const decision = await classifyTier(
      action('replace_text', { path: './notes.py', old_text: 'a', new_text: 'b' }),
      ctx,
    );
    expect(decision.tier).toBe(1);
    expect(decision.card).toBeNull();
  });

  test('a patch runs without a card only when every file it touches is new', async () => {
    const services = servicesWith({ sandbox_without_asking: true });
    const allNew = remoteSandbox({ services, existing: [] });
    const created = await classifyTier(
      action('apply_patch', { patch: createPatch('a.py') + createPatch('b.py'), cwd: ROOT }),
      allNew.ctx,
    );
    expect(created.tier).toBe(1);

    const mixed = remoteSandbox({ services, existing: [`${ROOT}/README.md`] });
    const edited = await classifyTier(
      action('apply_patch', { patch: createPatch('a.py') + editPatch('README.md'), cwd: ROOT }),
      mixed.ctx,
    );
    expect(edited.tier).toBe(2);
  });

  test('a sandbox that cannot be asked keeps the card', async () => {
    const { ctx } = remoteSandbox({
      services: servicesWith({ sandbox_without_asking: true }),
      existing: [],
      canAsk: false,
    });
    const decision = await classifyTier(action('write_file', { path: 'app.py', content: 'print(1)' }), ctx);
    expect(decision.tier).toBe(2);
  });

  test('a sandbox that can reach a network keeps the card', async () => {
    const { ctx } = remoteSandbox({
      services: servicesWith({ sandbox_without_asking: true }),
      existing: [],
      network: 'reachable',
    });
    const decision = await classifyTier(action('write_file', { path: 'app.py', content: 'print(1)' }), ctx);
    expect(decision.tier).toBe(2);
  });

  test.each([
    ['a Git control file', '.git/hooks/pre-commit', 'git_control_write'],
    ['a file outside the workspace', '/etc/demo', 'write_outside_workspace'],
    ['a file in a folder of programs', '.venv/bin/tool', 'sandbox_tool_write'],
  ])('%s always asks, even though nothing is there yet', async (_name, path, reason) => {
    const { ctx, asked } = remoteSandbox({ services: servicesWith({ sandbox_without_asking: true }), existing: [] });
    const decision = await classifyTier(action('write_file', { path, content: 'x' }), ctx);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe(reason);
    expect(asked).toEqual([]);
  });
});

describe('file writes in a sandbox the server cannot see, with the switch off', () => {
  test('a new file asks, and the sandbox is not asked about it', async () => {
    const { ctx, asked } = remoteSandbox({ services: servicesWith({ sandbox_without_asking: false }), existing: [] });
    const decision = await classifyTier(action('write_file', { path: 'app.py', content: 'print(1)' }), ctx);
    expect(decision.tier).toBe(2);
    expect(decision.card).not.toBeNull();
    expect(asked).toEqual([]);
  });
});
