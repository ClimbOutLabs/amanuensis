import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import {
  DEFAULT_GIT_COMMIT_IDENTITY,
  gitCommitIdentityEnv,
  GitCommitIdentitySchema,
  hasEnvBeyondCommitIdentity,
  type GitCommitIdentity,
} from '../../../src/core/sandbox/gitCommitIdentity';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function readyExec(): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
}

function makeSandbox(input: { execCalls: SandboxExecParams[]; identity: GitCommitIdentity | undefined }): Sandbox {
  const provider: SandboxProvider = {
    type: 'local',
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
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-1' }),
    exec: params => {
      input.execCalls.push(params);
      return readyExec();
    },
  };
  return new Sandbox({
    provider,
    existingSandboxId: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    gitCommitIdentity: input.identity,
  });
}

async function commitEnv(input: {
  identity: GitCommitIdentity | undefined;
  env?: Record<string, string>;
}): Promise<Record<string, string> | undefined> {
  const execCalls: SandboxExecParams[] = [];
  const result = await makeSandbox({ execCalls, identity: input.identity }).callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'save the work',
        purpose: 'execute',
        command: 'git commit -m "save"',
        cwd: '/tmp/raw-1',
        ...(input.env === undefined ? {} : { env: input.env }),
      },
    },
    { status: 'allow' },
  );
  if (!isCallToolResponseResult(result) || result.result.isError === true) {
    throw new Error(`expected a tool result: ${JSON.stringify(result)}`);
  }
  return execCalls.find(call => call.command.includes('git commit'))?.env;
}

describe('the name on commits made in the sandbox', () => {
  it('puts the chosen name and email on a plain commit', async () => {
    const env = await commitEnv({ identity: { name: 'Sidd Example', email: 'sidd@example.com' } });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'Sidd Example',
      GIT_AUTHOR_EMAIL: 'sidd@example.com',
      GIT_COMMITTER_NAME: 'Sidd Example',
      GIT_COMMITTER_EMAIL: 'sidd@example.com',
    });
  });

  it('falls back to the built-in name when none was chosen', async () => {
    const env = await commitEnv({ identity: undefined });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: DEFAULT_GIT_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: DEFAULT_GIT_COMMIT_IDENTITY.email,
    });
  });

  it('lets one command name a different author in its own environment', async () => {
    const env = await commitEnv({
      identity: { name: 'Sidd Example', email: 'sidd@example.com' },
      env: { GIT_AUTHOR_NAME: 'Pair Partner' },
    });
    expect(env?.['GIT_AUTHOR_NAME']).toBe('Pair Partner');
    expect(env?.['GIT_COMMITTER_NAME']).toBe('Sidd Example');
  });

  it('tells the commit name apart from other environment, so plain network Git still goes through the server', () => {
    const identityOnly = gitCommitIdentityEnv({ name: 'Sidd Example', email: 'sidd@example.com' });
    expect(hasEnvBeyondCommitIdentity(undefined)).toBe(false);
    expect(hasEnvBeyondCommitIdentity({})).toBe(false);
    expect(hasEnvBeyondCommitIdentity(identityOnly)).toBe(false);
    expect(hasEnvBeyondCommitIdentity({ ...identityOnly, GIT_SSL_NO_VERIFY: '1' })).toBe(true);
    expect(hasEnvBeyondCommitIdentity({ GIT_AUTHOR_DATE: 'now' })).toBe(true);
  });

  it('refuses a name or email that could break the commit header', () => {
    const ok = { name: 'Sidd Example', email: 'sidd@example.com' };
    expect(GitCommitIdentitySchema.safeParse(ok).success).toBe(true);
    expect(GitCommitIdentitySchema.safeParse({ ...ok, name: 'Sidd <x>' }).success).toBe(false);
    expect(GitCommitIdentitySchema.safeParse({ ...ok, name: 'Sidd\nExample' }).success).toBe(false);
    expect(GitCommitIdentitySchema.safeParse({ ...ok, name: '   ' }).success).toBe(false);
    expect(GitCommitIdentitySchema.safeParse({ ...ok, email: 'not an email' }).success).toBe(false);
    expect(GitCommitIdentitySchema.safeParse({ ...ok, email: 'a@b\n' + 'c' }).success).toBe(false);
  });
});
