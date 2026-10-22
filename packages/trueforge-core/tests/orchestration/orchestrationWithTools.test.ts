import type { AgentDefinition, CreateDynamicSubAgentThread } from '../../src/core';
import { dynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import { createToolResponseV2, EventType } from '../../src/core/events/schema';
import type { ILLM } from '../../src/core/llm/ILLM';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import {
  AgentThreadOrchestrator,
  type AgentThreadOrchestratorInput,
} from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import { createSubAgentStream, llmCreateInputs, runTurn, textReplyStream } from './helpers/helpers';

const ROOT_ID = 'thread_root';
const TOOL_CALL_ID = 'call-sub';
const CHILD_REPLY = 'hello from the child';
const ROOT_FINAL = 'How are you?';
const INSTRUCTION = 'You are running in a test setup.';
const CHILD_TASK = 'do the delegated task';

const CREATE_SUB_AGENT_ARGS = JSON.stringify({ name: 'worker', input: CHILD_TASK });

// The canonical wrapped shape (schema_version/outcome/result) that every host-produced terminal
// tool result now carries, both in the tool.response.v2 event and the model-facing tool message.
const CHILD_TOOL_RESULT_CONTENT = createToolResponseV2({
  id: 'unused',
  thread_id: ROOT_ID,
  tool_call_id: TOOL_CALL_ID,
  created_at: 'unused',
  raw_content: CHILD_REPLY,
  model_content: null,
  screen: null,
  admission_provenance: { source: 'internal' },
  memoized: false,
  repeat_count: 1,
  disposition: 'executed_ok',
  remediation: undefined,
}).model_message.content;

/** Root delegates via create_sub_agent; child result returns to parent; root finishes. */
const EXPECTED_EVENTS = [
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID },
  // The tool_info-annotation delta that finalizes the tool call's dispatch metadata.
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: TOOL_CALL_ID,
            type: 'function',
            function: { name: 'create_sub_agent', arguments: CREATE_SUB_AGENT_ARGS },
          },
        ],
      },
    ],
  },
  // create_sub_agent tool path yields an empty append before THREAD_CREATED.
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID, context: [] },
  {
    type: EventType.THREAD_CREATED,
    title: 'worker',
    parent: { thread_id: ROOT_ID, tool_call_id: TOOL_CALL_ID },
  },
  { type: EventType.MODEL_MESSAGE, thread_id: expect.any(String) },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: expect.any(String), content: CHILD_REPLY },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: expect.any(String),
    context: [{ role: 'assistant', content: CHILD_REPLY }],
  },
  { type: EventType.TOOL_RESPONSE_V2, thread_id: ROOT_ID, tool_call_id: TOOL_CALL_ID },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [{ role: 'tool', tool_call_id: TOOL_CALL_ID, content: CHILD_TOOL_RESULT_CONTENT }],
  },
  { type: InternalEventType.AGENT_DONE, thread_id: expect.any(String), status: 'done' },
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID, content: ROOT_FINAL },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [{ role: 'assistant', content: ROOT_FINAL }],
  },
  { type: InternalEventType.AGENT_DONE, thread_id: ROOT_ID, status: 'done' },
];

const OUTPUT = {
  output: { thread_id: ROOT_ID, content: ROOT_FINAL },
  required_actions: [],
};

const EXPECTED_ROOT_LLM_INPUT = [
  {
    messages: [
      { role: 'system', content: expect.stringContaining(INSTRUCTION) },
      { role: 'system', content: expect.stringContaining('<reply-context>') },
      { role: 'user', content: 'hello' },
    ],
  },
  {
    messages: [
      { role: 'system', content: expect.stringContaining(INSTRUCTION) },
      { role: 'system', content: expect.stringContaining('<reply-context>') },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: TOOL_CALL_ID,
            type: 'function',
            function: {
              name: 'create_sub_agent',
              arguments: CREATE_SUB_AGENT_ARGS,
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: TOOL_CALL_ID, content: CHILD_TOOL_RESULT_CONTENT },
    ],
  },
];

describe('orchestration: dynamic sub-agent', () => {
  it('delegates via create_sub_agent, routes child result to parent, then finishes', async () => {
    let agentThreadInput: AgentThreadConstructorInput = {
      // AgentDefinition
      definition: {
        // This is an instance if ILLM
        modelClient: {
          create: jest
            .fn()
            .mockImplementationOnce(() => createSubAgentStream())
            .mockImplementation(() => textReplyStream(ROOT_FINAL)),
          createNonStream: jest.fn(),
        },
        instruction: INSTRUCTION,
        // Undefined
        messages: undefined,
        modelParams: undefined,
        responseFormat: undefined,
        iterationLimit: undefined,
        toolSets: undefined,
        modelId: undefined,
        configuredModels: undefined,
      },
      threadId: ROOT_ID,
      title: 'orchestration-with-tools',
      // Undefined
      parent: undefined,
      agentInfo: undefined,
      context: undefined,
      currentContextUsage: undefined,
      preComputedCompletion: undefined,
      sandbox: undefined,
      capabilities: [dynamicSubAgents({ sandboxAvailable: false, tracing: NOOP_AGENT_TRACING })],
      capabilityState: undefined,
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      // Default
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    };

    let thread_1 = new AgentThread(agentThreadInput);
    let childLLM: ILLM | undefined;

    const createSubAgentThread: CreateDynamicSubAgentThread = async ({
      parentDefinition,
      request,
      threadId,
      parent,
    }) => {
      childLLM = {
        create: jest.fn().mockImplementation(() => textReplyStream(CHILD_REPLY)),
        createNonStream: jest.fn().mockImplementation(() => textReplyStream(CHILD_REPLY)),
      };

      const agentDefinition: AgentDefinition = {
        modelClient: childLLM,
        instruction: undefined,
        messages: [{ role: 'user', content: request.input }],
        modelParams: parentDefinition.modelParams,
        responseFormat: undefined,
        iterationLimit: parentDefinition.iterationLimit,
        toolSets: undefined,
        modelId: undefined,
        configuredModels: undefined,
      };
      return new AgentThread({
        definition: agentDefinition,
        threadId,
        title: request.name,
        parent,
        agentInfo: request,
        context: undefined,
        currentContextUsage: undefined,
        preComputedCompletion: undefined,
        sandbox: undefined,
        capabilities: undefined,
        capabilityState: undefined,
        toolCallMemo: undefined,
        taskState: undefined,
        isRequestContinuation: undefined,
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
      });
    };

    let orchestratorInput: AgentThreadOrchestratorInput = {
      agentThreads: new Map([[thread_1.threadId, thread_1]]),
      createDynamicSubAgentThread: createSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    };

    const orchestrator = new AgentThreadOrchestrator(orchestratorInput);

    const { events, result } = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
    });

    expect(events).toMatchObject(EXPECTED_EVENTS);
    expect(result).toMatchObject(OUTPUT);
    expect(result.root_agent_error).toBeUndefined();
    expect(llmCreateInputs(thread_1.definition.modelClient)).toMatchObject(EXPECTED_ROOT_LLM_INPUT);
    if (childLLM === undefined) {
      throw new Error('expected child LLM to be created');
    }
  });
});
