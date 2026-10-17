import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox, type BoundRepository } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

interface Fixture {
  root: string;
  repo: string;
  marker: string;
  script: string;
  pinnedDir: string;
  cleanup: () => void;
}

function repoFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-capture-')));
  const repo = join(root, 'repo');
  const marker = join(root, 'marker');
  const script = join(root, 'payload.sh');
  mkdirSync(repo);
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
  chmodSync(script, 0o755);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  git(repo, ['add', 'f.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'f.txt'), 'two\n');
  const pinnedDir = join(root, 'bin');
  mkdirSync(pinnedDir);
  for (const program of ['git', 'ls', 'mkdir', 'rm']) {
    const resolved = execFileSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).trim();
    symlinkSync(resolved, join(pinnedDir, program));
  }
  return { root, repo, marker, script, pinnedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function realProvider(fixture: Fixture, seen: SandboxExecParams[], shellPath?: string): SandboxProvider {
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    seen.push(params);
    try {
      // Older git binaries (before 2.48) lack --include-root-refs; the ref list is not under test here.
      const out = execFileSync('sh', ['-c', params.command.replace(' --include-root-refs', '')], {
        cwd: params.cwd ?? fixture.repo,
        env: { ...process.env, ...(shellPath === undefined ? {} : { PATH: shellPath }), ...params.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return Promise.resolve({ success: true, response: { exitCode: 0, result: out } });
    } catch (error) {
      return Promise.resolve({ success: true, response: { exitCode: 1, result: String(error) } });
    }
  };
  return {
    type: 'local',
    createSandbox: () => Promise.resolve({ sandboxId: join(fixture.root, 'sandbox') }),
    exec,
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/git_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function boundSandbox(fixture: Fixture, provider: SandboxProvider): Sandbox {
  const bound: BoundRepository = { repository_id: 'repo-1', revision: 1, workspace_cwd: fixture.repo, commands: [] };
  return new Sandbox({
    provider,
    boundRepository: bound,
    loadBoundRepository: () => Promise.resolve(bound),
    workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: 'test-replica',
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: fixture.repo,
      services: defaultSentinelServices({ pinned_path: fixture.pinnedDir }),
    }),
  });
}

async function run(input: { sandbox: Sandbox; fixture: Fixture; command: string; purpose: 'inspect' | 'verify' }) {
  const result = await input.sandbox.callTool({
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: {
      intent: 'check the tree',
      purpose: input.purpose,
      command: input.command,
      cwd: input.fixture.repo,
    },
  });
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result, not an approval request');
  }
  const content = result.result.content[0];
  return { isError: result.result.isError === true, text: content?.type === 'text' ? content.text : '' };
}

const PROGRAM_CONFIGS: { name: string; setup: (fixture: Fixture) => void }[] = [
  { name: 'core.fsmonitor', setup: f => git(f.repo, ['config', 'core.fsmonitor', f.script]) },
  {
    name: 'a clean filter',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=x\n');
      git(f.repo, ['config', 'filter.x.clean', f.script]);
    },
  },
];

describe('verification state capture in a bound repository', () => {
  test.each(PROGRAM_CONFIGS)('purpose verify never runs a program named by $name', async ({ setup }) => {
    const fixture = repoFixture();
    try {
      setup(fixture);
      rmSync(fixture.marker, { force: true });
      const seen: SandboxExecParams[] = [];
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, seen)),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(existsSync(fixture.marker)).toBe(false);
      expect(result.isError).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('every git call the capture makes runs hardened and by absolute path', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, seen)),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(result.isError).toBe(false);
      const diffs = seen.filter(params => /\bdiff\b/u.test(params.command));
      expect(diffs.length).toBeGreaterThan(0);
      for (const params of diffs) {
        expect(params.command).toContain(`${fixture.pinnedDir}/git`);
        expect(params.command).toContain('core.fsmonitor=false');
        expect(params.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('purpose inspect is unaffected by the capture guard', async () => {
    const fixture = repoFixture();
    try {
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, [])),
        fixture,
        command: 'git status',
        purpose: 'inspect',
      });
      expect(result.isError).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('host bookkeeping never runs a program planted ahead of the pinned PATH', async () => {
    const fixture = repoFixture();
    try {
      const planted = join(fixture.root, 'planted');
      mkdirSync(planted);
      for (const program of ['git', 'mkdir', 'rm', 'realpath', 'python3']) {
        writeFileSync(join(planted, program), `#!/bin/sh\necho "${program}" >> '${fixture.marker}'\nexit 1\n`);
        chmodSync(join(planted, program), 0o755);
      }
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, [], `${planted}:${process.env['PATH'] ?? ''}`)),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(existsSync(fixture.marker)).toBe(false);
      expect(result.isError).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
