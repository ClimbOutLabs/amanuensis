import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls, type ToolCallResult } from '../../../src/core/mcp/executeToolCalls';
import type { RunCodeResult } from '../../../src/core/sandbox/driver/RunCodeSchemas';
import type { RunCodeBackend, RunCodeCallOptions } from '../../../src/core/sandbox/driver/RunCodeService';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  createSandboxRunCodeDescription,
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { realCommandExec } from './realCommandExec';

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
    exec: realCommandExec(exec),
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
    const guidance = createSandboxRunCodeDescription({
      offline: false,
      packageDownloads: false,
      workspaceDir: '/workspace',
    })
      .split('\n')
      .find(line => line.startsWith('If run_code fails'));
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

describe('Sandbox run_code package downloads wording', () => {
  it('says packages can be downloaded when downloads are allowed for the chat', () => {
    const description = createSandboxRunCodeDescription({
      offline: false,
      packageDownloads: true,
      workspaceDir: '/workspace',
    });
    expect(description).toContain('Packages can be downloaded for this chat');
    expect(description).not.toContain('cannot be downloaded');
    expect(description).not.toContain('no installs at runtime');
  });

  it('says packages cannot be downloaded when the sandbox has no internet access', () => {
    const description = createSandboxRunCodeDescription({
      offline: true,
      packageDownloads: false,
      workspaceDir: '/workspace',
    });
    expect(description).toContain('Packages cannot be downloaded here');
    expect(description).not.toContain('Packages can be downloaded');
  });

  it('says there are no installs when the network is up but downloads are not allowed', () => {
    const description = createSandboxRunCodeDescription({
      offline: false,
      packageDownloads: false,
      workspaceDir: '/workspace',
    });
    expect(description).toContain('no installs at runtime');
    expect(description).not.toContain('can be downloaded');
  });
});

/** Runs the real `realpath` and `test` commands the script reader sends, so links are resolved on disk. */
function localScriptShellExec(params: SandboxExecParams): Promise<ExecResult> {
  if (!/^(realpath -e -- |test -f )/u.test(params.command)) {
    return readyExec();
  }
  const run = spawnSync('/bin/sh', ['-c', params.command], { encoding: 'utf8' });
  return Promise.resolve({ success: true, response: { exitCode: run.status ?? 1, result: run.stdout } });
}

describe('Sandbox run_code script_path', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'run-code-script-')));
    workspace = join(root, 'workspace');
    outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.py'), 'print("secret")');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The reader the run hands to the service, built for a sandbox whose workspace is `workspace`. */
  async function scriptReader(
    downloadFile: SandboxProvider['downloadFile'],
  ): Promise<(scriptPath: string) => Promise<Buffer>> {
    const { service, runCode } = makeRunCodeService(async () => okRunCodeResult());
    const sandbox = makeSandbox(
      makeProvider({ exec: localScriptShellExec, getWorkspaceDir: () => workspace, downloadFile }),
      service,
    );
    await executeSingleTool({
      sandbox,
      toolName: SANDBOX_RUN_CODE_TOOL_NAME,
      mappedName: SANDBOX_RUN_CODE_TOOL_NAME,
      id: 'call-1',
      arguments: { language: 'python', script_path: 'start.py' },
    });
    const readScript = runCode.mock.calls[0]?.[1]?.readScript;
    if (readScript === undefined) {
      throw new Error('Expected the run to carry a workspace reader');
    }
    return readScript;
  }

  const readFromDisk: SandboxProvider['downloadFile'] = ({ path }) => Promise.resolve(readFileSync(path));

  it('names script_path and the one-file rule in the run_code description', () => {
    const description = createSandboxRunCodeDescription({
      offline: true,
      packageDownloads: false,
      workspaceDir: '/workspace',
    });
    expect(description).toContain('script_path');
    expect(description).toContain('/workspace/size.py');
    expect(description).toContain('which is never changed');
  });

  it('reads a normal file under the workspace, and a link that stays inside it', async () => {
    writeFileSync(join(workspace, 'size.py'), 'print(1)');
    symlinkSync(join(workspace, 'size.py'), join(workspace, 'alias.py'));
    const readScript = await scriptReader(readFromDisk);

    await expect(readScript('size.py')).resolves.toEqual(Buffer.from('print(1)'));
    await expect(readScript('alias.py')).resolves.toEqual(Buffer.from('print(1)'));
  });

  it('refuses a relative or absolute path that leaves the workspace without reading anything', async () => {
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('/etc/passwd')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    await expect(readScript('../outside/secret.py')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink to a file outside the workspace', async () => {
    symlinkSync(join(outside, 'secret.py'), join(workspace, 'link.py'));
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('link.py')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink chain that ends outside the workspace', async () => {
    symlinkSync(join(outside, 'secret.py'), join(workspace, 'second.py'));
    symlinkSync(join(workspace, 'second.py'), join(workspace, 'first.py'));
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('first.py')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink to /proc without reading it', async () => {
    symlinkSync('/proc/self/status', join(workspace, 'proc.py'));
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('proc.py')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink to a device', async () => {
    symlinkSync('/dev/zero', join(workspace, 'zero.py'));
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('zero.py')).rejects.toThrow(`script_path must be a file under ${workspace}`);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a directory without reading it', async () => {
    mkdirSync(join(workspace, 'folder.py'));
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('folder.py')).rejects.toThrow('script_path "folder.py" could not be read.');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('refuses a fifo without opening it', async () => {
    execFileSync('mkfifo', [join(workspace, 'pipe.py')]);
    const downloadFile = jest.fn(readFromDisk);
    const readScript = await scriptReader(downloadFile);

    await expect(readScript('pipe.py')).rejects.toThrow('script_path "pipe.py" could not be read.');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('tells the model what to do when the workspace file cannot be read', async () => {
    writeFileSync(join(workspace, 'present.py'), 'print(1)');
    const readScript = await scriptReader(() => Promise.reject(new Error('sandbox 404 at /internal/path')));

    const failure = readScript('present.py');
    await expect(failure).rejects.toThrow('script_path "present.py" could not be read.');
    await expect(failure).rejects.not.toThrow('/internal/path');
  });
});
