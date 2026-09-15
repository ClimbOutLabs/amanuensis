import type { AgentCapability } from '../../../src/core/capabilities/AgentCapability';
import type { AgentThreadExecutionContext } from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { withTimeout } from '../../../src/core/util/promiseUtils';
import { makeMockILLM, makeSilentLogger } from '../harnessMocks';

function executionSignal(execution: Readonly<AgentThreadExecutionContext>): AbortSignal {
  if (execution.signal === undefined) {
    throw new Error('processor did not receive the turn signal');
  }
  return execution.signal;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of iterable) {
    // Drain the runtime boundary under test.
  }
}

async function* inspectionToolCallStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  const call: NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number] = {
    id: 'inspection-call',
    type: 'function',
    function: {
      name: 'exec',
      arguments: JSON.stringify({ intent: 'Inspect cwd', purpose: 'inspect', command: 'pwd' }),
    },
  };
  yield {
    id: 'inspection-chunk',
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

function makeSandbox(): Sandbox {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'sandbox-1' }),
    exec: (): Promise<ExecResult> => Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo\n' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/tmp/tool-results',
    getGitCredentialsPath: () => '/tmp/.git-credentials',
    getFileUploadsDir: () => '/tmp/uploads',
    getSkillsDir: () => '/tmp/skills',
    getSkillDownloaderPath: () => '/tmp/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn(() => Promise.resolve()),
    createCodeModeTransport: jest.fn(),
    executeVerifiedWorkspaceCommit: jest.fn(),
    acknowledgeWorkspaceTermination: jest.fn().mockResolvedValue(undefined),
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

describe('AgentThread context processor cancellation', () => {
  it('propagates cancellation through a blocked preSend processor without appending input', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const capability: AgentCapability = {
      preSendProcessors: [
        {
          async *processPreSend(execution) {
            const signal = executionSignal(execution);
            entered.resolve(signal);
            await waitForAbort(signal);
          },
        },
      ],
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient: makeMockILLM() },
      capabilities: [capability],
    });
    const controller = new AbortController();

    const send = drain(
      thread.send(
        [{ type: EventType.USER_MESSAGE, content: 'must not be appended after cancellation' }],
        controller.signal,
      ),
    );
    expect(await withTimeout(entered.promise, 500, 'preSend processor start')).toBe(controller.signal);
    controller.abort(new Error('cancel preSend'));
    await expect(withTimeout(send, 500, 'preSend processor cancellation')).rejects.toThrow('cancel preSend');

    expect(thread.toSnapshot().context).toEqual([]);
  });

  it('propagates cancellation through a blocked preLLM processor before model dispatch', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const capability: AgentCapability = {
      preLLMProcessors: [
        {
          async *processPreLLM(execution) {
            const signal = executionSignal(execution);
            entered.resolve(signal);
            await waitForAbort(signal);
          },
        },
      ],
    };
    const model = makeMockILLM({ create: jest.fn() });
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      context: [{ role: 'user', content: 'cancel before inference' }],
      capabilities: [capability],
    });
    const controller = new AbortController();

    const execution = drain(thread.execute({ signal: controller.signal }));
    expect(await withTimeout(entered.promise, 500, 'preLLM processor start')).toBe(controller.signal);
    controller.abort(new Error('cancel preLLM'));
    await withTimeout(execution, 500, 'preLLM processor cancellation');

    expect(model.create).not.toHaveBeenCalled();
  });

  it('propagates cancellation through a blocked postToolCall processor before another model dispatch', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const capability: AgentCapability = {
      postToolCallProcessors: [
        {
          async *processPostToolCall(execution) {
            const signal = executionSignal(execution);
            entered.resolve(signal);
            await waitForAbort(signal);
          },
        },
      ],
    };
    const create = jest.fn(() => inspectionToolCallStream());
    const model: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model, toolSets: [] },
      sandbox: makeSandbox(),
      context: [{ role: 'user', content: 'inspect the sandbox' }],
      capabilities: [capability],
    });
    const controller = new AbortController();

    const execution = drain(thread.execute({ signal: controller.signal }));
    expect(await withTimeout(entered.promise, 500, 'postToolCall processor start')).toBe(controller.signal);
    controller.abort(new Error('cancel postToolCall'));
    await withTimeout(execution, 500, 'postToolCall processor cancellation');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps a persisted append synchronized with in-memory context when cancellation follows the yield', async () => {
    const capability: AgentCapability = {
      preSendProcessors: [
        {
          async *processPreSend() {
            await Promise.resolve();
            yield {
              type: InternalEventType.AGENT_CONTEXT_APPEND,
              context: [{ role: 'user', content: 'processor-owned append' }],
              output: [],
              current_context_usage: undefined,
              tool_call_memo: undefined,
            };
          },
        },
      ],
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient: makeMockILLM() },
      capabilities: [capability],
    });
    const controller = new AbortController();
    const stream = thread.send(
      [{ type: EventType.USER_MESSAGE, content: 'must not overtake the persisted processor append' }],
      controller.signal,
    );

    const persisted = await stream.next();
    if (persisted.done) {
      throw new Error('processor append did not reach the persistence boundary');
    }
    expect(persisted.value.type).toBe(InternalEventType.AGENT_CONTEXT_APPEND);
    controller.abort(new Error('cancel after append persistence'));

    await expect(stream.next()).rejects.toThrow('cancel after append persistence');
    expect(thread.toSnapshot().context).toEqual(persisted.value.context);
  });

  it('keeps a persisted overwrite synchronized with in-memory context when cancellation follows the yield', async () => {
    const model = makeMockILLM({ create: jest.fn() });
    const capability: AgentCapability = {
      preLLMProcessors: [
        {
          async *processPreLLM() {
            await Promise.resolve();
            yield {
              type: EventType.AGENT_CONTEXT_OVERWRITE,
              id: 'overwrite-after-persistence',
              created_at: new Date().toISOString(),
              reason: 'compaction',
              context: [{ role: 'assistant', content: 'persisted compacted context' }],
              current_context_usage: getEmptyCurrentContextUsage(),
              usage: getEmptyUsage(),
            };
          },
        },
      ],
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      context: [{ role: 'user', content: 'context before compaction' }],
      capabilities: [capability],
    });
    const controller = new AbortController();
    const stream = thread.execute({ signal: controller.signal });

    const persisted = await stream.next();
    if (persisted.done || persisted.value.type !== EventType.AGENT_CONTEXT_OVERWRITE) {
      throw new Error('processor overwrite did not reach the persistence boundary');
    }
    controller.abort(new Error('cancel after overwrite persistence'));
    await drain(stream);

    expect(thread.toSnapshot().context).toEqual(persisted.value.context);
    expect(model.create).not.toHaveBeenCalled();
  });
});
