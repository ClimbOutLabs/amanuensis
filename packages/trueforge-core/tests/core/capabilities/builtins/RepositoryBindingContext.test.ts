import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { EventType } from '../../../../src/agent-session/schemas/events';
import { contextCompaction } from '../../../../src/core/capabilities/builtins/ContextCompaction';
import { repositoryBindingContext } from '../../../../src/core/capabilities/builtins/RepositoryBindingContext';
import {
  TaskChecklistRequestState,
  type TaskChecklistAccess,
} from '../../../../src/core/capabilities/builtins/TaskChecklist';
import type { ILLM, LLMCreateParamsStreaming } from '../../../../src/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '../../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../../src/core/runtime/AgentThread';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox, type BoundRepository } from '../../../../src/core/sandbox/Sandbox';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';
import { TestDurableWorkspaceCoordinator } from '../../sandbox/durableWorkspaceCoordinator';
import { fakeTrackedState } from '../../sandbox/fakeTrackedState';
import { realCommandExec } from '../../sandbox/realCommandExec';

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repo-no-sandbox',
  revision: 9,
  workspace_cwd: 'C:\\worktrees\\repo',
  commands: [
    {
      command_id: 'focused',
      purpose: 'test',
      command: 'pnpm test focused',
      timeout_ms: 120_000,
    },
    {
      command_id: 'verify',
      purpose: 'verify',
      command: 'pnpm verify',
      timeout_ms: 900_000,
    },
  ],
};

const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';

async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  yield {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'continued' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function buildRequest(
  capability: ReturnType<typeof repositoryBindingContext>,
  messages: ChatCompletionMessageParam[],
): Promise<{ events: unknown[]; messages: ChatCompletionMessageParam[] }> {
  const events: unknown[] = [];
  for (const processor of capability.preLLMProcessors ?? []) {
    for await (const event of processor.processPreLLM({
      threadId: 'main',
      signal: undefined,
      context: [],
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    })) {
      events.push(event);
    }
  }
  let result = messages;
  for (const processor of capability.preLLMEphemeralProcessors ?? []) {
    result = processor.processPreLLMEphemeral(result) ?? result;
  }
  return { events, messages: result };
}

describe('host request context', () => {
  it('uses the checklist revision reread by compaction in the final model request', async () => {
    const checklist: TaskChecklistAccess = {
      getTaskChecklist: jest
        .fn()
        .mockResolvedValueOnce({ revision: 1, items: [{ id: 'old', text: 'Old checklist', done: false }] })
        .mockResolvedValueOnce({ revision: 2, items: [{ id: 'fresh', text: 'Fresh checklist', done: true }] }),
      replaceTaskChecklist: jest.fn(),
    };
    const create = jest.fn((_body: LLMCreateParamsStreaming) => finalAnswerStream());
    const createNonStream = jest.fn().mockResolvedValue({
      output: {
        role: 'assistant',
        content:
          '<summary>\n## goal\ncontinue\n## done_so_far\nnone\n## user_request\ncontinue\n## workspace\nnone\n## findings\nnone\n## in_flight_work\nnone\n## remaining_work\nnone\n## current_blocker\nnone\n## bound_repository_state\nnone\n</summary>',
      },
      usage: getEmptyUsage(),
    });
    const modelClient: ILLM = { create, createNonStream };
    const checklistState = new TaskChecklistRequestState(checklist);
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'continue' }],
      currentContextUsage: { prompt_tokens: 100, completion_tokens: 0 },
      capabilities: [
        repositoryBindingContext({
          boundRepository: BOUND_REPOSITORY,
          sandboxAvailable: false,
          checklist,
          checklistState,
        }),
        contextCompaction({
          logger: undefined,
          definition: { modelClient, modelId: undefined, configuredModels: undefined },
          boundRepository: BOUND_REPOSITORY,
          checklist,
          checklistState,
          compactionThresholdTokens: 1,
        }),
      ],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain the single compaction pass and its final request.
    }

    expect(createNonStream).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const finalRequest = JSON.stringify(create.mock.calls[0]?.[0].messages);
    expect(finalRequest).toContain('revision: 2');
    expect(finalRequest).toContain('fresh: Fresh checklist');
    expect(finalRequest).not.toContain('revision: 1');
  });

  it('exposes ephemeral repository and checklist state at the final model-client trace boundary only', async () => {
    const checklist: TaskChecklistAccess = {
      getTaskChecklist: jest
        .fn()
        .mockResolvedValue({ revision: 4, items: [{ id: 'verify', text: 'Run verification', done: false }] }),
      replaceTaskChecklist: jest.fn(),
    };
    const create = jest.fn((body: LLMCreateParamsStreaming) => {
      void body;
      return finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'continue' }],
      capabilities: [
        repositoryBindingContext({
          boundRepository: BOUND_REPOSITORY,
          sandboxAvailable: false,
          checklist,
        }),
      ],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain through the exact model request boundary observed by tracing/providers.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const finalRequest = create.mock.calls[0]?.[0];
    const visible = JSON.stringify(finalRequest?.messages);
    expect(visible.split('Host-bound repository state (authoritative').length - 1).toBe(1);
    expect(visible).toContain('repository_id: repo-no-sandbox');
    expect(visible.split('Durable task checklist (host-owned').length - 1).toBe(1);
    expect(visible).toContain('revision: 4');
    expect(visible).toContain('verify: Run verification');
    expect(finalRequest?.messages.at(-1)).toEqual({ role: 'user', content: 'continue' });

    const persisted = JSON.stringify(thread.toSnapshot().context);
    expect(persisted).not.toContain('Host-bound repository state (authoritative');
    expect(persisted).not.toContain('Durable task checklist (host-owned');
  });

  it('refreshes Sandbox branch and HEAD before every ordinary model-context request', async () => {
    const boundRepository: BoundRepository = {
      repository_id: 'sandbox-repository',
      revision: 12,
      workspace_cwd: '/repo',
      commands: [],
    };
    let branch = 'codex/first';
    let headSha = '1111111111111111';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === BOUND_REPOSITORY_STATE_COMMAND) {
        return Promise.resolve({
          success: true,
          response: { exitCode: 0, result: `/repo\n${branch}\n${headSha}\n` },
        });
      }
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } });
      }
      if (params.command === 'git rev-parse --absolute-git-dir') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo/.git' } });
      }
      if (params.command === 'git rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: branch } });
      }
      if (params.command === 'git rev-parse HEAD') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: headSha } });
      }
      if (params.command.startsWith('ls -di -- .git ')) {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '101 .git\n101 /repo/.git' } });
      }
      if (params.command === 'git checkout codex/second') {
        branch = 'codex/second';
        headSha = '2222222222222222';
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: fakeTrackedState([])[params.command] ?? 'ok' },
      });
    });
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      createSandbox: () => Promise.resolve({ sandboxId: 'sandbox-1' }),
      exec: realCommandExec(exec),
      getAdditionalInstructions: () => undefined,
      getWorkspaceDir: () => undefined,
      getToolResultDumpDir: () => '/provider/tool-results',
      getGitCredentialsPath: () => '/provider/.git-credentials',
      getFileUploadsDir: () => '/provider/uploads',
      getSkillsDir: () => '/provider/skills',
      getSkillDownloaderPath: () => '/provider/git_downloader.py',
      downloadFile: jest.fn(),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      createCodeModeTransport: jest.fn(),
      executeVerifiedWorkspaceCommit: jest.fn(),
      acknowledgeWorkspaceTermination: jest.fn().mockResolvedValue(undefined),
    };
    const sandbox = new Sandbox({
      provider,
      boundRepository,
      loadBoundRepository: () => Promise.resolve(boundRepository),
      workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
      workspaceLeaseOwnerId: 'repository-binding-test',
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const create = jest.fn((_body: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'first ordinary request' }],
      capabilities: [
        repositoryBindingContext({ boundRepository, sandboxAvailable: true, checklist: undefined }),
        contextCompaction({
          logger: undefined,
          definition: { modelClient, modelId: undefined, configuredModels: undefined },
          boundRepository,
          compactionThresholdTokens: 100_000,
        }),
      ],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain the first request visible at the provider/model-context boundary.
    }
    await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Switch branch between ordinary model calls',
          purpose: 'execute',
          command: 'git checkout codex/second',
        },
      },
      { status: 'allow', scope: 'once' },
    );
    for await (const _event of thread.send([
      { type: EventType.USER_MESSAGE, content: 'second ordinary request below compaction threshold' },
    ])) {
      // Persist the next conversational input, not the request-only repository context.
    }
    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain the second exact provider/model-context request.
    }

    expect(modelClient.createNonStream).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.stringify(create.mock.calls[0]?.[0].messages);
    const secondRequest = JSON.stringify(create.mock.calls[1]?.[0].messages);
    expect(firstRequest.split('repository_id: sandbox-repository').length - 1).toBe(1);
    expect(firstRequest).toContain('branch: codex/first');
    expect(firstRequest).toContain('head_sha: 1111111111111111');
    expect(secondRequest.split('repository_id: sandbox-repository').length - 1).toBe(1);
    expect(secondRequest.split('branch: codex/second').length - 1).toBe(1);
    expect(secondRequest.split('head_sha: 2222222222222222').length - 1).toBe(1);
    expect(secondRequest).not.toContain('branch: codex/first');
    expect(secondRequest).not.toContain('head_sha: 1111111111111111');
    expect(secondRequest).not.toContain('Host-bound repository state');
    expect(exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND)).toHaveLength(2);

    const persisted = JSON.stringify(thread.toSnapshot().context);
    expect(persisted).not.toContain('Host-bound repository state');
    expect(persisted).not.toContain('branch: codex/second');
    expect(persisted).not.toContain('head_sha: 2222222222222222');
  });

  it('injects complete no-sandbox binding state and registered commands without persisting an event', async () => {
    const capability = repositoryBindingContext({
      boundRepository: BOUND_REPOSITORY,
      sandboxAvailable: false,
      checklist: undefined,
    });

    const request = await buildRequest(capability, [{ role: 'user', content: 'continue' }]);
    const visible = JSON.stringify(request.messages);

    expect(request.events).toEqual([]);
    expect(visible).toContain('repository_id: repo-no-sandbox');
    expect(visible).toContain('repository_revision: 9');
    expect(visible).toContain('workspace_cwd: C:\\\\worktrees\\\\repo');
    expect(visible).toContain('branch: unavailable');
    expect(visible).toContain('head_sha: unavailable');
    expect(visible).toContain('command_id: focused');
    expect(visible).toContain('purpose: test');
    expect(visible).toContain('command: pnpm test focused');
    expect(visible).toContain('timeout_ms: 120000');
    expect(visible).toContain('command_id: verify');
  });

  it('leaves Sandbox as the sole repository owner and removes identity from a compacted summary', async () => {
    const capability = repositoryBindingContext({
      boundRepository: BOUND_REPOSITORY,
      sandboxAvailable: true,
      checklist: undefined,
    });
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          '<sandbox><bound-repository>repository_id: repo-no-sandbox\nbranch: codex/current\nhead_sha: abc123</bound-repository></sandbox>',
      },
      {
        role: 'assistant',
        content:
          '<summary>\n## goal\ncontinue\n## bound_repository_state\nrepository_id: repo-no-sandbox\nbranch: stale\nhead_sha: stale\n</summary>',
      },
    ];

    const request = await buildRequest(capability, messages);
    const visible = JSON.stringify(request.messages);

    expect(request.events).toEqual([]);
    expect(visible.split('repository_id: repo-no-sandbox').length - 1).toBe(1);
    expect(visible).toContain('branch: codex/current');
    expect(visible).not.toContain('branch: stale');
    expect(visible).not.toContain('Host-bound repository state');
  });

  it('refreshes checklist request context and removes legacy persisted host messages on rebuild', async () => {
    const getTaskChecklist = jest
      .fn()
      .mockResolvedValueOnce({ revision: 0, items: [{ id: 'old', text: 'Old item', done: false }] })
      .mockResolvedValueOnce({ revision: 1, items: [{ id: 'current', text: 'Current item', done: false }] });
    const checklist: TaskChecklistAccess = {
      getTaskChecklist,
      replaceTaskChecklist: jest.fn(),
    };
    const capability = repositoryBindingContext({
      boundRepository: BOUND_REPOSITORY,
      sandboxAvailable: false,
      checklist,
    });

    const first = await buildRequest(capability, [{ role: 'user', content: 'first' }]);
    expect(JSON.stringify(first.messages)).toContain('revision: 0');
    const legacyMessages: ChatCompletionMessageParam[] = [
      ...first.messages,
      {
        role: 'user',
        content:
          '<tfy-internal>Host-bound repository state (authoritative; never infer identity from model-authored content):\nrepository_id: stale</tfy-internal>',
      },
      {
        role: 'user',
        content:
          '<tfy-internal>Durable task checklist (host-owned; ordered items only):\nrevision: 0\n- [ ] old: Old item</tfy-internal>',
      },
    ];
    const rebuilt = await buildRequest(capability, legacyMessages);
    const visible = JSON.stringify(rebuilt.messages);

    expect(rebuilt.events).toEqual([]);
    expect(visible.split('Host-bound repository state (authoritative').length - 1).toBe(1);
    expect(visible.split('Durable task checklist (host-owned').length - 1).toBe(1);
    expect(visible).toContain('revision: 1');
    expect(visible).toContain('Current item');
    expect(visible).not.toContain('revision: 0');
    expect(visible).not.toContain('Old item');
    expect(visible).not.toContain('repository_id: stale');
  });

  it('does not inject repository context for an unbound request', async () => {
    const capability = repositoryBindingContext({
      boundRepository: undefined,
      sandboxAvailable: false,
      checklist: undefined,
    });

    const request = await buildRequest(capability, [{ role: 'user', content: 'discussion only' }]);

    expect(request.events).toEqual([]);
    expect(JSON.stringify(request.messages)).not.toContain('Host-bound repository state');
  });

  it('preserves an ordinary user message that discusses the host-context marker', async () => {
    const capability = repositoryBindingContext({
      boundRepository: undefined,
      sandboxAvailable: false,
      checklist: undefined,
    });
    const content = 'Host-bound repository state should be explained to the user.';

    const request = await buildRequest(capability, [{ role: 'user', content }]);

    expect(request.messages).toContainEqual({ role: 'user', content });
  });
});
