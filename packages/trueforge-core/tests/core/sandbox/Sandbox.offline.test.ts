import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { PACKAGE_UNAVAILABLE_RULE } from '../../../src/core/sandbox/packageMirrors';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, SANDBOX_RUN_CODE_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

class TestSandbox extends Sandbox {
  public listToolsForTest() {
    return this.getTools();
  }
}

function makeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  const exec =
    overrides.exec ??
    ((): Promise<ExecResult> => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }));
  return {
    type: 'test',
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
    ...overrides,
  };
}

function makeSandbox(provider: SandboxProvider): TestSandbox {
  return new TestSandbox({
    provider,
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

function toolDescription(sandbox: TestSandbox, name: string): string {
  return sandbox.listToolsForTest().find(tool => tool.name === name)?.description ?? '';
}

const OFFLINE_SENTENCE = 'has no internet access. Never use it to fetch web content.';

describe('sandbox tool descriptions follow the provider network', () => {
  it('say plainly that an offline provider has no internet and list only what is installed', () => {
    const sandbox = makeSandbox(makeProvider({ network: 'none' }));
    const exec = toolDescription(sandbox, SANDBOX_EXEC_TOOL_NAME);
    const runCode = toolDescription(sandbox, SANDBOX_RUN_CODE_TOOL_NAME);

    expect(exec).toContain(`This shell ${OFFLINE_SENTENCE}`);
    expect(exec).not.toContain('Network egress');
    expect(exec).not.toContain('retrieval');
    expect(runCode).toContain(`This sandbox ${OFFLINE_SENTENCE}`);
    expect(runCode).not.toContain('requests');
    expect(runCode).not.toContain('beautifulsoup4');
    expect(runCode).toContain('pandas');
    expect(runCode).toContain('If a network call fails, do not retry it through exec or any shell.');
  });

  it('give run_code and the slot prompt the same rule for a package that cannot be downloaded', () => {
    const sandbox = makeSandbox(makeProvider({ network: 'none' }));
    const runCode = toolDescription(sandbox, SANDBOX_RUN_CODE_TOOL_NAME);

    expect(runCode).toContain(`Packages cannot be downloaded here, so if one is missing, ${PACKAGE_UNAVAILABLE_RULE}`);
    expect(runCode).not.toContain('instead of installing it');
  });

  it('keep the existing wording when the provider may have a network', () => {
    const sandbox = makeSandbox(makeProvider());
    const exec = toolDescription(sandbox, SANDBOX_EXEC_TOOL_NAME);
    const runCode = toolDescription(sandbox, SANDBOX_RUN_CODE_TOOL_NAME);

    expect(exec).toContain('Exec provides retrieval of an already identified public source');
    expect(exec).toContain('Network egress requires PermissionGate admission.');
    expect(exec).not.toContain(OFFLINE_SENTENCE);
    expect(runCode).toContain('requests');
    expect(runCode).not.toContain(OFFLINE_SENTENCE);
  });

  it('keeps the sandbox prompt free of an offline notice for a provider that has a network', () => {
    const builder = new InstructionBuilder('root');
    makeSandbox(makeProvider()).buildInstruction(builder);
    expect(builder.build()).not.toContain('No network from code or the shell');
  });
});

describe('exec on a provider with no network', () => {
  const networkCommands = [
    'curl https://example.com',
    'wget https://example.com/file.txt',
    'curl -sS https://example.com | head -5',
    'timeout 10 curl https://example.com',
    'ssh host ls',
  ];

  it.each(networkCommands)('refuses %s before any approval and never runs it', async command => {
    const exec = jest.fn<Promise<ExecResult>, [SandboxExecParams]>();
    const sandbox = makeSandbox(makeProvider({ network: 'none', exec }));
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Fetch a page', purpose: 'execute', command },
    };

    const info = await sandbox.toolCallInfo(call);
    expect(info.is_approval_required).toBe(false);
    expect(info.tier3_card).toBeUndefined();

    const response = await sandbox.callTool(call);
    expect(isCallToolResponseResult(response)).toBe(true);
    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(true);
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected a text tool result');
    expect(content.text).toContain('offline by design');
    expect(content.text).toContain('do not try another tool');
    expect(content.text).toContain('Tell the user in plain words that you cannot open websites from here.');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses an inline Python network call without an approval request', async () => {
    const exec = jest.fn<Promise<ExecResult>, [SandboxExecParams]>();
    const sandbox = makeSandbox(makeProvider({ network: 'none', exec }));
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Fetch a page',
        purpose: 'execute',
        command: `python3 -c "import urllib.request; print(urllib.request.urlopen('https://example.com').read())"`,
      },
    };

    const info = await sandbox.toolCallInfo(call);
    expect(info.is_approval_required).toBe(false);
    const response = await sandbox.callTool(call);
    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats offline-safe commands exactly as a provider with a network does', async () => {
    const offline = makeSandbox(makeProvider({ network: 'none' }));
    const online = makeSandbox(makeProvider());
    for (const command of ['ls', 'python3 script.py', 'git status --short']) {
      const call = { name: SANDBOX_EXEC_TOOL_NAME, arguments: { intent: 'Work', purpose: 'execute', command } };
      const offlineInfo = await offline.toolCallInfo(call);
      const onlineInfo = await online.toolCallInfo(call);
      expect(offlineInfo.is_approval_required).toBe(onlineInfo.is_approval_required);
      expect(offlineInfo.pre_dispatch_failure).toBeUndefined();
    }
  });

  it('still asks for approval on a network command when the provider has a network', async () => {
    const sandbox = makeSandbox(makeProvider());
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Fetch a page', purpose: 'execute', command: 'curl https://example.com' },
    });
    expect(info.is_approval_required).toBe(true);
    expect(info.open_world_hint).toBe(true);
  });
});
