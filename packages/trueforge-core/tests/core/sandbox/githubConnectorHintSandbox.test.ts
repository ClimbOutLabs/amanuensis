import type { ApprovalDecision } from '../../../src/core/events/schema';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { GITHUB_CONNECTOR_MISSING_HINT } from '../../../src/core/sandbox/githubConnectorHint';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function parseRemediation(text: string): string | undefined {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('remediation' in parsed)) {
    return undefined;
  }
  const { remediation } = parsed as { remediation: unknown };
  return typeof remediation === 'string' ? remediation : undefined;
}

function makeProvider(exec: SandboxProvider['exec']): SandboxProvider {
  return {
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
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/gh-hint' }),
    exec,
  };
}

describe('Sandbox github connector remediation', () => {
  it('carries the missing-connector remediation on a failed github clone with no connector attached', async () => {
    const failingResult: ExecResult = {
      success: true,
      response: {
        exitCode: 128,
        result: "fatal: could not read Username for 'https://github.com': No such device or address",
      },
    };
    const successResult: ExecResult = { success: true, response: { exitCode: 0, result: '' } };
    const provider = makeProvider(params =>
      Promise.resolve(params.command.includes('git clone') ? failingResult : successResult),
    );
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
      // githubConnectorAttached intentionally omitted (defaults to false)
    });
    const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
    const result = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'clone the repo',
          purpose: 'edit',
          command: 'git clone https://github.com/acme/widgets',
        },
      },
      approval,
    );
    if (!isCallToolResponseResult(result)) {
      throw new Error('expected tool result');
    }
    const text = result.result.content[0];
    if (text?.type !== 'text') {
      throw new Error('expected text content');
    }
    expect(parseRemediation(text.text)).toBe(GITHUB_CONNECTOR_MISSING_HINT);
  });

  it('carries no remediation when the sandbox infra call itself fails, even with a github-shaped status in the error', async () => {
    const infraFailure: ExecResult = {
      success: false,
      error: 'Sandbox server returned 401: upstream provider rejected the request',
    };
    const successResult: ExecResult = { success: true, response: { exitCode: 0, result: '' } };
    const provider = makeProvider(params =>
      Promise.resolve(params.command.includes('git clone') ? infraFailure : successResult),
    );
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
      githubConnectorAttached: false,
    });
    const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
    const result = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'clone the repo',
          purpose: 'edit',
          command: 'git clone https://github.com/acme/widgets',
        },
      },
      approval,
    );
    if (!isCallToolResponseResult(result)) {
      throw new Error('expected tool result');
    }
    const text = result.result.content[0];
    if (text?.type !== 'text') {
      throw new Error('expected text content');
    }
    expect(parseRemediation(text.text)).toBeUndefined();
  });
});
