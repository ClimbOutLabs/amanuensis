import { isCallToolResponseResult, type CallToolResponse } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  Sandbox,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
} from '../../../src/core/sandbox/Sandbox';
import { SandboxFileNotFoundError } from '../../../src/core/sandbox/SandboxErrors';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const ROOT = '/workspace';

/** A sandbox whose files the server cannot see. `existing` is what it holds; a file is read only through the provider. */
function makeSandbox(existing: Set<string>): Sandbox {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.sandboxWithoutAsking = () => Promise.resolve(true);
  const provider: SandboxProvider = {
    type: 'local',
    filesystem: 'remote',
    network: 'none',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => ROOT,
    getToolResultDumpDir: () => `${ROOT}/.tool-results`,
    getGitCredentialsPath: () => `${ROOT}/.git-credentials`,
    getFileUploadsDir: () => `${ROOT}/uploads`,
    getSkillsDir: () => `${ROOT}/skills`,
    getSkillDownloaderPath: () => `${ROOT}/git_downloader.py`,
    downloadFile: params => {
      if (!existing.has(params.path)) {
        return Promise.reject(new SandboxFileNotFoundError(params.path));
      }
      return Promise.resolve(Buffer.from('text'));
    },
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    // Path lookups answer with the workspace root; every other command just succeeds.
    exec: (params): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: { exitCode: 0, result: params.command.includes('realpath') ? ROOT : '{}' },
      }),
  };
  return new Sandbox({
    provider,
    existingSandboxId: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: ROOT,
      services,
    }),
  });
}

function write(path: string): { name: string; arguments: Record<string, unknown> } {
  return { name: SANDBOX_WRITE_FILE_TOOL_NAME, arguments: { intent: 'add a file', path, content: 'print(1)' } };
}

function edit(path: string): { name: string; arguments: Record<string, unknown> } {
  return {
    name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
    arguments: { intent: 'change a line', cwd: ROOT, path, old_text: 'print(1)', new_text: 'print(2)' },
  };
}

/** The tier the call was given, read from what the sandbox hands the approval layer. */
function tierOf(response: CallToolResponse): number | undefined {
  return 'approvalRequired' in response ? response.approvalRequired.tool_info.tier : undefined;
}

describe('file writes in a sandbox the server cannot see, with the switch on', () => {
  it('asks the sandbox, and creates a new file without a card', async () => {
    const sandbox = makeSandbox(new Set([`${ROOT}/README.md`]));
    expect(tierOf(await sandbox.callTool(write('app.py')))).toBe(1);
    expect(tierOf(await sandbox.callTool(write('README.md')))).toBe(2);
  });

  it('remembers a file it created, so a later edit to it needs no card', async () => {
    const existing = new Set([`${ROOT}/README.md`]);
    const sandbox = makeSandbox(existing);

    const written = await sandbox.callTool(write('app.py'), { status: 'allow' });
    expect(isCallToolResponseResult(written) && written.result.isError !== true).toBe(true);
    existing.add(`${ROOT}/app.py`);

    expect(tierOf(await sandbox.callTool(edit('app.py')))).toBe(1);
    expect(tierOf(await sandbox.callTool(edit('README.md')))).toBe(2);
  });

  it('does not remember a file that was already there when it wrote to it', async () => {
    const existing = new Set([`${ROOT}/README.md`]);
    const sandbox = makeSandbox(existing);
    await sandbox.callTool(write('README.md'), { status: 'allow' });
    expect(tierOf(await sandbox.callTool(edit('README.md')))).toBe(2);
  });
});
