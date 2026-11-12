import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { RunCodeBackend, RunCodeCallOptions } from '../../../src/core/sandbox/driver/RunCodeService';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, SANDBOX_RUN_CODE_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { realCommandExec } from './realCommandExec';

/** The worked example from the design: a code skill whose sites are the two GitHub hosts. */
const GRANT = { token: 'a'.repeat(32), hosts: ['api.github.com', 'github.com'] };

const CURL_CALL = {
  name: SANDBOX_EXEC_TOOL_NAME,
  arguments: { intent: 'Read the repository page', purpose: 'execute', command: 'curl https://github.com' },
};

class TestSandbox extends Sandbox {
  public listToolsForTest() {
    return this.getTools();
  }
}

function makeProvider(execCalls: SandboxExecParams[]): SandboxProvider {
  return {
    type: 'test',
    network: 'none',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec((params: SandboxExecParams): Promise<ExecResult> => {
      execCalls.push(params);
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
    }),
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

function makeSandbox(input: {
  execCalls: SandboxExecParams[];
  granted: () => boolean;
  runCodeService?: RunCodeBackend | undefined;
}): TestSandbox {
  return new TestSandbox({
    provider: makeProvider(input.execCalls),
    loadSkillNetworkGrant: async () => (input.granted() ? GRANT : undefined),
    runCodeService: input.runCodeService,
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

describe('the exec description with a skill network grant', () => {
  it('names the approved sites instead of calling the shell offline', async () => {
    const sandbox = makeSandbox({ execCalls: [], granted: () => true });
    await sandbox.listTools();
    const exec = toolDescription(sandbox, SANDBOX_EXEC_TOOL_NAME);
    expect(exec).toContain(
      'This shell can reach only the sites approved for the skills in this chat: api.github.com, github.com.',
    );
    expect(exec).not.toContain('has no internet access');
  });

  it('keeps the plain offline wording when no skill has approved sites', async () => {
    const sandbox = makeSandbox({ execCalls: [], granted: () => false });
    await sandbox.listTools();
    const exec = toolDescription(sandbox, SANDBOX_EXEC_TOOL_NAME);
    expect(exec).toContain('This shell has no internet access. Never use it to fetch web content.');
    expect(exec).not.toContain('approved for the skills');
  });

  it('keeps run_code described as offline under a grant: the grant is for shell commands', async () => {
    const sandbox = makeSandbox({ execCalls: [], granted: () => true });
    await sandbox.listTools();
    const runCode = toolDescription(sandbox, SANDBOX_RUN_CODE_TOOL_NAME);
    expect(runCode).toContain('This sandbox has no internet access.');
  });
});

describe('exec preflight with a skill network grant', () => {
  it('does not refuse a network command as offline, and the approved call runs with the grant', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({ execCalls, granted: () => true });
    await sandbox.listTools();

    const info = await sandbox.toolCallInfo(CURL_CALL);
    expect(info.pre_dispatch_failure).toBeUndefined();
    // Not refused: the call goes to the approval card, exactly as on a provider with a network.
    expect(info.is_approval_required).toBe(true);

    const response = await sandbox.callTool(CURL_CALL, { status: 'allow' });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(false);
    const curlExec = execCalls.find(params => params.command === 'curl https://github.com');
    expect(curlExec?.skillNetworkToken).toBe(GRANT.token);
    expect(curlExec?.skillNetworkHosts).toEqual(['api.github.com', 'github.com']);
  });

  it('refuses the same command as offline when the grant is gone, and never runs it', async () => {
    const execCalls: SandboxExecParams[] = [];
    let granted = true;
    const sandbox = makeSandbox({ execCalls, granted: () => granted });
    await sandbox.listTools();

    // The approval is removed in Settings; the next turn's tool list reads that, and the
    // refusal is back: revoking ends reachability on the next run.
    granted = false;
    await sandbox.listTools();

    const info = await sandbox.toolCallInfo(CURL_CALL);
    // An impossible action must not reach an approval card: no approval is asked for.
    expect(info.is_approval_required).toBe(false);
    expect(info.tier3_card).toBeUndefined();

    const response = await sandbox.callTool(CURL_CALL);
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(true);
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected a text tool result');
    expect(content.text).toContain('offline by design');
    expect(execCalls.some(params => params.command === 'curl https://github.com')).toBe(false);
  });

  it('still refuses other offline-only behaviour a grant does not cover: interpreter network calls stay refused by the interpreter guard', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({ execCalls, granted: () => true });
    await sandbox.listTools();
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Fetch a page',
        purpose: 'execute',
        command: `python3 -c "import urllib.request; print(urllib.request.urlopen('https://github.com').read())"`,
      },
    };
    const response = await sandbox.callTool(call);
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(execCalls).toHaveLength(0);
  });
});

describe('run_code under a skill network grant', () => {
  it('hands the run_code backend no skill network token: run_code stays fully offline', async () => {
    const seenOptions: (RunCodeCallOptions | undefined)[] = [];
    const runCodeService: RunCodeBackend = {
      packageGatewayCapable: false,
      runCode: (_rawInput, options) => {
        seenOptions.push(options);
        return Promise.resolve({
          status: 'ok',
          stdout: 'done\n',
          stderr: '',
          stdout_truncated: false,
          stderr_truncated: false,
          exit_code: 0,
          files_out: [],
          harvest_warnings: [],
        });
      },
      scrubDispatchErrorText: text => text,
    };
    const sandbox = makeSandbox({ execCalls: [], granted: () => true, runCodeService });
    await sandbox.listTools();

    const info = await sandbox.toolCallInfo({
      name: SANDBOX_RUN_CODE_TOOL_NAME,
      arguments: { language: 'python', code: 'print("hi")' },
    });
    expect(info.pre_dispatch_failure).toBeUndefined();
    const response = await sandbox.callTool(
      { name: SANDBOX_RUN_CODE_TOOL_NAME, arguments: { language: 'python', code: 'print("hi")' } },
      { status: 'allow' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(seenOptions).toHaveLength(1);
    const options = seenOptions[0];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('skillNetworkToken');
    expect(options?.packageMirrorToken).toBeUndefined();
  });
});
