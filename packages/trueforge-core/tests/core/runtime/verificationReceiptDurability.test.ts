import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import {
  Sandbox,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  type BoundRepository,
} from '../../../src/core/sandbox/Sandbox';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from '../sandbox/durableWorkspaceCoordinator';
import { realCommandExec } from '../sandbox/realCommandExec';

const VERIFICATION_COMMAND = './scripts/validate.sh';
const GIT_STATE_RESULTS: Readonly<Record<string, string>> = {
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD':
    '/repo\nfeature/verification\n0123456789abcdef',
  'git rev-parse --show-toplevel': '/repo',
  'git rev-parse --absolute-git-dir': '/repo/.git',
  'git rev-parse --abbrev-ref HEAD': 'feature/verification',
  'git rev-parse HEAD': '0123456789abcdef',
  "ls -di -- .git '/repo/.git'": '101 .git\n101 /repo/.git',
  'git diff --cached --binary --no-ext-diff --no-textconv --no-color HEAD --': '',
  'git diff --binary --no-ext-diff --no-textconv --no-color --': '',
  'git ls-files --others --exclude-standard -z': '',
};

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture
async function* verificationStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  const call = {
    id: 'verify-call',
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Verify the repository',
        purpose: 'verify',
        command: VERIFICATION_COMMAND,
        cwd: '/repo',
      }),
    },
  };
  yield {
    id: 'verify-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* registeredVerificationStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  const call = {
    id: 'registered-verify-call',
    type: 'function' as const,
    function: {
      name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
      arguments: JSON.stringify({
        intent: 'Verify the repository',
        command_id: 'verify',
      }),
    },
  };
  yield {
    id: 'registered-verify-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture
async function* finalStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Verification complete.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: 'Verification complete.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeProvider(exec: jest.MockedFunction<(params: SandboxExecParams) => Promise<ExecResult>>): SandboxProvider {
  return {
    type: 'test',
    buildImage: jest.fn(),
    getImageBuildStatus: jest.fn(),
    createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-verification' })),
    exec: realCommandExec(exec),
    acknowledgeWorkspaceTermination: jest.fn(() => Promise.resolve()),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/tmp/tool-results',
    getGitCredentialsPath: () => '/tmp/.git-credentials',
    getFileUploadsDir: () => '/tmp/uploads',
    getSkillsDir: () => '/opt/tfy/skills',
    getSkillDownloaderPath: () => '/opt/tfy/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn(() => Promise.resolve()),
    createCodeModeTransport: jest.fn(),
  };
}

describe('verification receipt durability', () => {
  it('finalizes a durably started command as never_ran when cancellation wins before dispatch', async () => {
    const boundRepository: BoundRepository = {
      repository_id: 'repo-1',
      revision: 4,
      workspace_cwd: '/repo',
      commands: [
        {
          command_id: 'verify',
          purpose: 'verify',
          command: 'pnpm verify',
          timeout_ms: 900_000,
        },
      ],
    };
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: { exitCode: 0, result: GIT_STATE_RESULTS[params.command] ?? 'command completed' },
      }),
    );
    const sandbox = new Sandbox({
      provider: makeProvider(exec),
      boundRepository,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => registeredVerificationStream())
      .mockImplementationOnce(() => finalStream());
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
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'Verify the repository.' }],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Reach approval-required state.
    }
    for await (const _event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'registered-verify-call',
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      // Persist approval continuation.
    }

    const controller = new AbortController();
    const continuation = thread.execute({ signal: controller.signal });
    const observed = [];
    while (true) {
      const next = await continuation.next();
      if (next.done) break;
      observed.push(next.value);
      if (next.value.type === EventType.TOOL_EXECUTION_STARTED) {
        // The production consumer has durably persisted this event before asking
        // the generator for its next value.
        controller.abort('deadline');
      }
    }

    expect(exec.mock.calls.some(call => call[0].command === 'pnpm verify')).toBe(false);
    expect(observed.filter(event => event.type === EventType.TOOL_EXECUTION_STARTED)).toHaveLength(1);
    expect(observed.filter(event => event.type === EventType.TOOL_RESPONSE_V2)).toEqual([
      expect.objectContaining({ tool_call_id: 'registered-verify-call', disposition: 'never_ran' }),
    ]);
  });

  it('cannot publish a receipt before the terminal result and tool context are durable', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result:
            params.command === VERIFICATION_COMMAND ? 'verification passed' : (GIT_STATE_RESULTS[params.command] ?? ''),
        },
      }),
    );
    const coordinator = new TestDurableWorkspaceCoordinator();
    coordinator.seedReceipt({ repository_id: 'repo-1', workspace_cwd: '/repo', state_sha256: 'prior-state' });
    const activateReceipt = jest.spyOn(coordinator, 'activateReceipt');
    const sandbox = new Sandbox({
      provider: makeProvider(exec),
      boundRepository: {
        repository_id: 'repo-1',
        revision: 4,
        workspace_cwd: '/repo',
        commands: [],
      },
      workspaceVerificationCoordinator: coordinator,
      workspaceLeaseOwnerId: 'replica-a',
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => verificationStream())
      .mockImplementationOnce(() => finalStream());
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
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'Verify the repository.' }],
    });

    const initialEvents = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) initialEvents.push(event);
    expect(initialEvents.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(exec.mock.calls.filter(call => call[0].command === VERIFICATION_COMMAND)).toHaveLength(0);

    for await (const _event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'verify-call',
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      // The session layer persists each context append in production.
    }

    const continuation = thread.execute({ signal: new AbortController().signal });
    const emitted = [];
    let persistenceBoundaryObserved = false;
    while (true) {
      const next = await continuation.next();
      if (next.done) break;
      emitted.push(next.value);
      if (next.value.type === EventType.TOOL_RESPONSE_V2) {
        // The caller has not yet persisted this yielded terminal event. A crash
        // here must leave no commit-authorizing receipt behind.
        expect(activateReceipt).not.toHaveBeenCalled();
        expect(coordinator.hasReceipt({ repository_id: 'repo-1', workspace_cwd: '/repo' })).toBe(false);
      }
      if (
        next.value.type === InternalEventType.AGENT_CONTEXT_APPEND &&
        next.value.context.some(message => 'role' in message && message.role === 'tool')
      ) {
        persistenceBoundaryObserved = true;
        // The context append has been yielded but the caller has not yet
        // acknowledged its durable write by resuming the generator.
        expect(activateReceipt).not.toHaveBeenCalled();
        const afterPersistence = await continuation.next();
        expect(activateReceipt).toHaveBeenCalledTimes(1);
        if (!afterPersistence.done) emitted.push(afterPersistence.value);
        break;
      }
    }
    for await (const event of continuation) emitted.push(event);

    expect(persistenceBoundaryObserved).toBe(true);
    expect(exec.mock.calls.filter(call => call[0].command === VERIFICATION_COMMAND)).toHaveLength(1);
    expect(emitted.filter(event => event.type === EventType.TOOL_RESPONSE_V2)).toHaveLength(1);
  });

  it('fails closed when a registered command changes after approval but before dispatch', async () => {
    const originallyApprovedCommand = 'pnpm verify';
    const replacementCommand = 'pnpm run changed-command';
    const boundRepository: BoundRepository = {
      repository_id: 'repo-1',
      revision: 4,
      workspace_cwd: '/repo',
      commands: [
        {
          command_id: 'verify',
          purpose: 'verify',
          command: originallyApprovedCommand,
          timeout_ms: 900_000,
        },
      ],
    };
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: GIT_STATE_RESULTS[params.command] ?? 'command completed',
        },
      }),
    );
    const sandbox = new Sandbox({
      provider: makeProvider(exec),
      boundRepository,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => registeredVerificationStream())
      .mockImplementationOnce(() => finalStream());
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
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'Verify the repository.' }],
    });

    const initialEvents = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) initialEvents.push(event);
    expect(initialEvents.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);

    boundRepository.revision = 5;
    boundRepository.commands = [
      {
        command_id: 'verify',
        purpose: 'verify',
        command: replacementCommand,
        timeout_ms: 300_000,
      },
    ];

    for await (const _event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'registered-verify-call',
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      // The session layer persists each context append in production.
    }

    const continuationEvents = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) continuationEvents.push(event);

    expect(exec.mock.calls.some(call => call[0].command === originallyApprovedCommand)).toBe(false);
    expect(exec.mock.calls.some(call => call[0].command === replacementCommand)).toBe(false);
    expect(continuationEvents.filter(event => event.type === EventType.TOOL_EXECUTION_STARTED)).toHaveLength(0);
    const response = continuationEvents.find(event => event.type === EventType.TOOL_RESPONSE_V2);
    expect(response).toMatchObject({ disposition: 'policy_blocked' });
    expect(JSON.stringify(response)).toContain('changed after approval');
  });
});
