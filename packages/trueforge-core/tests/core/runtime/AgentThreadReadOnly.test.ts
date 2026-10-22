import {
  currentDateTime,
  GET_CURRENT_DATETIME_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/CurrentDateTime';
import { EventType } from '../../../src/core/events/schema';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  type Sandbox,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { llmCreateInputs, runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger, makeStubPublicSandbox } from '../harnessMocks';

const SANDBOX_TOOL_NAMES = [
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
];

function threadFor({ readOnly, sandbox }: { readOnly: boolean; sandbox?: Sandbox | undefined }) {
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
    sandbox,
    capabilities: [currentDateTime({ tracing: NOOP_AGENT_TRACING })],
    capabilityState: undefined,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
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

  it('withholds sandbox tools from a read-only definition even when a sandbox is configured', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: true, sandbox: makeStubPublicSandbox() });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = JSON.stringify(llmCreateInputs(modelClient));
    for (const name of SANDBOX_TOOL_NAMES) {
      expect(requests).not.toContain(`"name":"${name}"`);
    }
  });

  it('offers the sandbox tools to a definition that is not read-only, so the check above is not vacuous', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: false, sandbox: makeStubPublicSandbox() });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = JSON.stringify(llmCreateInputs(modelClient));
    expect(requests).toContain(`"name":"${SANDBOX_RUN_CODE_TOOL_NAME}"`);
  });
});
