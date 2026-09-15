import type {
  AgentContextProcessorOutput,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

/**
 * A minimal `PreLLMAgentContextProcessor` standing in for `ContextCompaction`: on a chosen
 * invocation it overwrites the entire context with a summary, dropping every internal system
 * message (including a guard nudge), exactly as real compaction does.
 */
class CompactAwayOnNthCall implements PreLLMAgentContextProcessor {
  private calls = 0;

  constructor(private readonly compactOnCall: number) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
  async *processPreLLM(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    this.calls += 1;
    if (this.calls !== this.compactOnCall) {
      return;
    }
    const summaryContext: ContextMessage[] = [{ role: 'assistant', content: 'Summary of the conversation so far.' }];
    yield {
      type: EventType.AGENT_CONTEXT_OVERWRITE,
      id: newEventId(),
      created_at: new Date().toISOString(),
      reason: 'compaction',
      context: summaryContext,
      current_context_usage: getEmptyCurrentContextUsage(),
      usage: getEmptyUsage(),
    };
  }
}

/** A minimal sandbox provider whose `exec` result is driven by the test. */
function makeSandbox(exec: SandboxProvider['exec']): Sandbox {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: jest.fn(),
    getImageBuildStatus: jest.fn(),
    createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-nudge' })),
    exec,
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
  return new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* inspectionStream(
  indexOrIndexes: number | number[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const indexes = Array.isArray(indexOrIndexes) ? indexOrIndexes : [indexOrIndexes];
  const calls = indexes.map(index => ({
    id: `inspection-${String(index)}`,
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Inspect repository',
        purpose: 'inspect',
        command: `pwd # inspection-${String(index)}`,
        cwd: '/tmp/repo',
      }),
    },
  }));
  yield {
    id: `chunk-${indexes.join('-')}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: calls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalStream(
  content: string | null,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      { index: 0, delta: { role: 'assistant', ...(content === null ? {} : { content }) }, finish_reason: null },
    ],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* repositorySetupStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  const call = {
    id: 'repository-setup',
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Clone repository',
        purpose: 'edit',
        command: 'cd /tmp && git clone https://github.com/example/project.git',
      }),
    },
  };
  yield {
    id: 'setup-chunk',
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

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* approvalRequiredEditStream(
  index: number,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: `approval-edit-${String(index)}`,
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Prepare source edit',
        purpose: 'edit',
        command: `cp source-${String(index)} target-${String(index)}`,
        cwd: '/tmp/repo',
      }),
    },
  };
  yield {
    id: `approval-chunk-${String(index)}`,
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

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* mixedBatchStream(
  inspectionIndex: number,
  editIndex: number,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const inspectionCall = {
    id: `inspection-${String(inspectionIndex)}`,
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Inspect repository',
        purpose: 'inspect',
        command: `pwd # inspection-${String(inspectionIndex)}`,
        cwd: '/tmp/repo',
      }),
    },
  };
  const editCall = {
    id: `approval-edit-${String(editIndex)}`,
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Prepare source edit',
        purpose: 'edit',
        command: `edit source-${String(editIndex)} to target-${String(editIndex)}`,
        cwd: '/tmp/repo',
      }),
    },
  };
  yield {
    id: `mixed-chunk-${inspectionIndex}-${editIndex}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, ...inspectionCall },
            { index: 1, ...editCall },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return {
    output: {
      role: 'assistant',
      content: null,
      tool_calls: [inspectionCall, editCall],
    },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

describe('repository inspection budget', () => {
  it('warns after broad discovery without withholding productive inspection tools', async () => {
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: jest.fn(),
      getImageBuildStatus: jest.fn(),
      createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-1' })),
      exec: jest.fn(() =>
        Promise.resolve({ success: true as const, response: { exitCode: 0, result: '/tmp/repo\n' } }),
      ),
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
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    let setupSent = false;
    let callIndex = 0;
    const create = jest.fn(request => {
      void request;
      if (!setupSent) {
        setupSent = true;
        return repositorySetupStream();
      }
      if (callIndex >= 13) return finalStream('Inspection complete; ready to make the focused edit.');
      if (callIndex === 10) {
        callIndex = 13;
        return inspectionStream([11, 12, 13]);
      }
      callIndex += 1;
      return inspectionStream(callIndex);
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'fix the repository' }],
    });

    // The repository-clone setup call is an edit-effect exec (git clone), so it requires a
    // real per-call approval; edit-effect calls can never be pre-authorized by a chat grant
    // (allowsChatApproval only covers 'inspect'). Drive that approval turn explicitly, the
    // same way the sibling test below does, then let the remaining inspect-effect calls run
    // to completion without further interruption.
    let events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) events.push(event);
    expect(events.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);
    for await (const _event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'repository-setup',
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      // Context updates are consumed by the session layer in production.
    }
    events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) events.push(event);

    expect(create).toHaveBeenCalledTimes(13);
    expect(
      events.find(event => event.type === 'tool.response.v2' && event.tool_call_id === 'repository-setup'),
    ).toMatchObject({ content: expect.stringContaining('"success":true') });
    expect(
      events.find(event => event.type === 'tool.response.v2' && event.tool_call_id === 'inspection-7'),
    ).toMatchObject({ content: expect.stringContaining('Inspection budget warning') });
    expect(provider.exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('inspection-13') }),
    );
    expect(create.mock.calls.at(-1)?.[0].tools?.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({
      status: 'done',
      output: expect.objectContaining({ content: 'Inspection complete; ready to make the focused edit.' }),
    });
  });

  it('stops after five consecutive empty inspection batches', async () => {
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: jest.fn(),
      getImageBuildStatus: jest.fn(),
      createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-empty' })),
      exec: jest.fn(() => Promise.resolve({ success: true as const, response: { exitCode: 0, result: '' } })),
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
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    let callIndex = 0;
    const create = jest.fn(() => {
      callIndex += 1;
      return inspectionStream(callIndex);
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
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'find the missing file' }],
    });

    const events = [];
    for await (const event of thread.execute()) events.push(event);

    // Six calls: five empty inspections trigger the guard, the recovery pass
    // runs a sixth inspection, and the guard fires again to end the turn.
    expect(create).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('five consecutive inspections'),
      }),
    );
  });

  it('keeps tools available across approval continuations after the warning', async () => {
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: jest.fn(),
      getImageBuildStatus: jest.fn(),
      createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-1' })),
      exec: jest.fn(() => Promise.resolve({ success: true as const, response: { exitCode: 0, result: 'prepared' } })),
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
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    let callIndex = 0;
    const create = jest.fn(request => {
      void request;
      callIndex += 1;
      return approvalRequiredEditStream(callIndex);
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
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'fix the repository' }],
    });

    let events = [];
    for await (const event of thread.execute()) events.push(event);
    for (let index = 1; index <= 14; index += 1) {
      expect(events.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);
      for await (const _event of thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: `approval-edit-${String(index)}`,
          approval: { status: 'allow', scope: 'once' },
        },
      ])) {
        // Context updates are consumed by the session layer in production.
      }
      events = [];
      for await (const event of thread.execute()) events.push(event);
    }

    expect(provider.exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('source-14') }),
    );
    expect(events.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(create.mock.calls.at(-1)?.[0].tools?.length).toBeGreaterThan(0);
  });
});

describe('empty-inspection nudge', () => {
  const noteText = 'consecutive inspections returned no matches';

  it('nudges once at the third empty inspection, continues to the fourth without resending, then stops at the fifth', async () => {
    const sandbox = makeSandbox(
      jest.fn(() => Promise.resolve({ success: true as const, response: { exitCode: 0, result: '' } })),
    );
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 5 ? inspectionStream(round) : finalStream('done');
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
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'find the missing file' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute()) events.push(event);

    expect(JSON.stringify(requests[2]?.messages)).not.toContain(noteText);
    expect(JSON.stringify(requests[3]?.messages)).toContain(`3 ${noteText}`);
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(noteText)).toHaveLength(2); // one occurrence splits into two parts
    // With loop recovery, the fifth empty inspection triggers a final-answer
    // pass instead of an immediate error; the model answers, so the turn succeeds.
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('resets the nudge state when an inspection finds something, so a later streak nudges again', async () => {
    const exec = jest.fn((params: { command: string }) =>
      Promise.resolve({
        success: true as const,
        response: { exitCode: 0, result: params.command.includes('inspection-4') ? 'found a match\n' : '' },
      }),
    );
    const sandbox = makeSandbox(exec);
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three empty inspections (nudged at the third), one that finds something (resets the
      // streak and its nudge state), then three more empty inspections that must be nudged again.
      if (round <= 7) return inspectionStream(round);
      return finalStream('done');
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
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      sandbox,
      context: [{ role: 'user', content: 'find the missing file' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute()) events.push(event);

    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(noteText)).toHaveLength(3); // both streaks' notes survive
  });

  it('re-sends the nudge after compaction removes it, and still stops at the fifth empty inspection', async () => {
    const sandbox = makeSandbox(
      jest.fn(() => Promise.resolve({ success: true as const, response: { exitCode: 0, result: '' } })),
    );
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 5 ? inspectionStream(round) : finalStream('done');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    // Compacts away right after the third empty inspection's nudge landed in context, and before
    // the fourth empty inspection's request is built.
    const compaction = new CompactAwayOnNthCall(4);
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'find the missing file' }],
      capabilities: [{ preLLMProcessors: [compaction] }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute()) events.push(event);

    // With loop recovery, the fifth empty inspection triggers a final-answer
    // pass instead of an immediate error; the model answers, so the turn succeeds.
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    expect(JSON.stringify(requests[3]?.messages)).not.toContain(noteText);
    expect(JSON.stringify(requests[4]?.messages)).toContain(noteText);
  });

  it('does not emit the empty-inspection note when the mixed batch has unresolved non-empty calls', async () => {
    // Regression for Bug 2: when a batch has an empty inspection alongside an unresolved
    // non-empty client result, the streak classification and note queueing happen before
    // all results are known. After two empty inspection batches, a mixed batch with an
    // immediately resolved empty inspection and a deferred non-empty client result should
    // not emit a false "3 consecutive empty inspections" note, because the batch is not
    // actually empty once the deferred result arrives.
    const exec = jest.fn((params: { command: string }) =>
      Promise.resolve({
        success: true as const,
        response: {
          exitCode: 0,
          // Return empty for inspections, non-empty for edits
          result: params.command.includes('edit') ? 'result data' : '',
        },
      }),
    );
    const sandbox = makeSandbox(exec);
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round <= 2) {
        // Two empty inspection batches
        return inspectionStream(round);
      }
      if (round === 3) {
        // Mixed batch: empty inspection followed by approval-required edit (deferred)
        return mixedBatchStream(round, round);
      }
      if (round <= 4) {
        // After approval, return final answer
        return finalStream('done');
      }
      return finalStream('done');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'find and edit the file' }],
    });

    let events: unknown[] = [];
    for await (const event of thread.execute()) {
      events.push(event);
    }

    // Process the approval
    if (events.some(e => (e as unknown as { type?: string }).type === EventType.TOOL_APPROVAL_REQUIRED)) {
      for await (const _event of thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'approval-edit-3',
          approval: { status: 'allow', scope: 'once' },
        },
      ])) {
        // Context updates are consumed by the session layer in production
      }
      events = [];
      for await (const event of thread.execute()) {
        events.push(event);
      }
    }

    // After the mixed batch completes, the empty-inspection note should not be in the context
    // because the batch was not empty overall (the deferred approval-edit had non-empty content)
    const finalMessages = JSON.stringify(thread.toSnapshot().context);
    expect(finalMessages).not.toContain('3 consecutive inspections returned no matches');
  });
});
