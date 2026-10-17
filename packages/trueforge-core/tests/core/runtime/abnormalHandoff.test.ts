import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EventType, type TurnDoneEvent } from '../../../src/agent-session/schemas/events';
import { CancellationReason } from '../../../src/agent-session/schemas/turn';
import { Sessions } from '../../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../../src/agent-session/TurnResourceResolver';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeAgentSpec, mintTestTurnId } from '../../agent-session/testHelpers';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from '../sandbox/durableWorkspaceCoordinator';
import { fakeTrackedState } from '../sandbox/fakeTrackedState';
import { realCommandExec } from '../sandbox/realCommandExec';

const execFileAsync = promisify(execFile);
const EMPTY_TRACKED_STATE = fakeTrackedState([]);

const GIT_FIXTURE_ENVIRONMENT_KEYS_TO_REMOVE = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

function gitFixtureEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (GIT_FIXTURE_ENVIRONMENT_KEYS_TO_REMOVE.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) {
      delete environment[key];
    }
  }
  return { ...environment, ...overrides };
}

async function* finalSummaryStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  return {
    output: { role: 'assistant', content: 'Continue by running the registered verification command.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function* unknownToolStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  const toolCall = {
    id: 'unknown-tool',
    type: 'function',
    function: { name: 'not_a_real_tool', arguments: '{}' },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  return {
    output: { role: 'assistant', content: null, tool_calls: [toolCall] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* neverSettlingStream(
  started: () => void,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  started();
  await new Promise<void>(() => undefined);
  return {
    output: { role: 'assistant', content: null },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeBoundSandbox(options: {
  exec: jest.MockedFunction<(params: SandboxExecParams) => Promise<ExecResult>>;
  existingSandboxId?: string | undefined;
  toolResultDumpDir?: string | undefined;
  workspaceCwd?: string | undefined;
  workspaceVerificationCoordinator?: TestDurableWorkspaceCoordinator | undefined;
}) {
  const createSandbox = jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-handoff' }));
  const uploadFile = jest.fn<ReturnType<SandboxProvider['uploadFile']>, Parameters<SandboxProvider['uploadFile']>>(() =>
    Promise.resolve(),
  );
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: jest.fn(),
    getImageBuildStatus: jest.fn(),
    createSandbox,
    exec: realCommandExec(options.exec),
    acknowledgeWorkspaceTermination: jest.fn(() => Promise.resolve()),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => options.toolResultDumpDir ?? '/tmp/tool-results',
    getGitCredentialsPath: () => '/tmp/.git-credentials',
    getFileUploadsDir: () => '/tmp/uploads',
    getSkillsDir: () => '/opt/tfy/skills',
    getSkillDownloaderPath: () => '/opt/tfy/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile,
    createCodeModeTransport: jest.fn(),
  };
  const workspaceVerificationCoordinator =
    options.workspaceVerificationCoordinator ?? new TestDurableWorkspaceCoordinator();
  const sandbox = new Sandbox({
    provider,
    existingSandboxId: options.existingSandboxId,
    boundRepository: {
      repository_id: 'repo-1',
      revision: 7,
      workspace_cwd: options.workspaceCwd ?? '/repo',
      commands: [],
    },
    workspaceVerificationCoordinator,
    workspaceLeaseOwnerId: 'abnormal-handoff-test',
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
  return { sandbox, createSandbox, uploadFile, provider, workspaceVerificationCoordinator };
}

async function runGitFixture(input: {
  args: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
}): Promise<string> {
  const result = await execFileAsync('git', input.args, {
    cwd: input.cwd,
    encoding: 'utf8',
    env: gitFixtureEnvironment(input.env),
  });
  return result.stdout.trimEnd();
}

function quotedGitConfigCommand(...args: string[]): string {
  return args.map(value => `"${value.replace(/\\/gu, '/').replace(/"/gu, '\\"')}"`).join(' ');
}

function captureScriptFromCommand(command: string): { flags: string[]; script: string } {
  const isolatedPrefix = 'env -i PATH="$PATH" HOME=/nonexistent python3 -I -S -E -c ';
  const prefix = command.startsWith(isolatedPrefix) ? isolatedPrefix : 'python3 -c ';
  if (!command.startsWith(prefix)) {
    throw new Error(`Expected abnormal-handoff Python command, received: ${command}`);
  }
  const encoded = command.slice(prefix.length);
  if (!encoded.startsWith("'")) {
    throw new Error('Expected shell-escaped Python source');
  }
  let offset = 1;
  let script = '';
  while (offset < encoded.length) {
    const closeQuote = encoded.indexOf("'", offset);
    if (closeQuote === -1) {
      throw new Error('Unterminated shell-escaped Python source');
    }
    script += encoded.slice(offset, closeQuote);
    offset = closeQuote + 1;
    if (encoded.slice(offset, offset + 3) !== "\\''") {
      break;
    }
    script += "'";
    offset += 3;
  }
  return { flags: prefix === isolatedPrefix ? ['-I', '-S', '-E'] : [], script };
}

function pythonExecutable(): string {
  return process.env['PYTHON_EXECUTABLE'] ?? 'python3';
}

function boundedEvidenceCaptureOutput(
  input: {
    branch?: string | undefined;
    headSha?: string | undefined;
    workspaceRoot?: string | undefined;
    status?: string[] | undefined;
    statusCount?: number | undefined;
    diffstat?: string[] | undefined;
    diffstatCount?: number | undefined;
    artifactWritten?: boolean | undefined;
  } = {},
): string {
  const status = input.status ?? [' M src/changed.ts'];
  const statusCount = input.statusCount ?? status.length;
  const diffstat = input.diffstat ?? [' src/changed.ts | 1 +'];
  const diffstatCount = input.diffstatCount ?? diffstat.length;
  return JSON.stringify({
    workspace_root: input.workspaceRoot ?? '/repo',
    branch: input.branch ?? 'codex/handoff',
    head_sha: input.headSha ?? '0123456789abcdef',
    status,
    status_count: statusCount,
    status_truncated: statusCount > status.length,
    diffstat,
    diffstat_count: diffstatCount,
    diffstat_truncated: diffstatCount > diffstat.length,
    artifact_written: input.artifactWritten ?? false,
  });
}

describe('abnormal handoffs', () => {
  const sandboxPythonOnly = process.platform === 'win32' ? test.skip : test;

  it('isolates fixture repositories from Git hook repository context', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-handoff-git-environment-'));
    const outerRoot = join(fixtureRoot, 'outer');
    const repositoryRoot = join(fixtureRoot, 'repository');
    try {
      await runGitFixture({ args: ['init', '--initial-branch=main', outerRoot], cwd: fixtureRoot });
      await runGitFixture({ args: ['init', '--initial-branch=main', repositoryRoot], cwd: fixtureRoot });
      const outerConfigPath = join(outerRoot, '.git', 'config');
      const outerConfigBefore = await readFile(outerConfigPath);
      const hookEnvironment = {
        GIT_DIR: join(outerRoot, '.git'),
        GIT_WORK_TREE: outerRoot,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: outerRoot,
      };
      const previousEnvironment = new Map(Object.keys(hookEnvironment).map(key => [key, process.env[key]] as const));
      Object.assign(process.env, hookEnvironment);
      try {
        await runGitFixture({
          args: ['config', 'user.name', 'Isolated Fixture'],
          cwd: repositoryRoot,
        });
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(await runGitFixture({ args: ['config', 'user.name'], cwd: repositoryRoot })).toBe('Isolated Fixture');
      expect(await readFile(outerConfigPath)).toEqual(outerConfigBefore);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not create or contact a sandbox for explicit cancellation when none exists', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => {
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'unexpected' } });
    });
    const { sandbox, createSandbox, uploadFile } = makeBoundSandbox({ exec });
    const create = jest.fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>(() => finalSummaryStream());
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
      },
      sandbox,
      context: [{ role: 'user', content: 'stop now' }],
    });

    await expect(thread.buildAbnormalHandoff({ cause: 'client_cancelled' })).resolves.toEqual(
      expect.objectContaining({
        cause: 'client_cancelled',
        summary: null,
        evidence: expect.objectContaining({
          repository: expect.objectContaining({ branch: null, head_sha: null, changed_files: [] }),
          verification_receipt: expect.objectContaining({ status: 'not_available' }),
        }),
      }),
    );
    expect(createSandbox).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  sandboxPythonOnly('executes the real capture when tool-results resolves inside the repository', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-handoff-in-repo-artifact-'));
    const repositoryRoot = join(fixtureRoot, 'repository');
    const artifactPath = join(repositoryRoot, 'tool-results', 'handoff.txt');
    try {
      await runGitFixture({ args: ['init', '--initial-branch=codex/handoff', repositoryRoot], cwd: fixtureRoot });
      await runGitFixture({ args: ['config', 'user.name', 'T7 Test'], cwd: repositoryRoot });
      await runGitFixture({ args: ['config', 'user.email', 't7@example.invalid'], cwd: repositoryRoot });
      await writeFile(join(repositoryRoot, 'tracked.txt'), 'tracked\n', 'utf8');
      await runGitFixture({ args: ['add', '.'], cwd: repositoryRoot });
      await runGitFixture({ args: ['commit', '-m', 'fixture'], cwd: repositoryRoot });

      const exec = jest.fn(async (params: SandboxExecParams): Promise<ExecResult> => {
        const capture = captureScriptFromCommand(params.command);
        const result = await execFileAsync(
          pythonExecutable(),
          [...capture.flags, '-c', capture.script, artifactPath, repositoryRoot, '100', '16000'],
          { cwd: repositoryRoot, encoding: 'utf8' },
        );
        return { success: true, response: { exitCode: 0, result: result.stdout } };
      });
      const { sandbox } = makeBoundSandbox({
        exec,
        existingSandboxId: 'v1:test:in-repo-artifact',
        toolResultDumpDir: join(repositoryRoot, 'tool-results'),
        workspaceCwd: repositoryRoot,
      });

      await expect(sandbox.captureAbnormalHandoffEvidence()).resolves.toMatchObject({
        repository: { workspace_cwd: repositoryRoot, branch: 'codex/handoff', head_sha: expect.any(String) },
      });
      expect(existsSync(artifactPath)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  sandboxPythonOnly('runs the real capture in isolated Python startup mode', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-handoff-python-isolation-'));
    const repositoryRoot = join(fixtureRoot, 'repository');
    const markerPath = join(fixtureRoot, 'sitecustomize-loaded');
    const artifactPath = join(fixtureRoot, 'handoff.txt');
    try {
      await runGitFixture({ args: ['init', '--initial-branch=codex/handoff', repositoryRoot], cwd: fixtureRoot });
      await runGitFixture({ args: ['config', 'user.name', 'T7 Test'], cwd: repositoryRoot });
      await runGitFixture({ args: ['config', 'user.email', 't7@example.invalid'], cwd: repositoryRoot });
      await writeFile(join(repositoryRoot, 'tracked.txt'), 'tracked\n', 'utf8');
      await writeFile(
        join(repositoryRoot, 'sitecustomize.py'),
        `from pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text('loaded', encoding='utf-8')\n`,
        'utf8',
      );
      await runGitFixture({ args: ['add', 'tracked.txt'], cwd: repositoryRoot });
      await runGitFixture({ args: ['commit', '-m', 'fixture'], cwd: repositoryRoot });

      const exec = jest.fn(async (params: SandboxExecParams): Promise<ExecResult> => {
        const capture = captureScriptFromCommand(params.command);
        const result = await execFileAsync(
          pythonExecutable(),
          [...capture.flags, '-c', capture.script, artifactPath, repositoryRoot, '100', '16000'],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...process.env, PYTHONPATH: repositoryRoot },
          },
        );
        return { success: true, response: { exitCode: 0, result: result.stdout } };
      });
      const { sandbox } = makeBoundSandbox({
        exec,
        existingSandboxId: 'v1:test:python-isolation',
        toolResultDumpDir: join(fixtureRoot, 'tool-results'),
        workspaceCwd: repositoryRoot,
      });

      await expect(sandbox.captureAbnormalHandoffEvidence()).resolves.toMatchObject({
        repository: { workspace_cwd: repositoryRoot, branch: 'codex/handoff' },
      });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('serializes one coherent evidence snapshot behind workspace mutation', async () => {
    const mutationStarted = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const steps: string[] = [];
    let evidenceStarted = false;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } });
      }
      if (params.command === 'touch held-mutation.txt') {
        steps.push('mutation_started');
        mutationStarted.resolve();
        return releaseMutation.promise.then(() => {
          steps.push('mutation_finished');
          return { success: true, response: { exitCode: 0, result: 'mutation complete' } };
        });
      }
      if (params.command.includes('python3 ')) {
        evidenceStarted = true;
        steps.push('evidence_captured');
        return Promise.resolve({
          success: true,
          response: { exitCode: 0, result: boundedEvidenceCaptureOutput() },
        });
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: EMPTY_TRACKED_STATE[params.command] ?? 'ok' },
      });
    });
    const { sandbox } = makeBoundSandbox({ exec, existingSandboxId: 'v1:test:serialized-handoff' });
    const mutation = sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Hold a workspace mutation for the handoff boundary test',
          purpose: 'edit',
          cwd: '/repo',
          command: 'touch held-mutation.txt',
        },
      },
      { status: 'allow', scope: 'once' },
    );

    await mutationStarted.promise;
    const capture = sandbox.captureAbnormalHandoffEvidence();
    await Promise.resolve();
    try {
      expect(evidenceStarted).toBe(false);
    } finally {
      releaseMutation.resolve();
      await mutation;
    }

    await expect(capture).resolves.toMatchObject({
      repository: { branch: 'codex/handoff', head_sha: '0123456789abcdef' },
    });
    expect(steps).toEqual(['mutation_started', 'mutation_finished', 'evidence_captured']);
  });

  it('times out behind a stuck workspace mutation without running a late capture', async () => {
    const mutationStarted = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } });
      }
      if (params.command === 'touch stuck-mutation.txt') {
        mutationStarted.resolve();
        return releaseMutation.promise.then(() => ({
          success: true,
          response: { exitCode: 0, result: 'mutation complete' },
        }));
      }
      if (params.command.includes('python3 ')) {
        return Promise.resolve({
          success: true,
          response: { exitCode: 0, result: boundedEvidenceCaptureOutput() },
        });
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: EMPTY_TRACKED_STATE[params.command] ?? 'ok' },
      });
    });
    const { sandbox } = makeBoundSandbox({ exec, existingSandboxId: 'v1:test:timed-handoff-lock' });
    const mutation = sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Hold a workspace mutation for the timeout boundary test',
          purpose: 'edit',
          cwd: '/repo',
          command: 'touch stuck-mutation.txt',
        },
      },
      { status: 'allow', scope: 'once' },
    );

    await mutationStarted.promise;
    jest.useFakeTimers();
    try {
      const capture = sandbox.captureAbnormalHandoffEvidence();
      await jest.runOnlyPendingTimersAsync();

      await expect(capture).resolves.toMatchObject({
        repository: { branch: null, head_sha: null, changed_files: [] },
        verification_receipt: { status: 'not_available' },
      });
      expect(exec.mock.calls.filter(call => call[0].command.startsWith('python3 -c '))).toHaveLength(0);

      releaseMutation.resolve();
      await mutation;
      await Promise.resolve();
      expect(exec.mock.calls.filter(call => call[0].command.startsWith('python3 -c '))).toHaveLength(0);
    } finally {
      releaseMutation.resolve();
      jest.useRealTimers();
    }
  });

  it('does not permit the relative tool-results directory to write inside the bound repository', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: boundedEvidenceCaptureOutput({
            statusCount: 101,
            diffstatCount: 101,
            artifactWritten: false,
          }),
        },
      }),
    );
    const { sandbox } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:relative-tool-results',
      toolResultDumpDir: 'tool-results',
      workspaceCwd: '/repo',
    });

    const evidence = await sandbox.captureAbnormalHandoffEvidence();
    const captureParams = exec.mock.calls[0]?.[0];

    expect(captureParams?.command).toContain('artifact_is_inside_workspace');
    expect(evidence.repository).toMatchObject({
      changed_files_truncated: true,
      diffstat_truncated: true,
      overflow_artifact: null,
    });
  });

  it('acknowledges timed-out evidence termination before a reattached sandbox can mutate the workspace', async () => {
    const lateResult = Promise.withResolvers<ExecResult>();
    const executionOrder: string[] = [];
    let terminationAcknowledged = false;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes('abnormal-handoff-')) {
        return lateResult.promise;
      }
      if (params.command.includes('touch second-mutation.txt')) {
        if (!terminationAcknowledged) {
          return Promise.reject(new Error('reattached mutation raced timed-out evidence capture'));
        }
        executionOrder.push('second-mutation');
      }
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } });
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: EMPTY_TRACKED_STATE[params.command] ?? 'ok' },
      });
    });
    const { sandbox, provider, workspaceVerificationCoordinator } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:late-provider-result',
    });
    const { sandbox: reattachedSandbox } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:late-provider-result',
      workspaceVerificationCoordinator,
    });
    provider.acknowledgeWorkspaceTermination = jest.fn(() => {
      terminationAcknowledged = true;
      executionOrder.push('termination-acknowledged');
      return Promise.resolve();
    });
    let secondMutation: Promise<unknown> | undefined;

    jest.useFakeTimers();
    try {
      const capture = sandbox.captureAbnormalHandoffEvidence();
      await jest.runOnlyPendingTimersAsync();
      await expect(capture).resolves.toMatchObject({
        repository: { branch: null, head_sha: null, changed_files: [], overflow_artifact: null },
      });

      secondMutation = reattachedSandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: {
            intent: 'Run the next workspace mutation',
            purpose: 'edit',
            cwd: '/repo',
            command: 'touch second-mutation.txt',
          },
        },
        { status: 'allow', scope: 'once' },
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(terminationAcknowledged).toBe(true);
      expect(exec.mock.calls.some(call => call[0].workspaceLock?.workspaceRoot === '/repo')).toBe(true);
      expect(exec.mock.calls.filter(call => call[0].command.includes('touch second-mutation.txt'))).toHaveLength(1);

      lateResult.resolve({
        success: true,
        response: { exitCode: 0, result: boundedEvidenceCaptureOutput({ artifactWritten: true }) },
      });
      await secondMutation;
      expect(executionOrder).toEqual(['termination-acknowledged', 'second-mutation']);
    } finally {
      lateResult.resolve({ success: false, error: 'test cleanup' });
      await secondMutation;
      jest.useRealTimers();
    }
  });

  it('omits an active receipt when the handoff snapshot cannot prove its state hash', async () => {
    const verificationCommand = 'pnpm verify';
    const gitState: Readonly<Record<string, string>> = {
      'git rev-parse --show-toplevel': '/repo',
      'git rev-parse --abbrev-ref HEAD': 'codex/handoff',
      'git rev-parse HEAD': '0123456789abcdef',
      "git for-each-ref --include-root-refs --sort=refname --format='%(refname)%00%(objectname)%00%(symref)%00'":
        'HEAD\u00000123456789abcdef\u0000refs/heads/codex/handoff\u0000',
      'git ls-files -v -z': 'H src/verified.ts\u0000',
      ...fakeTrackedState([]),
      'git ls-files --others --exclude-standard -z': '',
    };
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes('python3 ')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: boundedEvidenceCaptureOutput({ status: [' M src/verified.ts'] }),
          },
        });
      }
      return Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: params.command === verificationCommand ? 'verification passed' : (gitState[params.command] ?? 'ok'),
        },
      });
    });
    const { sandbox } = makeBoundSandbox({ exec, existingSandboxId: 'v1:test:receipt-handoff' });
    const verification = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Verify the repository before the handoff',
          purpose: 'verify',
          cwd: '/repo',
          command: verificationCommand,
        },
      },
      { status: 'allow', scope: 'once' },
    );
    if (!isCallToolResponseResult(verification) || verification.verificationReceiptCandidate === undefined) {
      throw new Error('Expected a successful verification receipt candidate');
    }
    await sandbox.activateVerificationReceipt(verification.verificationReceiptCandidate, {
      event_id: 'handoff-verification-event',
      thread_id: 'main',
      tool_call_id: 'handoff-verification-call',
    });

    await expect(sandbox.captureAbnormalHandoffEvidence()).resolves.toMatchObject({
      repository: {
        branch: 'codex/handoff',
        head_sha: '0123456789abcdef',
        changed_files: [{ status: 'M', path: 'src/verified.ts' }],
      },
      verification_receipt: {
        status: 'not_available',
        command: null,
        branch: null,
        head_sha: null,
        state_sha256: null,
      },
    });
  });

  it('persists one terminal cap handoff with host repository evidence', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const repositoryResult: Readonly<Record<string, string>> = {
        'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD':
          '/repo\ncodex/handoff\n0123456789abcdef',
        'git rev-parse --show-toplevel': '/repo',
        'git rev-parse --absolute-git-dir': '/repo/.git',
        'git rev-parse --abbrev-ref HEAD': 'codex/handoff',
        'git rev-parse HEAD': '0123456789abcdef',
        "ls -di -- .git '/repo/.git'": '101 .git\n101 /repo/.git',
      };
      return Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: params.command.includes('python3 ')
            ? boundedEvidenceCaptureOutput()
            : (repositoryResult[params.command] ?? 'ok'),
        },
      });
    });
    const { sandbox } = makeBoundSandbox({ exec, existingSandboxId: 'v1:test:sandbox-handoff' });
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => unknownToolStream());
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: { create, createNonStream: jest.fn() },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      sandboxProvider: () => Promise.resolve(sandbox),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-handoff',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({ config: { iteration_limit: 1, sandbox: { enabled: true, file_downloads: true } } }),
      },
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'change files' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });

    const terminalEvents = [];
    for await (const event of turn.stream()) {
      if (event.type === EventType.TURN_DONE) terminalEvents.push(event);
    }
    expect(terminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'error',
      handoff: {
        cause: 'iteration_limit',
        summary: null,
        evidence: {
          repository: {
            branch: 'codex/handoff',
            head_sha: '0123456789abcdef',
            changed_files: [{ path: 'src/changed.ts', status: 'M' }],
          },
          verification_receipt: { status: 'not_available' },
        },
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('persists one mechanical handoff when ordinary model dispatch fails fatally', async () => {
    const create = jest.fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>(() => {
      throw new Error('model provider unavailable');
    });
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: { create, createNonStream: jest.fn() },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-fatal-handoff',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'continue until the provider fails' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });

    const terminalEvents: TurnDoneEvent[] = [];
    for await (const event of turn.stream()) {
      if (event.type === EventType.TURN_DONE) terminalEvents.push(event);
    }

    expect(terminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'error',
      handoff: {
        cause: 'fatal_error',
        summary: null,
        evidence: {
          repository: null,
          verification_receipt: { status: 'not_available' },
        },
      },
    });
    const persisted = await turn.listEvents({ limit: 100 });
    expect(persisted.data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('caps iteration with bounded mechanical host evidence and no hidden inference', async () => {
    const boundedStatus = Array.from({ length: 100 }, (_, index) => ` M src/file-${String(index)}.ts`);
    const boundedDiffstat = Array.from({ length: 100 }, (_, index) => ` src/file-${String(index)}.ts | 1 +`);
    const providerOutput = boundedEvidenceCaptureOutput({
      status: boundedStatus,
      statusCount: 10_000,
      diffstat: boundedDiffstat,
      diffstatCount: 10_000,
      artifactWritten: true,
    });
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({ success: true, response: { exitCode: 0, result: providerOutput } }),
    );
    const { sandbox, uploadFile } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:sandbox-handoff',
    });
    const create = jest.fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>(() => finalSummaryStream());
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        iterationLimit: 0,
      },
      sandbox,
      context: [{ role: 'user', content: 'change files' }],
    });

    const events = [];
    for await (const event of thread.execute()) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        handoff_cause: 'iteration_limit',
      }),
    );

    const handoff = await thread.buildAbnormalHandoff({ cause: 'iteration_limit' });
    expect(create).not.toHaveBeenCalled();
    expect(handoff.summary).toBeNull();
    expect(handoff.evidence.repository).toMatchObject({
      branch: 'codex/handoff',
      head_sha: '0123456789abcdef',
      changed_file_count: 10_000,
      changed_files_truncated: true,
      diffstat_truncated: true,
    });
    expect(handoff.evidence.repository?.changed_files).toHaveLength(100);
    expect(handoff.evidence.repository?.diffstat).toHaveLength(100);
    expect(handoff.evidence.repository?.overflow_artifact).toEqual(
      expect.stringMatching(/^\/tmp\/tool-results\/abnormal-handoff-[\da-f-]+\.txt$/u),
    );
    expect(JSON.stringify(handoff.evidence).length).toBeLessThan(50_000);
    expect(providerOutput.length).toBeLessThan(50_000);
    expect(exec).toHaveBeenCalledTimes(1);
    const captureParams = exec.mock.calls[0]?.[0];
    expect(captureParams?.timeoutSeconds).toBe(2);
    expect(captureParams?.cwd).toBeUndefined();
    expect(captureParams?.command).toContain('git status --short --untracked-files=all');
    expect(captureParams?.command).toContain('git diff --stat --no-ext-diff --no-textconv HEAD --');
    expect(captureParams?.command).toContain('/tmp/tool-results/abnormal-handoff-');
    expect(captureParams?.command).toContain(handoff.evidence.repository?.overflow_artifact ?? 'missing-artifact');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('does not trust Git evidence from a root outside the bound workspace', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: boundedEvidenceCaptureOutput({ workspaceRoot: '/different-repository' }),
        },
      }),
    );
    const { sandbox, uploadFile } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:sandbox-handoff',
    });
    const modelClient: ILLM = { create: jest.fn(), createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test' },
      sandbox,
      context: [{ role: 'user', content: 'inspect the bound repository' }],
    });

    const handoff = await thread.buildAbnormalHandoff({ cause: 'fatal_error' });

    expect(handoff.evidence).toEqual({
      repository: {
        repository_id: 'repo-1',
        revision: 7,
        workspace_cwd: '/repo',
        branch: null,
        head_sha: null,
        changed_files: [],
        changed_file_count: 0,
        changed_files_truncated: false,
        diffstat: [],
        diffstat_truncated: false,
        overflow_artifact: null,
      },
      verification_receipt: {
        status: 'not_available',
        command: null,
        branch: null,
        head_sha: null,
        state_sha256: null,
      },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(modelClient.create).not.toHaveBeenCalled();
  });

  it('keeps bounded evidence but reports no artifact when overflow writing fails', async () => {
    const providerOutput = boundedEvidenceCaptureOutput({
      status: [' M src/first.ts'],
      statusCount: 5_000,
      diffstat: [' src/first.ts | 1 +'],
      diffstatCount: 5_000,
      artifactWritten: false,
    });
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({ success: true, response: { exitCode: 0, result: providerOutput } }),
    );
    const { sandbox, uploadFile } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:sandbox-handoff',
    });
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient: { create: jest.fn(), createNonStream: jest.fn() },
        instruction: 'test',
      },
      sandbox,
      context: [{ role: 'user', content: 'inspect a large dirty tree' }],
    });

    const handoff = await thread.buildAbnormalHandoff({ cause: 'fatal_error' });

    expect(handoff.evidence.repository).toMatchObject({
      changed_file_count: 5_000,
      changed_files_truncated: true,
      diffstat_truncated: true,
      overflow_artifact: null,
    });
    expect(handoff.evidence.repository?.changed_files).toHaveLength(1);
    expect(handoff.evidence.repository?.diffstat).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('captures Git evidence without invoking repository helpers or refreshing the index', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-handoff-git-'));
    const repositoryRoot = join(fixtureRoot, 'repository');
    const helperPath = join(fixtureRoot, 'configured-helper.mjs');
    const markerPath = join(fixtureRoot, 'helper-invoked');
    const artifactDir = join(fixtureRoot, 'tool-results');
    const safeGlobalArgs = [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.preloadIndex=false',
      '-c',
      'color.ui=false',
    ];
    const safeDiffArgs = ['diff', '--stat', '--no-ext-diff', '--no-textconv', 'HEAD', '--'];
    const safeEnvironment = { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat' };

    try {
      await runGitFixture({ args: ['init', '--initial-branch=codex/handoff', repositoryRoot], cwd: fixtureRoot });
      await runGitFixture({ args: ['config', 'user.name', 'T7 Test'], cwd: repositoryRoot });
      await runGitFixture({ args: ['config', 'user.email', 't7@example.invalid'], cwd: repositoryRoot });
      await writeFile(
        join(repositoryRoot, '.gitattributes'),
        ['external.txt diff=handoff-external', 'textconv.txt diff=handoff-textconv', ''].join('\n'),
        'utf8',
      );
      await Promise.all(
        ['external.txt', 'textconv.txt', 'ordinary.txt', 'stable.txt'].map(file =>
          writeFile(join(repositoryRoot, file), 'committed\n', 'utf8'),
        ),
      );
      await runGitFixture({ args: ['add', '.'], cwd: repositoryRoot });
      await runGitFixture({ args: ['commit', '-m', 'fixture'], cwd: repositoryRoot });
      const committedHead = await runGitFixture({ args: ['rev-parse', 'HEAD'], cwd: repositoryRoot });

      await writeFile(
        helperPath,
        [
          '#!/usr/bin/env node',
          "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
          `appendFileSync(${JSON.stringify(markerPath)}, 'invoked\\n');`,
          'const candidate = process.argv.at(-1);',
          'if (candidate !== undefined && existsSync(candidate)) process.stdout.write(readFileSync(candidate));',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(helperPath, 0o700);
      await runGitFixture({ args: ['config', 'core.fsmonitor', helperPath], cwd: repositoryRoot });
      await runGitFixture({
        args: ['config', 'diff.handoff-external.command', quotedGitConfigCommand(process.execPath, helperPath)],
        cwd: repositoryRoot,
      });
      await runGitFixture({
        args: ['config', 'diff.handoff-textconv.textconv', quotedGitConfigCommand(process.execPath, helperPath)],
        cwd: repositoryRoot,
      });
      await runGitFixture({
        args: ['config', 'core.pager', quotedGitConfigCommand(process.execPath, helperPath)],
        cwd: repositoryRoot,
      });

      await Promise.all(
        ['external.txt', 'textconv.txt', 'ordinary.txt'].map(file =>
          writeFile(join(repositoryRoot, file), 'changed\n', 'utf8'),
        ),
      );
      const future = new Date(Date.now() + 5_000);
      await utimes(join(repositoryRoot, 'stable.txt'), future, future);

      const statusBefore = await runGitFixture({
        args: [...safeGlobalArgs, 'status', '--short', '--untracked-files=all'],
        cwd: repositoryRoot,
        env: safeEnvironment,
      });
      const indexPath = join(repositoryRoot, '.git', 'index');
      const shadowIndexPath = join(fixtureRoot, 'capture-index');
      const indexBefore = await readFile(indexPath);
      const indexStatBefore = await stat(indexPath);

      const exec = jest.fn(async (params: SandboxExecParams): Promise<ExecResult> => {
        const globalArgs = params.command.includes(JSON.stringify(safeGlobalArgs)) ? [...safeGlobalArgs] : [];
        const diffArgs = params.command.includes(JSON.stringify(safeDiffArgs))
          ? [...safeDiffArgs]
          : ['diff', '--stat', 'HEAD', '--'];
        const git = (args: string[], env = params.env) =>
          runGitFixture({ args: [...globalArgs, ...args], cwd: repositoryRoot, env });
        const workspaceRoot = await git(['rev-parse', '--show-toplevel']);
        const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
        const headSha = await git(['rev-parse', 'HEAD']);
        const evidenceEnvironment = { ...params.env };
        if (params.command.includes('git_environment["GIT_INDEX_FILE"]')) {
          await copyFile(indexPath, shadowIndexPath);
          evidenceEnvironment['GIT_INDEX_FILE'] = shadowIndexPath;
        }
        try {
          const statusOutput = await git(['status', '--short', '--untracked-files=all'], evidenceEnvironment);
          const diffstatOutput = await git(diffArgs, evidenceEnvironment);
          const statusLines = statusOutput.split(/\r?\n/u).filter(line => line.length > 0);
          const diffstatLines = diffstatOutput.split(/\r?\n/u).filter(line => line.length > 0);
          return {
            success: true,
            response: {
              exitCode: 0,
              result: boundedEvidenceCaptureOutput({
                workspaceRoot,
                branch,
                headSha,
                status: statusLines,
                diffstat: diffstatLines,
              }),
            },
          };
        } finally {
          await rm(shadowIndexPath, { force: true });
        }
      });
      const { sandbox } = makeBoundSandbox({
        exec,
        existingSandboxId: 'v1:test:sandbox-handoff',
        toolResultDumpDir: artifactDir,
        workspaceCwd: repositoryRoot,
      });
      const modelClient: ILLM = { create: jest.fn(), createNonStream: jest.fn() };
      const thread = new AgentThread({
        threadId: 'main',
        title: 'Main',
        toolCallMemo: undefined,
        taskState: undefined,
        isRequestContinuation: undefined,
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
        definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test' },
        sandbox,
        context: [{ role: 'user', content: 'capture mechanical evidence' }],
      });

      const handoff = await thread.buildAbnormalHandoff({ cause: 'client_cancelled' });

      const captureParams = exec.mock.calls[0]?.[0];
      expect(captureParams?.env).toMatchObject(safeEnvironment);
      expect(captureParams?.command).toContain(JSON.stringify(safeGlobalArgs));
      expect(captureParams?.command).toContain(JSON.stringify(safeDiffArgs));
      expect(captureParams?.command).toContain('"--no-pager"');
      expect(captureParams?.command).toContain('"--no-optional-locks"');
      expect(captureParams?.command).toContain('"core.fsmonitor=false"');
      expect(captureParams?.command).toContain('"core.untrackedCache=false"');
      expect(captureParams?.command).toContain('"--no-ext-diff"');
      expect(captureParams?.command).toContain('"--no-textconv"');
      expect(captureParams?.command).toContain('git_environment["GIT_INDEX_FILE"]');
      expect(existsSync(markerPath)).toBe(false);
      expect(await readFile(indexPath)).toEqual(indexBefore);
      expect((await stat(indexPath)).mtimeMs).toBe(indexStatBefore.mtimeMs);
      expect(
        await runGitFixture({
          args: [...safeGlobalArgs, 'status', '--short', '--untracked-files=all'],
          cwd: repositoryRoot,
          env: safeEnvironment,
        }),
      ).toBe(statusBefore);
      expect(handoff.evidence.repository).toMatchObject({
        workspace_cwd: repositoryRoot,
        branch: 'codex/handoff',
        head_sha: committedHead,
        changed_file_count: 3,
        changed_files_truncated: false,
        overflow_artifact: null,
      });
      expect(modelClient.create).not.toHaveBeenCalled();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('times out hung provider evidence and persists exactly one cancellation terminal', async () => {
    const evidenceStarted = Promise.withResolvers<void>();
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => {
      evidenceStarted.resolve();
      return new Promise<ExecResult>(() => undefined);
    });
    const { sandbox, createSandbox } = makeBoundSandbox({
      exec,
      existingSandboxId: 'v1:test:sandbox-handoff',
    });
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    const modelStarted = Promise.withResolvers<void>();
    const create = jest.fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>(() =>
      neverSettlingStream(modelStarted.resolve),
    );
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: { create, createNonStream: jest.fn() },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      sandboxProvider: () => Promise.resolve(sandbox),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-hung-evidence',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({ config: { sandbox: { enabled: true, file_downloads: true } } }),
      },
    });
    const controller = new AbortController();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'change files until cancelled' }],
      previous_turn_id: 'none',
      signal: controller.signal,
      resolver,
    });

    jest.useFakeTimers();
    try {
      const terminalEvents: TurnDoneEvent[] = [];
      const drain = (async () => {
        for await (const event of turn.stream()) {
          if (event.type === EventType.TURN_DONE) terminalEvents.push(event);
        }
      })();
      await modelStarted.promise;
      controller.abort(CancellationReason.ClientCancelled);
      await evidenceStarted.promise;
      await jest.runOnlyPendingTimersAsync();
      await drain;

      expect(terminalEvents).toHaveLength(1);
      expect(turn.state).toMatchObject({
        status: 'cancelled',
        reason: CancellationReason.ClientCancelled,
        handoff: {
          cause: 'client_cancelled',
          summary: null,
          evidence: { repository: { branch: null, head_sha: null } },
        },
      });
      const persisted = await turn.listEvents({ limit: 100 });
      expect(persisted.data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(createSandbox).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists exactly one terminal event without an unlineaged summary inference', async () => {
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => unknownToolStream())
      .mockImplementation(() => {
        throw new Error('hidden summary inference attempted');
      });
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: { create, createNonStream: jest.fn() },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
    });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-visible-lineage',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({ config: { iteration_limit: 1 } }),
      },
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'change files' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });

    const terminalEvents: TurnDoneEvent[] = [];
    for await (const event of turn.stream()) {
      if (event.type === EventType.TURN_DONE) terminalEvents.push(event);
    }

    expect(terminalEvents).toHaveLength(1);
    expect(turn.state).toMatchObject({
      status: 'error',
      handoff: { cause: 'iteration_limit', summary: null },
    });
    const persisted = await turn.listEvents({ limit: 100 });
    expect(persisted.data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not perform a hidden summary inference without durable visible lineage', async () => {
    const modelClient: ILLM = {
      create: jest.fn(() => finalSummaryStream()),
      createNonStream: jest.fn(),
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test' },
      context: [{ role: 'user', content: 'change files' }],
    });

    await expect(thread.buildAbnormalHandoff({ cause: 'fatal_error' })).resolves.toEqual(
      expect.objectContaining({ summary: null, evidence: expect.objectContaining({ repository: null }) }),
    );
    expect(modelClient.create).not.toHaveBeenCalled();
  });
});
