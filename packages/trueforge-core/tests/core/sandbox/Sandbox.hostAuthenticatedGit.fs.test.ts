import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');
const CLONE_URL = 'https://github.com/acme/widgets';

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * A real directory stands in for the sandbox: ordinary commands run for real, and the host-built
 * network git process is emulated with the checkout state a real clone leaves behind (the validated URL).
 */
function makeProvider(root: string): SandboxProvider {
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    const cwd = params.cwd ?? root;
    if (params.env?.['TRUEFORGE_GIT_TOKEN'] !== undefined) {
      execFileSync('git', ['init', '-q', 'repo'], { cwd });
      execFileSync('git', ['remote', 'add', 'origin', CLONE_URL], { cwd: join(cwd, 'repo') });
      return Promise.resolve({ success: true, response: { exitCode: 0, result: '' } });
    }
    try {
      const out = execFileSync('sh', ['-c', params.command], {
        cwd,
        env: { ...process.env, ...params.env },
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
    createSandbox: () => Promise.resolve({ sandboxId: root }),
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

async function run(input: {
  sandbox: Sandbox;
  command: string;
  cwd: string;
  purpose: 'inspect' | 'edit';
}): Promise<string> {
  const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
  const result = await input.sandbox.callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'git work', purpose: input.purpose, command: input.command, cwd: input.cwd },
    },
    input.purpose === 'inspect' ? undefined : approval,
  );
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a silent tool result, not an approval request');
  }
  const content = result.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

describe('after a host-authenticated clone, nothing in the sandbox holds the token', () => {
  test('a silent read of .git/config, git remote -v and every file in the sandbox are credential-free', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-auth-git-'));
    try {
      const repo = join(root, 'repo');
      mkdirSync(repo);
      // A credential file left by an earlier release in a persisted sandbox.
      writeFileSync(join(root, '.git-credentials'), `https://x-access-token:${TOKEN}@github.com\n`);
      const sandbox = new Sandbox({
        provider: makeProvider(root),
        existingSandboxId: root,
        githubGitToken: TOKEN,
        githubConnectorAttached: true,
        blockDestructiveToolsInCodeMode: true,
        mcpRequestTimeoutMs: 60_000,
        mcpConnectTimeoutMs: 5_000,
        logger: makeSilentLogger(),
        tracing: NOOP_AGENT_TRACING,
        sentinel: createSentinelHostContext({
          tenant_id: 't1',
          created_by: 'u1',
          conversation_id: 'conv-1',
          workspace_cwd: repo,
          services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
        }),
      });

      await run({ sandbox, command: `git clone ${CLONE_URL} repo`, cwd: root, purpose: 'edit' });
      const config = await run({ sandbox, command: 'cat .git/config', cwd: repo, purpose: 'inspect' });
      const remote = await run({ sandbox, command: 'git remote -v', cwd: repo, purpose: 'edit' });

      expect(config).toContain(CLONE_URL);
      expect(remote).toContain(CLONE_URL);
      for (const output of [config, remote]) {
        expect(output).not.toContain(TOKEN);
        expect(output).not.toContain('x-access-token');
      }
      for (const file of filesUnder(root)) {
        const bytes = readFileSync(file);
        expect(bytes.includes(TOKEN)).toBe(false);
        expect(bytes.includes(Buffer.from(TOKEN).toString('base64'))).toBe(false);
      }
      expect(filesUnder(root).some(file => file.endsWith('.git-credentials'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
