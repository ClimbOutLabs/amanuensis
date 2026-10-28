import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function makeProvider(exec: jest.Mock<Promise<ExecResult>, [SandboxExecParams]>): SandboxProvider {
  return {
    type: 'test',
    network: 'none',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec,
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => '/work',
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(input: { audit: AuditRecordInput[] | null }): Sandbox {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  if (input.audit !== null) {
    const records = input.audit;
    services.audit = {
      record: record => {
        records.push(record);
        return Promise.resolve();
      },
    };
  }
  return new Sandbox({
    provider: makeProvider(jest.fn<Promise<ExecResult>, [SandboxExecParams]>()),
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: '/work',
      services,
    }),
  });
}

const NETWORK_CALL = {
  name: SANDBOX_EXEC_TOOL_NAME,
  arguments: { intent: 'Fetch a page', purpose: 'execute', command: 'curl https://example.com' },
};

describe('audit rows for sandbox commands refused before they run', () => {
  it('writes exactly one auto_denied row carrying the refusal, and answers exactly as before', async () => {
    const records: AuditRecordInput[] = [];
    const sandbox = makeSandbox({ audit: records });

    const response = await sandbox.callTool(NETWORK_CALL);

    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(true);
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected a text tool result');
    expect(content.text).toContain('offline by design');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      tier: 3,
      tool_name: SANDBOX_EXEC_TOOL_NAME,
      outcome: 'auto_denied',
      auto_deny_reason: null,
    });
    expect(records[0]?.description).toContain('offline by design');
    expect(records[0]?.description).toBe(JSON.parse(content.text).error);
  });

  it('writes nothing when no audit writer is configured, and still refuses', async () => {
    const sandbox = makeSandbox({ audit: null });

    const response = await sandbox.callTool(NETWORK_CALL);

    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(true);
  });
});
