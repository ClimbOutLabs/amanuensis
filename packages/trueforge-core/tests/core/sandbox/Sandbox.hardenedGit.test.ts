import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function git(cwd: string, args: string[]): void {
  execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, stdio: 'ignore' });
}

interface Fixture {
  repo: string;
  marker: string;
  pinnedDir: string;
  cleanup: () => void;
}

/** A repo whose own config points fsmonitor, pager, external diff and textconv at a marker-writing script. */
function maliciousRepoFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-git-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'marker');
  const script = join(root, 'payload.sh');
  mkdirSync(repo);
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat >/dev/null 2>&1\n`);
  chmodSync(script, 0o755);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  git(repo, ['add', 'f.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'f.txt'), 'two\n');
  writeFileSync(join(repo, '.gitattributes'), '* diff=evil\n');
  git(repo, ['config', 'core.fsmonitor', script]);
  git(repo, ['config', 'core.pager', script]);
  git(repo, ['config', 'diff.external', script]);
  git(repo, ['config', 'diff.evil.textconv', script]);
  const pinnedDir = join(root, 'bin');
  mkdirSync(pinnedDir);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(realGit, join(pinnedDir, 'git'));
  return { repo, marker, pinnedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function realShellProvider(): SandboxProvider {
  return {
    type: 'local',
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-hardened-git' }),
    exec: (params: SandboxExecParams): Promise<ExecResult> => {
      // Only the model-facing git command runs for real; Sandbox bookkeeping calls are stubbed.
      if (!/\bgit\b.* (status|log|diff|show|blame)\b/u.test(params.command)) {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '' } });
      }
      try {
        const out = execFileSync('sh', ['-c', params.command], {
          cwd: params.cwd,
          env: { ...process.env, ...params.env },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return Promise.resolve({ success: true, response: { exitCode: 0, result: out } });
      } catch (error) {
        return Promise.resolve({ success: true, response: { exitCode: 1, result: String(error) } });
      }
    },
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

async function runExec(input: { fixture: Fixture; command: string }): Promise<{ isError: boolean }> {
  const sandbox = new Sandbox({
    provider: realShellProvider(),
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: input.fixture.repo,
      services: defaultSentinelServices({ pinned_path: input.fixture.pinnedDir }),
    }),
  });
  const result = await sandbox.callTool({
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: { intent: 'inspect', purpose: 'inspect', command: input.command, cwd: input.fixture.repo },
  });
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result, not an approval request');
  }
  return { isError: result.result.isError === true };
}

describe('allowlisted git execution ignores code-running repository config', () => {
  test('the fixture repo runs its payload when git is invoked without hardening', () => {
    const fixture = maliciousRepoFixture();
    try {
      execFileSync('git', ['status'], { cwd: fixture.repo, stdio: 'ignore' });
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test.each(['git status', 'git diff', 'git log --stat', 'git show HEAD', 'git blame f.txt'])(
    '%s through exec never runs the payload',
    async command => {
      const fixture = maliciousRepoFixture();
      try {
        const result = await runExec({ fixture, command });
        expect(result.isError).toBe(false);
        expect(existsSync(fixture.marker)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );
});
