import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls, type ToolCallResult } from '../../../src/core/mcp/executeToolCalls';
import type { RunCodeResult } from '../../../src/core/sandbox/driver/RunCodeSchemas';
import type { RunCodeBackend, RunCodeCallOptions } from '../../../src/core/sandbox/driver/RunCodeService';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_DESCRIPTION,
  SANDBOX_RUN_CODE_TOOL_NAME,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function readyExec(result = 'ok'): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result } });
}

function makeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  const exec = overrides.exec ?? (() => readyExec());
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec,
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async params => ({
      status: 'completed',
      result: await exec({
        sandboxId: params.sandboxId,
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
        workspaceLock: { workspaceRoot: params.workspaceRoot },
      }),
    }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
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

function makeRunCodeService(
  runCodeImpl?: (rawInput: unknown, options?: RunCodeCallOptions) => Promise<RunCodeResult>,
): {
  service: RunCodeBackend;
  runCode: jest.Mock;
} {
  const runCode = jest.fn<Promise<RunCodeResult>, [unknown, (RunCodeCallOptions | undefined)?]>(
    runCodeImpl ??
      (() =>
        Promise.resolve({
          status: 'ok',
          stdout: '42\n',
          stderr: '',
          stdout_truncated: false,
          stderr_truncated: false,
          exit_code: 0,
          files_out: [],
          harvest_warnings: [],
        })),
  );
  return {
    service: {
      runCode,
      scrubDispatchErrorText: (text: string): string => text,
    },
    runCode,
  };
}

/** Exposes the protected tool list so tests can assert the dynamic run_code description. */
class TestSandbox extends Sandbox {
  public listToolsForTest() {
    return this.getTools();
  }
}

function makeSandbox(provider: SandboxProvider, runCodeService?: RunCodeBackend): TestSandbox {
  return new TestSandbox({
    provider,
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    ...(runCodeService === undefined ? {} : { runCodeService }),
  });
}

async function executeSingleTool(input: {
  sandbox: Sandbox;
  toolName: string;
  mappedName: string;
  id: string;
  arguments: Record<string, unknown>;
}): Promise<ToolCallResult> {
  const toolInfo = await input.sandbox.toolCallInfo({ name: input.toolName, arguments: input.arguments });
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: input.id,
        type: 'function',
        function: { name: input.mappedName, arguments: JSON.stringify(input.arguments) },
        tool_info: toolInfo,
      },
    ],
  };
  const outcome = await executeToolCalls({
    assistantMessage,
    toolMapping: new Map([[input.mappedName, { toolSet: input.sandbox, originalToolName: input.toolName }]]),
    threadId: 'main',
    approvalDecisions: new Map([[input.id, { status: 'allow', scope: 'once' }]]),
    memoState: createToolCallMemoState(),
  });
  const result = outcome.toolCallResults[0];
  if (result === undefined) {
    throw new Error('Expected one tool call result');
  }
  return result;
}

function okRunCodeResult(): RunCodeResult {
  return {
    status: 'ok',
    stdout: 'done\n',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    exit_code: 0,
    files_out: [{ name: 'chart.png', size_bytes: 1234, sha256: 'a'.repeat(64) }],
    harvest_warnings: [],
  };
}

describe('Sandbox run_code tool', () => {
  it('words the failure guidance in plain punctuation, with no em dashes', () => {
    const guidance = SANDBOX_RUN_CODE_DESCRIPTION.split('\n').find(line => line.startsWith('If run_code fails'));
    expect(guidance).toBeDefined();
    expect(guidance).not.toContain('\u2014');
  });

  it('registers run_code and dispatches to the RunCodeService', async () => {
    const { service, runCode } = makeRunCodeService(async () => okRunCodeResult());
    const sandbox = makeSandbox(makeProvider(), service);

    const result = await executeSingleTool({
      sandbox,
      toolName: SANDBOX_RUN_CODE_TOOL_NAME,
      mappedName: SANDBOX_RUN_CODE_TOOL_NAME,
      id: 'call-1',
      arguments: { language: 'python', code: 'print("hi")' },
    });

    expect(result.disposition).toBe('executed_ok');
    expect(runCode).toHaveBeenCalledTimes(1);
    const parsed: unknown = JSON.parse(result.rawContent);
    expect(parsed).toMatchObject({ status: 'ok', stdout: 'done\n', exit_code: 0 });
  });

  it('fails closed when no run_code service is configured', async () => {
    const sandbox = makeSandbox(makeProvider());

    const result = await executeSingleTool({
      sandbox,
      toolName: SANDBOX_RUN_CODE_TOOL_NAME,
      mappedName: SANDBOX_RUN_CODE_TOOL_NAME,
      id: 'call-1',
      arguments: { language: 'python', code: 'print("hi")' },
    });

    expect(sandbox.isRunCodeAvailable()).toBe(false);
    expect(result.rawContent).toContain('run_code is not available');
  });

  it('returns metadata-only files_out (no bytes ever cross the tool boundary)', async () => {
    const { service } = makeRunCodeService(async () => okRunCodeResult());
    const sandbox = makeSandbox(makeProvider(), service);

    const result = await executeSingleTool({
      sandbox,
      toolName: SANDBOX_RUN_CODE_TOOL_NAME,
      mappedName: SANDBOX_RUN_CODE_TOOL_NAME,
      id: 'call-1',
      arguments: { language: 'python', code: 'open("/egress/chart.png","wb").write(b"x")' },
    });

    const parsed = JSON.parse(result.rawContent) as {
      files_out: Array<Record<string, unknown>>;
    };
    expect(parsed.files_out).toHaveLength(1);
    expect(parsed.files_out[0]).toEqual({ name: 'chart.png', size_bytes: 1234, sha256: 'a'.repeat(64) });
    expect(result.rawContent).not.toContain('base64');
  });

  it('passes staged turn attachments to the service as ingress bytes', async () => {
    const { service, runCode } = makeRunCodeService(async () => okRunCodeResult());
    const sandbox = makeSandbox(makeProvider(), service);
    const bytes = Buffer.from('a,b\n1,2\n');

    await sandbox.uploadUserFile({ fileName: 'data.csv', content: bytes, mime: 'text/csv' });
    await executeSingleTool({
      sandbox,
      toolName: SANDBOX_RUN_CODE_TOOL_NAME,
      mappedName: SANDBOX_RUN_CODE_TOOL_NAME,
      id: 'call-1',
      arguments: { language: 'python', code: 'print(open("/ingress/data.csv").read())' },
    });

    const options = runCode.mock.calls[0]?.[1];
    expect(options?.attachments).toHaveLength(1);
    expect(options?.attachments?.[0]?.name).toBe('data.csv');
    expect(options?.attachments?.[0]?.bytes).toEqual(bytes);
  });

  it('advertises staged attachments in the run_code description with byte sizes', async () => {
    const { service } = makeRunCodeService();
    const sandbox = makeSandbox(makeProvider(), service);
    const bytes = Buffer.from('hello');

    await sandbox.uploadUserFile({ fileName: 'notes.txt', content: bytes, mime: 'text/plain' });

    const runCodeTool = sandbox.listToolsForTest().find(tool => tool.name === SANDBOX_RUN_CODE_TOOL_NAME);
    expect(runCodeTool).toBeDefined();
    expect(runCodeTool?.description).toContain('/ingress');
    expect(runCodeTool?.description).toContain('- notes.txt (5 bytes)');
    expect(runCodeTool?.description).toContain('do NOT re-upload via files_in');
  });

  it('tells the model to relay a failure verbatim with its links and never predict output', () => {
    const { service } = makeRunCodeService();
    const sandbox = makeSandbox(makeProvider(), service);

    const runCodeTool = sandbox.listToolsForTest().find(tool => tool.name === SANDBOX_RUN_CODE_TOOL_NAME);

    expect(runCodeTool?.description).toContain('quote the error text exactly as returned, including any links');
    expect(runCodeTool?.description).toContain('NEVER state or predict what it would have printed');
  });

  it('removes the attachment from the ingress list when the upload is rolled back', async () => {
    const { service } = makeRunCodeService();
    const execImpl: SandboxProvider['exec'] = (params: SandboxExecParams) => {
      if (params.command.startsWith('realpath -e -- ')) {
        const quoted = params.command.slice('realpath -e -- '.length).trim();
        return readyExec(`${quoted.replace(/^'|'$/g, '')}\n`);
      }
      return readyExec();
    };
    const exec = jest.fn(execImpl);
    const sandbox = makeSandbox(makeProvider({ exec }), service);

    const stored = await sandbox.uploadUserFile({
      fileName: 'notes.txt',
      content: Buffer.from('hello'),
      mime: 'text/plain',
    });
    await sandbox.deleteUserFile({ filePath: stored.filePath });

    const runCodeTool = sandbox.listToolsForTest().find(tool => tool.name === SANDBOX_RUN_CODE_TOOL_NAME);
    expect(runCodeTool?.description ?? '').not.toContain('notes.txt');
  });
});

describe('Sandbox exec interpreter guard', () => {
  const execArguments = (command: string, purpose = 'execute') => ({
    command,
    purpose,
    intent: 'test invocation',
    cwd: '/',
  });

  it('classifies an interpreter invocation as invalid preflight: no approval prompt', async () => {
    const sandbox = makeSandbox(makeProvider());
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: execArguments('python3 -c "print(1)"'),
    });
    expect(info.is_approval_required).toBe(false);
  });

  it('rejects the interpreter invocation before the provider is touched', async () => {
    const exec = jest.fn(async (_params: SandboxExecParams) => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const result = await executeSingleTool({
      sandbox,
      toolName: SANDBOX_EXEC_TOOL_NAME,
      mappedName: SANDBOX_EXEC_TOOL_NAME,
      id: 'call-1',
      arguments: execArguments('python3 -c "print(1)"'),
    });

    expect(exec).not.toHaveBeenCalled();
    expect(result.rawContent).toContain('run_code tool instead');
  });

  it('rejects node invocations the same way', async () => {
    const exec = jest.fn(async (_params: SandboxExecParams) => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const result = await executeSingleTool({
      sandbox,
      toolName: SANDBOX_EXEC_TOOL_NAME,
      mappedName: SANDBOX_EXEC_TOOL_NAME,
      id: 'call-1',
      arguments: execArguments('node -e "console.log(1)"'),
    });

    expect(exec).not.toHaveBeenCalled();
    expect(result.rawContent).toContain('run_code tool instead');
  });

  it('still allows ordinary repo/build commands through exec', async () => {
    const exec = jest.fn(async (_params: SandboxExecParams) => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: execArguments('npm run build', 'execute'),
    });
    // 'execute'-effect commands require approval (not invalid preflight).
    expect(info.is_approval_required).toBe(true);

    await executeSingleTool({
      sandbox,
      toolName: SANDBOX_EXEC_TOOL_NAME,
      mappedName: SANDBOX_EXEC_TOOL_NAME,
      id: 'call-1',
      arguments: execArguments('npm run build', 'execute'),
    });
    expect(exec.mock.calls.some(call => call[0].command === 'npm run build')).toBe(true);
  });
});
