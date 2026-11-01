import { createHash } from 'node:crypto';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import { isCallToolResponseResult, type CallToolResponse } from '../../../src/core/mcp/IMCPServer';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  createSandboxLargeToolResponseGuidance,
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  type BoundRepository,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';
import { fakeTrackedState } from './fakeTrackedState';
import { realCommandExec } from './realCommandExec';

function readyExec(result = 'ok'): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result } });
}

const EMPTY_TRACKED_STATE = fakeTrackedState([]);

function boundWorkspaceExec(params: SandboxExecParams): Promise<ExecResult> {
  return params.command.startsWith('realpath -e --') || params.command === 'git rev-parse --show-toplevel'
    ? readyExec('/repo\n')
    : readyExec(EMPTY_TRACKED_STATE[params.command]);
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

function makeUploadFile(): jest.MockedFunction<SandboxProvider['uploadFile']> {
  type UploadFile = SandboxProvider['uploadFile'];
  return jest.fn<ReturnType<UploadFile>, Parameters<UploadFile>>().mockResolvedValue(undefined);
}

function makeExec(implementation: SandboxProvider['exec']): jest.MockedFunction<SandboxProvider['exec']> {
  type Exec = SandboxProvider['exec'];
  return jest.fn<ReturnType<Exec>, Parameters<Exec>>(implementation);
}

function makeSandbox(provider: SandboxProvider, boundRepository?: BoundRepository): Sandbox {
  return new Sandbox({
    provider,
    boundRepository,
    loadBoundRepository: boundRepository === undefined ? undefined : () => Promise.resolve(boundRepository),
    workspaceVerificationCoordinator: boundRepository === undefined ? undefined : new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: boundRepository === undefined ? undefined : 'sharp-tools-test',
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repo-1',
  revision: 1,
  workspace_cwd: '/repo',
  commands: [],
};

async function executeApprovedWriteFile(input: {
  sandbox: Sandbox;
  id: string;
  arguments: { intent: string; cwd: string; path: string; content: string };
  memoState: ReturnType<typeof createToolCallMemoState>;
}) {
  const mappedName = 'sandbox_write_file';
  const toolInfo = await input.sandbox.toolCallInfo({
    name: SANDBOX_WRITE_FILE_TOOL_NAME,
    arguments: input.arguments,
  });
  const assistantMessage: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: input.id,
        type: 'function',
        function: { name: mappedName, arguments: JSON.stringify(input.arguments) },
        tool_info: toolInfo,
      },
    ],
  };
  return executeToolCalls({
    assistantMessage,
    toolMapping: new Map([[mappedName, { toolSet: input.sandbox, originalToolName: SANDBOX_WRITE_FILE_TOOL_NAME }]]),
    threadId: 'main',
    approvalDecisions: new Map([[input.id, { status: 'allow', scope: 'once' }]]),
    memoState: input.memoState,
  });
}

function resultText(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a terminal tool result');
  }
  const content = response.result.content[0];
  if (content?.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedResult(response: CallToolResponse): {
  success: boolean;
  response: { result: string; exitCode: number };
  raw_output: {
    file_path: string;
    sha256: string;
    byte_length: number;
    storage_status: string;
    storage_error: string | undefined;
    provenance: { command_sha256: string };
  };
} {
  const parsed: unknown = JSON.parse(resultText(response));
  const parsedRecord = isRecord(parsed) ? parsed : undefined;
  const success = parsedRecord?.['success'];
  const parsedResponse = parsedRecord?.['response'];
  const parsedRawOutput = parsedRecord?.['raw_output'];
  const parsedProvenance = isRecord(parsedRawOutput) ? parsedRawOutput['provenance'] : undefined;
  const responseResult = isRecord(parsedResponse) ? parsedResponse['result'] : undefined;
  const responseExitCode = isRecord(parsedResponse) ? parsedResponse['exitCode'] : undefined;
  const rawOutputFilePath = isRecord(parsedRawOutput) ? parsedRawOutput['file_path'] : undefined;
  const rawOutputSha256 = isRecord(parsedRawOutput) ? parsedRawOutput['sha256'] : undefined;
  const rawOutputByteLength = isRecord(parsedRawOutput) ? parsedRawOutput['byte_length'] : undefined;
  const rawOutputStorageStatus = isRecord(parsedRawOutput) ? parsedRawOutput['storage_status'] : undefined;
  const rawOutputStorageError = isRecord(parsedRawOutput) ? parsedRawOutput['storage_error'] : undefined;
  const provenanceCommandSha256 = isRecord(parsedProvenance) ? parsedProvenance['command_sha256'] : undefined;
  if (typeof success !== 'boolean' || typeof responseResult !== 'string' || typeof responseExitCode !== 'number') {
    throw new Error('Expected a structured bounded exec result');
  }
  if (
    typeof rawOutputFilePath !== 'string' ||
    typeof rawOutputSha256 !== 'string' ||
    typeof rawOutputByteLength !== 'number' ||
    typeof rawOutputStorageStatus !== 'string' ||
    (rawOutputStorageError !== undefined && typeof rawOutputStorageError !== 'string') ||
    typeof provenanceCommandSha256 !== 'string'
  ) {
    throw new Error('Expected durable raw output provenance');
  }
  return {
    success,
    response: { result: responseResult, exitCode: responseExitCode },
    raw_output: {
      file_path: rawOutputFilePath,
      sha256: rawOutputSha256,
      byte_length: rawOutputByteLength,
      storage_status: rawOutputStorageStatus,
      storage_error: rawOutputStorageError,
      provenance: { command_sha256: provenanceCommandSha256 },
    },
  };
}

describe('T8 sharp sandbox tools', () => {
  it('builds write_file approval metadata without provider calls', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);

    await expect(
      sandbox.toolCallInfo({
        name: SANDBOX_WRITE_FILE_TOOL_NAME,
        arguments: { intent: 'Create a file', cwd: '/repo', path: 'new.ts', content: 'new\n' },
      }),
    ).resolves.toEqual(expect.objectContaining({ is_approval_required: true }));

    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('creates a new test file through one approved structured edit', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Add the focused regression test',
        cwd: '/repo',
        path: 'tests/t8-sharp-tools.test.ts',
        content: "it('creates a file', () => {});\n",
      },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(
      expect.objectContaining({
        effect: 'edit',
        is_approval_required: true,
        original_tool_name: 'write_file:edit',
      }),
    );
    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response)).toBe(true);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    expect(payload.content.toString('utf-8')).toContain('tests/t8-sharp-tools.test.ts');
    const script = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.py'))?.[0];
    if (script === undefined) {
      throw new Error('Expected write_file helper upload');
    }
    expect(script.content.toString('utf-8')).toContain('os.O_EXCL');
    expect(script.content.toString('utf-8')).toContain('os.link');
    expect(script.content.toString('utf-8')).toContain('os.fsync(parent_fd)');
    // Every folder on the path, including the workspace itself, is opened without following links.
    expect(script.content.toString('utf-8')).toContain(
      'DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW',
    );
    expect(script.content.toString('utf-8')).toContain('os.open(workspace_cwd, DIRECTORY_FLAGS)');
    const writeCalls = exec.mock.calls.filter(callArgs => callArgs[0].command.startsWith('python3 '));
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.[0].cwd).toBeUndefined();
    // Bound repositories still get the Git-metadata workspace lock (the receipt step).
    expect(writeCalls[0]?.[0].workspaceLock).toEqual({ workspaceRoot: '/repo' });
    expect(resultText(response)).toContain('write');
  });

  it('creates a file from content_lines, joining the array with "\\n" before dispatch', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Add a Python script',
        cwd: '/repo',
        path: 'src/script.py',
        content_lines: ['def main():', '    print("hi")', '', 'main()'],
      },
    };

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response)).toBe(true);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    // The payload uploaded to the sandbox carries the real newline-joined content, not the array:
    // everything downstream of the schema boundary only ever sees the plain string.
    expect(payload.content.toString('utf-8')).toContain('def main():\\n    print(\\"hi\\")\\n\\nmain()');
  });

  it('rejects write_file when both content and content_lines are supplied', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Add a file',
        cwd: '/repo',
        path: 'new.ts',
        content: 'kept',
        content_lines: ['a', 'b'],
      },
    };

    const response = await sandbox.callTool(call);
    expect(resultText(response)).toContain('provide exactly one of content or content_lines, not both');
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects write_file when neither content nor content_lines is supplied', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Add a file', cwd: '/repo', path: 'new.ts' },
    };

    const response = await sandbox.callTool(call);
    expect(resultText(response)).toContain(
      'content is required; provide it as a string, or as content_lines (an array of lines, one element per line, blank lines as empty strings)',
    );
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an omitted cwd before approval when a repository is bound', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Create a file', path: 'new.ts', content: 'new\n' },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    expect(resultText(await sandbox.callTool(call))).toContain('cwd is required when a repository is bound');
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('refuses path escapes before approval or dispatch', async () => {
    const exec = makeExec(() => readyExec());
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Escape the workspace', cwd: '/repo', path: '../escape.ts', content: 'unsafe\n' },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    const response = await sandbox.callTool(call);
    expect(resultText(response)).toContain('Path must not contain');
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('accepts an absolute write_file path inside cwd and normalizes it before dispatch', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Create a migration',
        cwd: '/repo',
        path: '/repo/migrations/001_init.sql',
        content: '-- init\n',
      },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: true }));
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    expect(JSON.parse(payload.content.toString('utf-8'))).toMatchObject({
      path: 'migrations/001_init.sql',
    });
    expect(resultText(response)).toContain('migrations/001_init.sql');
  });

  it('rejects an absolute write_file path inside the repository root but above cwd, like a relative "../x"', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Create a file above cwd',
        cwd: '/repo/packages/app',
        path: '/repo/other/escape.ts',
        content: 'unsafe\n',
      },
    };

    const response = await sandbox.callTool(call);
    expect(resultText(response)).toContain('Path must not contain');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an absolute write_file path outside the workspace before approval, naming cwd', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Escape the workspace', cwd: '/repo', path: '/etc/passwd', content: 'unsafe\n' },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    const response = await sandbox.callTool(call);
    expect(resultText(response)).toContain('write_file path must be relative to cwd (/repo)');
    expect(resultText(response)).toContain('/etc/passwd');
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('accepts a nested cwd inside the bound repository and anchors the write there', async () => {
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes("'/repo/packages/core'")) {
        return readyExec('/repo/packages/core\n');
      }
      if (params.command.includes("'/repo'")) {
        return readyExec('/repo\n');
      }
      return boundWorkspaceExec(params);
    });
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);

    const response = await sandbox.callTool(
      {
        name: SANDBOX_WRITE_FILE_TOOL_NAME,
        arguments: {
          intent: 'Create a package-local file',
          cwd: '/repo/packages/core',
          path: 'tests/inside.test.ts',
          content: 'inside\n',
        },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    expect(payload.content.toString('utf-8')).toContain('"workspace_cwd":"/repo"');
    expect(payload.content.toString('utf-8')).toContain('"cwd_relative":"packages/core"');
    expect(exec.mock.calls.some(callArgs => callArgs[0].command.startsWith('realpath -e --'))).toBe(true);
  });

  it('rejects a lexical cwd outside the bound repository before approval or provider work', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Create a file', cwd: '/repo/../outside', path: 'new.ts', content: 'new\n' },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    expect(resultText(await sandbox.callTool(call))).toContain('outside the bound workspace');
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a canonical symlink escape before upload or write dispatch', async () => {
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes("'/repo/link-out'")) {
        return readyExec('/outside\n');
      }
      if (params.command.includes("'/repo'")) {
        return readyExec('/repo\n');
      }
      return readyExec();
    });
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Create a file', cwd: '/repo/link-out', path: 'new.ts', content: 'new\n' },
    };

    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');
    await expect(sandbox.callTool(call, { status: 'allow', scope: 'once' })).rejects.toThrow(
      'outside the workspace after canonicalization',
    );
    expect(uploadFile).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(callArgs => callArgs[0].command.startsWith('python3 '))).toBe(false);
  });

  it('classifies sandbox initialization failure as never_ran and permits a retry', async () => {
    let initializationFailed = false;
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('mkdir -p ') && !initializationFailed) {
        initializationFailed = true;
        throw new Error('sandbox initialization failed');
      }
      return boundWorkspaceExec(params);
    });
    const sandbox = makeSandbox(makeProvider({ exec }), BOUND_REPOSITORY);
    const memoState = createToolCallMemoState();
    const argumentsValue = { intent: 'Create a retryable file', cwd: '/repo', path: 'retry.ts', content: 'retry\n' };

    const first = await executeApprovedWriteFile({ sandbox, id: 'init-failed', arguments: argumentsValue, memoState });
    expect(first.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'tool_pre_dispatch_failed', suggested_action: 'retry' },
    });

    const retry = await executeApprovedWriteFile({ sandbox, id: 'init-retry', arguments: argumentsValue, memoState });
    expect(retry.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok', repeatedSideEffect: false });
    expect(exec.mock.calls.filter(callArgs => callArgs[0].command.startsWith('python3 '))).toHaveLength(1);
  });

  it.each([1, 2])('classifies upload %i failure as never_ran and permits a retry', async failedUpload => {
    let uploadAttempt = 0;
    let failed = false;
    const uploadFile = makeUploadFile().mockImplementation(() => {
      uploadAttempt += 1;
      if (!failed && uploadAttempt === failedUpload) {
        failed = true;
        return Promise.reject(new Error('setup upload failed'));
      }
      return Promise.resolve();
    });
    const exec = makeExec(boundWorkspaceExec);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const memoState = createToolCallMemoState();
    const argumentsValue = { intent: 'Create a retryable file', cwd: '/repo', path: 'retry.ts', content: 'retry\n' };

    const first = await executeApprovedWriteFile({
      sandbox,
      id: `upload-failed-${String(failedUpload)}`,
      arguments: argumentsValue,
      memoState,
    });
    expect(first.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'tool_pre_dispatch_failed', suggested_action: 'retry' },
    });

    const retry = await executeApprovedWriteFile({
      sandbox,
      id: `upload-retry-${String(failedUpload)}`,
      arguments: argumentsValue,
      memoState,
    });
    expect(retry.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok', repeatedSideEffect: false });
    expect(exec.mock.calls.filter(callArgs => callArgs[0].command.startsWith('python3 '))).toHaveLength(1);
  });

  it('keeps existing-file overwrite creation-only and reports the refusal', async () => {
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command.startsWith('python3 ')
        ? Promise.resolve({ success: true, response: { exitCode: 1, result: 'file already exists' } })
        : boundWorkspaceExec(params),
    );
    const sandbox = makeSandbox(makeProvider({ exec }), BOUND_REPOSITORY);
    const response = await sandbox.callTool(
      {
        name: SANDBOX_WRITE_FILE_TOOL_NAME,
        arguments: { intent: 'Replace an existing file', cwd: '/repo', path: 'src/existing.ts', content: 'new\n' },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(resultText(response)).toContain('file already exists');
  });

  it('returns exactly one terminal result and never writes for a denied call', async () => {
    const exec = makeExec(boundWorkspaceExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }), BOUND_REPOSITORY);
    const response = await sandbox.callTool(
      {
        name: SANDBOX_WRITE_FILE_TOOL_NAME,
        arguments: { intent: 'Write a denied file', cwd: '/repo', path: 'denied.ts', content: 'nope\n' },
      },
      { status: 'deny', reason: 'not approved' },
    );

    expect(isCallToolResponseResult(response)).toBe(true);
    if (isCallToolResponseResult(response)) {
      expect(response.result.content).toHaveLength(1);
      expect(response.result.isError).toBe(true);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it.each([
    ['cat source.txt > new.txt', 'write_file'],
    ['cat <<EOF\nnew\nEOF', 'write_file'],
    // The interpreter guard fires before the unstructured-edit screening and redirects to run_code.
    ["python3 -c \"open('new.txt', 'w').write('new')\"", 'use the run_code tool instead'],
  ])('names the blocking tool for an unstructured edit write: %s', async (command, expected) => {
    const exec = makeExec(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Write a new file', purpose: 'edit', cwd: '/repo', command },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    expect(resultText(await sandbox.callTool(call))).toContain(expected);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ['cat source.txt > new.txt', 'write_file'],
    ['cat <<EOF\nnew\nEOF', 'write_file'],
    ['cat source.txt | tee new.txt', 'write_file'],
    // The interpreter guard fires before the unstructured-operation screening and redirects to run_code.
    ["python3 -c \"open('new.txt', 'w').write('new')\"", 'use the run_code tool instead'],
    ['python3 -c "print(1)"', 'use the run_code tool instead'],
  ])('rejects an unstructured inspect-purpose operation without dispatch: %s', async (command, expected) => {
    const exec = makeExec(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Inspect a generated file', purpose: 'inspect', cwd: '/repo', command },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    expect(resultText(await sandbox.callTool(call))).toContain(expected);
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not allow execute purpose to bypass structured write admission', async () => {
    const exec = makeExec(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Run a build command',
        purpose: 'execute',
        cwd: '/repo',
        command: 'cat source.txt > new.txt',
      },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(expect.objectContaining({ is_approval_required: false }));
    expect(resultText(await sandbox.callTool(call))).toContain('write_file');
    expect(exec).not.toHaveBeenCalled();
  });

  it('bounds exec output on the host while retaining complete raw output durably', async () => {
    const rawOutput = 'zero\none\ntwo\nthree\nfour\nneedle-one\nneedle-two\n';
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command === 'cat output.txt' ? readyExec(rawOutput) : readyExec(),
    );
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Read a bounded command result',
        purpose: 'inspect',
        cwd: '/repo',
        command: 'cat output.txt',
        output: { head_lines: 2, tail_lines: 2 },
      },
    });

    const result = boundedResult(response);
    expect(result.response.result).toBe('zero\none\nneedle-one\nneedle-two\n');
    expect(result.response.result).not.toContain('two\nthree\nfour');
    expect(result.raw_output.provenance.command_sha256).toBe(
      createHash('sha256').update('cat output.txt').digest('hex'),
    );
    expect(result.raw_output.byte_length).toBe(Buffer.byteLength(rawOutput));
    expect(result.raw_output.sha256).toBe(createHash('sha256').update(rawOutput).digest('hex'));
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].content.toString('utf-8') === rawOutput)).toBe(true);
  });

  it('bounds and persists provider-success output from a nonzero command exit', async () => {
    const rawOutput = 'failure-start\nsecret-middle\nfailure-end\n';
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command === 'pnpm test'
        ? Promise.resolve({ success: true, response: { exitCode: 7, result: rawOutput } })
        : readyExec(),
    );
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Inspect a bounded failing test result',
          purpose: 'execute',
          cwd: '/repo',
          command: 'pnpm test',
          output: { head_lines: 1, tail_lines: 1 },
        },
      },
      { status: 'allow', scope: 'once' },
    );

    const result = boundedResult(response);
    expect(result.response.result).toBe('failure-start\nfailure-end\n');
    expect(result.response.result).not.toContain('secret-middle');
    // `pnpm test` is a bare simple command outside the search/diff table, so a non-zero exit
    // reports "exited" (never guessed at as ok or a genuine "failed") - isError stays false, and
    // the exit code checked below is what says the run did not pass.
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    expect(result.response.exitCode).toBe(7);
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].content.toString('utf-8') === rawOutput)).toBe(true);
  });

  it('preserves the completed command result when durable raw storage fails', async () => {
    const rawOutput = 'first\nsecret-middle\nlast\n';
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command === 'cat output.txt' ? readyExec(rawOutput) : readyExec(),
    );
    const uploadFile = makeUploadFile().mockRejectedValue(new Error('secret provider failure detail'));
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));

    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Read a bounded command result',
        purpose: 'inspect',
        cwd: '/repo',
        command: 'cat output.txt',
        output: { head_lines: 1, tail_lines: 1 },
      },
    });

    const result = boundedResult(response);
    expect(result.success).toBe(true);
    expect(result.response.exitCode).toBe(0);
    expect(result.response.result).toBe('first\nlast\n');
    expect(result.raw_output.storage_status).toBe('failed');
    expect(result.raw_output.storage_error).toContain('Durable raw output storage failed');
    expect(result.raw_output.storage_error).not.toContain('secret provider failure detail');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('supports grep output bounds and rejects invalid bounds clearly', async () => {
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command === 'cat output.txt' ? readyExec('keep\ndrop\nkeep-again\n') : readyExec(),
    );
    const sandbox = makeSandbox(makeProvider({ exec }));
    const filtered = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Filter command output',
        purpose: 'inspect',
        cwd: '/repo',
        command: 'cat output.txt',
        output: { grep: 'keep' },
      },
    });
    expect(JSON.parse(resultText(filtered))).toMatchObject({ response: { result: 'keep\nkeep-again\n' } });

    const invalid = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Use an invalid output bound',
        purpose: 'inspect',
        cwd: '/repo',
        command: 'cat output.txt',
        output: { head_lines: -1 },
      },
    });
    expect(resultText(invalid)).toContain('head_lines');
    expect(exec.mock.calls.filter(callArgs => callArgs[0].command === 'cat output.txt')).toHaveLength(1);
  });

  it('handles head-only, tail-only, overlap, empty, and CRLF output deterministically', async () => {
    const outputs: Record<string, string> = {
      'cat head.txt': 'a\nb\nc\nd\n',
      'cat tail.txt': 'a\nb\nc\nd\n',
      'cat overlap.txt': 'a\nb\nc\n',
      'cat empty.txt': '',
      'cat crlf.txt': 'a\r\nb\r\nc\r\n',
    };
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command in outputs ? readyExec(outputs[params.command]) : readyExec(),
    );
    const sandbox = makeSandbox(makeProvider({ exec }));
    const call = (command: string, output: { head_lines?: number; tail_lines?: number }) =>
      sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Read a bounded result', purpose: 'inspect', cwd: '/repo', command, output },
      });

    expect(JSON.parse(resultText(await call('cat head.txt', { head_lines: 2 })))).toMatchObject({
      response: { result: 'a\nb\n' },
    });
    expect(JSON.parse(resultText(await call('cat tail.txt', { tail_lines: 2 })))).toMatchObject({
      response: { result: 'c\nd\n' },
    });
    expect(JSON.parse(resultText(await call('cat overlap.txt', { head_lines: 2, tail_lines: 2 })))).toMatchObject({
      response: { result: 'a\nb\nc\n' },
    });
    expect(JSON.parse(resultText(await call('cat empty.txt', { head_lines: 2 })))).toMatchObject({
      response: { result: '' },
    });
    expect(JSON.parse(resultText(await call('cat crlf.txt', { tail_lines: 2 })))).toMatchObject({
      response: { result: 'b\r\nc\r\n' },
    });
  });

  it('preserves unbounded exec behavior without creating a raw-output artifact', async () => {
    const rawOutput = 'unchanged output\n';
    const exec = makeExec((params: SandboxExecParams): Promise<ExecResult> =>
      params.command === 'cat output.txt' ? readyExec(rawOutput) : readyExec(),
    );
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Read the command result', purpose: 'inspect', cwd: '/repo', command: 'cat output.txt' },
    });

    const parsed: unknown = JSON.parse(resultText(response));
    expect(isRecord(parsed) && 'raw_output' in parsed).toBe(false);
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].content.toString('utf-8') === rawOutput)).toBe(false);
  });

  it('names the sanctioned output parameters in large-result remediation', async () => {
    const guidance = createSandboxLargeToolResponseGuidance();
    expect(guidance).toContain('output.head_lines');
    expect(guidance).toContain('output.tail_lines');
    expect(guidance).toContain('output.grep');
  });
});

describe('write_file without a bound repository', () => {
  function scratchExec(params: SandboxExecParams): Promise<ExecResult> {
    const realpath = /^realpath -e -- '?([^']+)'?$/u.exec(params.command);
    return realpath?.[1] !== undefined ? readyExec(`${realpath[1]}\n`) : readyExec();
  }

  it('writes into the provider workspace as scratch space', async () => {
    const exec = makeExec(scratchExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile, getWorkspaceDir: () => '/prov/workspace' }));
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Save the reference file the skill needs',
        cwd: '/prov/workspace/references',
        path: 'research-and-sourcing.md',
        content: '# Sources\n',
      },
    };

    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response)).toBe(true);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    expect(JSON.parse(payload.content.toString('utf-8'))).toMatchObject({
      workspace_cwd: '/prov/workspace',
      cwd_relative: 'references',
      path: 'research-and-sourcing.md',
    });
    expect(resultText(response)).toContain('write');
  });

  it('defaults the cwd to the workspace root when none is given', async () => {
    const exec = makeExec(scratchExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile, getWorkspaceDir: () => '/prov/workspace' }));
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Save the reference file the skill needs',
        path: 'research-and-sourcing.md',
        content: '# Sources\n',
      },
    };

    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response)).toBe(true);
    const payload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0];
    if (payload === undefined) {
      throw new Error('Expected write_file payload upload');
    }
    expect(JSON.parse(payload.content.toString('utf-8'))).toMatchObject({
      workspace_cwd: '/prov/workspace',
      cwd_relative: '',
      path: 'research-and-sourcing.md',
    });
    expect(resultText(response)).toContain('write');
  });

  it('refuses a cwd outside the workspace before approval', async () => {
    const exec = makeExec(scratchExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile, getWorkspaceDir: () => '/prov/workspace' }));
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Write elsewhere', cwd: '/etc', path: 'hosts', content: 'x\n' },
    };
    expect(resultText(await sandbox.callTool(call))).toContain('outside the workspace');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('still refuses when the provider has no workspace', async () => {
    const exec = makeExec(scratchExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Write somewhere', cwd: '/tmp', path: 'x.md', content: 'x\n' },
    };
    expect(resultText(await sandbox.callTool(call))).toContain('neither');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('dispatches the write without a workspace lock, so no git runs against the scratch workspace', async () => {
    // A scratch workspace has no `.git`. commandWithWorkspaceLock (provider/Provider.ts)
    // turns any `workspaceLock` into a `git -C <root> rev-parse --git-path ...` lookup
    // for a receipt directory inside `.git`, which fails with exit 128 there. The
    // dispatched write must carry no `workspaceLock` so the provider never builds that
    // git-based command for a scratch write.
    const exec = makeExec(scratchExec);
    const uploadFile = makeUploadFile();
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile, getWorkspaceDir: () => '/prov/workspace' }));
    const call = {
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: {
        intent: 'Save a scratch note',
        cwd: '/prov/workspace',
        path: 'smoke.md',
        content: '# smoke\n',
      },
    };

    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' });
    expect(isCallToolResponseResult(response)).toBe(true);

    const writeCalls = exec.mock.calls.filter(callArgs => callArgs[0].command.startsWith('python3 '));
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.[0].workspaceLock).toBeUndefined();
    expect(writeCalls[0]?.[0].command).not.toContain('git');

    const parsed: unknown = JSON.parse(resultText(response));
    expect(isRecord(parsed) ? parsed['write'] : undefined).toMatchObject({ success: true });
    expect(isCallToolResponseResult(response) ? response.result.isError : undefined).toBe(false);
  });
});
