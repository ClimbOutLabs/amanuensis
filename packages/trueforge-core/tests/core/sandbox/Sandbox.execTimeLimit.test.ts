import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  createSandboxExecDescription,
  Sandbox,
  SANDBOX_EXEC_MAX_TIMEOUT_SECONDS,
  SANDBOX_EXEC_TOOL_NAME,
  sandboxExecSchema,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function readyExec(): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
}

function makeSandbox(execCalls: SandboxExecParams[]): Sandbox {
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
      execCalls.push(params);
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
  });
}

async function runExec(sandbox: Sandbox, extra: Record<string, unknown>): Promise<void> {
  const result = await sandbox.callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'run the tests', purpose: 'execute', command: 'npm test', cwd: '/tmp/raw-1', ...extra },
    },
    { status: 'allow' },
  );
  if (!isCallToolResponseResult(result) || result.result.isError === true) {
    throw new Error(`expected a tool result: ${JSON.stringify(result)}`);
  }
}

describe('a shell command can ask for more time', () => {
  it('passes the time limit the call asks for to the sandbox', async () => {
    const execCalls: SandboxExecParams[] = [];
    await runExec(makeSandbox(execCalls), { timeout_seconds: 300 });
    const run = execCalls.find(call => call.command.includes('npm test'));
    expect(run?.timeoutSeconds).toBe(300);
  });

  it('leaves the sandbox default in place when the call names no limit', async () => {
    const execCalls: SandboxExecParams[] = [];
    await runExec(makeSandbox(execCalls), {});
    const run = execCalls.find(call => call.command.includes('npm test'));
    expect(run).toBeDefined();
    expect(run?.timeoutSeconds).toBeUndefined();
  });

  it('accepts a limit up to the cap and refuses one past it, or below one second', () => {
    const base = { intent: 'x', purpose: 'execute', command: 'npm test' };
    expect(sandboxExecSchema.safeParse({ ...base, timeout_seconds: SANDBOX_EXEC_MAX_TIMEOUT_SECONDS }).success).toBe(
      true,
    );
    expect(
      sandboxExecSchema.safeParse({ ...base, timeout_seconds: SANDBOX_EXEC_MAX_TIMEOUT_SECONDS + 1 }).success,
    ).toBe(false);
    expect(sandboxExecSchema.safeParse({ ...base, timeout_seconds: 0 }).success).toBe(false);
    expect(sandboxExecSchema.safeParse({ ...base, timeout_seconds: 1.5 }).success).toBe(false);
  });

  it('tells the model the default and how to raise it', () => {
    const description = createSandboxExecDescription({ offline: true, fileDownload: false });
    expect(description).toContain('Stops after 60s; set timeout_seconds (up to 600)');
  });
});
