import {
  currentDateTime,
  GET_CURRENT_DATETIME_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/CurrentDateTime';
import { EventType } from '../../../src/core/events/schema';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { llmCreateInputs, runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger } from '../harnessMocks';

function threadFor({ readOnly }: { readOnly: boolean }) {
  const modelClient = {
    create: jest.fn().mockImplementation(() => textReplyStream('ok')),
    createNonStream: jest.fn(),
  };
  const thread = new AgentThread({
    definition: {
      modelClient,
      instruction: 'You are a test.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: undefined,
      modelId: undefined,
      configuredModels: undefined,
      readOnly,
    },
    threadId: 'thread_read_only',
    title: 'read-only',
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: [currentDateTime({ tracing: NOOP_AGENT_TRACING })],
    capabilityState: undefined,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: jest.fn(),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  return { modelClient, orchestrator };
}

describe('AgentThread read-only definitions', () => {
  it('offers the model no tools when the definition is read-only', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: true });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = llmCreateInputs(modelClient);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain(GET_CURRENT_DATETIME_TOOL_NAME);
    }
  });

  it('keeps the built-in tools when the definition is not read-only', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: false });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    expect(JSON.stringify(llmCreateInputs(modelClient))).toContain(GET_CURRENT_DATETIME_TOOL_NAME);
  });
});
