/** Pause on write_note approval, then resume after allow or deny. */
import { createToolResponseV2, EventType } from '../../src/core/events/schema';
import { changeRequestReason } from '../../src/core/permissions/changeRequest';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import {
  llmCreateInputs,
  makeApprovalGatedWriteNoteToolSet,
  runTurn,
  textReplyStream,
  WRITE_NOTE_ARGUMENTS,
  WRITE_NOTE_CALL_ID,
  WRITE_NOTE_RESULT,
  WRITE_NOTE_TOOL_NAME,
  writeNoteToolCallStream,
} from './helpers/helpers';

const ROOT_ID = 'thread_root';
const DENY_REASON = 'not allowed in this test';
/** ToolSet deny → isError path surfaces the structured error payload for context. */
const DENY_RAW_CONTENT = JSON.stringify({ error: `User denied tool call: ${DENY_REASON}` });
const INSTRUCTION = 'You are running in a test setup.';

// Every host-produced terminal tool result now carries the canonical wrapped shape
// (schema_version/outcome/result), both in the tool.response.v2 event and the model-facing
// tool message; build the expected wire content from the same constructor the runtime uses.
const WRITE_NOTE_TOOL_RESULT_CONTENT = createToolResponseV2({
  id: 'unused',
  thread_id: ROOT_ID,
  tool_call_id: WRITE_NOTE_CALL_ID,
  created_at: 'unused',
  raw_content: WRITE_NOTE_RESULT,
  model_content: null,
  screen: null,
  admission_provenance: { source: 'user_approval', decision: 'allow' },
  memoized: false,
  repeat_count: 1,
  disposition: 'executed_ok',
  remediation: undefined,
}).model_message.content;

const DENY_TOOL_CONTENT = createToolResponseV2({
  id: 'unused',
  thread_id: ROOT_ID,
  tool_call_id: WRITE_NOTE_CALL_ID,
  created_at: 'unused',
  raw_content: DENY_RAW_CONTENT,
  model_content: null,
  screen: null,
  admission_provenance: { source: 'user_approval', decision: 'deny' },
  memoized: false,
  repeat_count: 1,
  disposition: 'denied',
  remediation: undefined,
}).model_message.content;

const WRITE_NOTE_TOOLS = [{ function: { name: WRITE_NOTE_TOOL_NAME } }];

const EXPECTED_TURN_1_EVENTS = [
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
            id: WRITE_NOTE_CALL_ID,
            type: 'function',
            function: { name: WRITE_NOTE_TOOL_NAME, arguments: WRITE_NOTE_ARGUMENTS },
          },
        ],
      },
    ],
  },
  {
    type: EventType.TOOL_APPROVAL_REQUIRED,
    thread_id: ROOT_ID,
    tool_calls: [{ id: WRITE_NOTE_CALL_ID }],
  },
];

const TURN_1_OUTPUT = {
  output: null,
  required_actions: [
    {
      type: EventType.TOOL_APPROVAL_REQUIRED,
      thread_id: ROOT_ID,
      tool_calls: [{ id: WRITE_NOTE_CALL_ID }],
    },
  ],
};

const EXPECTED_TURN_1_LLM_INPUT = [
  {
    tools: WRITE_NOTE_TOOLS,
    messages: [
      { role: 'system', content: expect.stringContaining(INSTRUCTION) },
      { role: 'user', content: 'hello' },
    ],
  },
];

describe('orchestration: pause then resume on tool approval', () => {
  describe('allow', () => {
    const ROOT_FINAL = 'note saved';

    const EXPECTED_TURN_2_EVENTS = [
      // Durable invocation admission: the execution boundary is recorded before dispatch.
      { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID },
      { type: EventType.TOOL_EXECUTION_STARTED, thread_id: ROOT_ID, tool_call_id: WRITE_NOTE_CALL_ID },
      { type: EventType.TOOL_RESPONSE_V2, thread_id: ROOT_ID, tool_call_id: WRITE_NOTE_CALL_ID },
      {
        type: InternalEventType.AGENT_CONTEXT_APPEND,
        thread_id: ROOT_ID,
        context: [{ role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: WRITE_NOTE_TOOL_RESULT_CONTENT }],
      },
      { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
      { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID, content: ROOT_FINAL },
      {
        type: InternalEventType.AGENT_CONTEXT_APPEND,
        thread_id: ROOT_ID,
        context: [{ role: 'assistant', content: ROOT_FINAL }],
      },
      { type: InternalEventType.AGENT_DONE, thread_id: ROOT_ID, status: 'done' },
    ];

    const TURN_2_OUTPUT = {
      output: { thread_id: ROOT_ID, content: ROOT_FINAL },
      required_actions: [],
    };

    const EXPECTED_TURN_2_INPUT = {
      tools: WRITE_NOTE_TOOLS,
      messages: [
        { role: 'system', content: expect.stringContaining(INSTRUCTION) },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: WRITE_NOTE_CALL_ID,
              type: 'function',
              function: { name: WRITE_NOTE_TOOL_NAME, arguments: WRITE_NOTE_ARGUMENTS },
            },
          ],
        },
        { role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: WRITE_NOTE_TOOL_RESULT_CONTENT },
      ],
    };

    it('pauses for write_note approval, then finishes after allow', async () => {
      const { orchestrator, thread, callTool } = makeApprovalHarness(ROOT_FINAL);

      const paused = await runTurn({
        orchestrator,
        sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      });
      expect(paused.events).toMatchObject(EXPECTED_TURN_1_EVENTS);
      expect(paused.result).toMatchObject(TURN_1_OUTPUT);
      expect(paused.result.root_agent_error).toBeUndefined();
      expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject(EXPECTED_TURN_1_LLM_INPUT);
      expect(callTool).not.toHaveBeenCalled();

      const resumed = await runTurn({
        orchestrator,
        sendBatch: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: ROOT_ID,
            tool_call_id: WRITE_NOTE_CALL_ID,
            approval: { status: 'allow' },
          },
        ],
      });
      expect(resumed.events).toMatchObject(EXPECTED_TURN_2_EVENTS);
      expect(resumed.result).toMatchObject(TURN_2_OUTPUT);
      expect(resumed.result.root_agent_error).toBeUndefined();
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject([
        ...EXPECTED_TURN_1_LLM_INPUT,
        EXPECTED_TURN_2_INPUT,
      ]);
    });
  });

  describe('deny', () => {
    const ROOT_FINAL = 'ok, I will not write the note';

    const EXPECTED_TURN_2_EVENTS = [
      { type: EventType.TOOL_RESPONSE_V2, thread_id: ROOT_ID, tool_call_id: WRITE_NOTE_CALL_ID },
      {
        type: InternalEventType.AGENT_CONTEXT_APPEND,
        thread_id: ROOT_ID,
        context: [
          { role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: DENY_TOOL_CONTENT },
          { role: 'user', content: expect.stringContaining('The person declined write note') },
        ],
      },
      { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
      { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID, content: ROOT_FINAL },
      {
        type: EventType.MODEL_MESSAGE_DELTA,
        thread_id: ROOT_ID,
        content: expect.stringContaining('Not finished: a step was declined.'),
      },
      {
        type: InternalEventType.AGENT_CONTEXT_APPEND,
        thread_id: ROOT_ID,
        context: [{ role: 'assistant', content: expect.stringContaining(ROOT_FINAL) }],
      },
      { type: InternalEventType.AGENT_DONE, thread_id: ROOT_ID, status: 'done' },
    ];

    const TURN_2_OUTPUT = {
      output: {
        thread_id: ROOT_ID,
        content: expect.stringContaining('Not finished: a step was declined.'),
      },
      required_actions: [],
    };

    const EXPECTED_TURN_2_INPUT = {
      messages: [
        { role: 'system', content: expect.stringContaining(INSTRUCTION) },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: WRITE_NOTE_CALL_ID,
              type: 'function',
              function: { name: WRITE_NOTE_TOOL_NAME, arguments: WRITE_NOTE_ARGUMENTS },
            },
          ],
        },
        { role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: DENY_TOOL_CONTENT },
        { role: 'user', content: expect.stringContaining('The person declined write note') },
      ],
    };

    it('pauses for write_note approval, then finishes after deny without running the tool', async () => {
      const { orchestrator, thread, callTool } = makeApprovalHarness(ROOT_FINAL);

      const paused = await runTurn({
        orchestrator,
        sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      });
      expect(paused.events).toMatchObject(EXPECTED_TURN_1_EVENTS);
      expect(paused.result).toMatchObject(TURN_1_OUTPUT);
      expect(callTool).not.toHaveBeenCalled();

      // Deny is a new turn (send + execute), same as allow — turn 1 already stopped at approval.
      const resumed = await runTurn({
        orchestrator,
        sendBatch: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: ROOT_ID,
            tool_call_id: WRITE_NOTE_CALL_ID,
            approval: { status: 'deny', reason: DENY_REASON },
          },
        ],
      });
      expect(resumed.events).toMatchObject(EXPECTED_TURN_2_EVENTS);
      expect(resumed.result).toMatchObject(TURN_2_OUTPUT);
      expect(resumed.result.root_agent_error).toBeUndefined();
      expect(callTool).not.toHaveBeenCalled();
      expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject([
        ...EXPECTED_TURN_1_LLM_INPUT,
        EXPECTED_TURN_2_INPUT,
      ]);
    });
  });

  describe('change it', () => {
    const ROOT_FINAL = 'note saved';
    const CHANGE_TEXT = 'make it shorter';
    const CHANGE_REQUEST_SENTENCE =
      'The person asked for changes before approving: make it shorter. Make the changes and propose it again.';
    const REVISED_CALL_ID = 'call-write-revised';

    it('never runs the tool and hands the model the words the person asked for', async () => {
      const { orchestrator, thread, callTool } = makeApprovalHarness(ROOT_FINAL);

      await runTurn({
        orchestrator,
        sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      });
      const resumed = await runTurn({
        orchestrator,
        sendBatch: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: ROOT_ID,
            tool_call_id: WRITE_NOTE_CALL_ID,
            approval: { status: 'deny', reason: changeRequestReason(CHANGE_TEXT) },
          },
        ],
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(resumed.result.root_agent_error).toBeUndefined();
      expect(llmCreateInputs(thread.definition.modelClient)).toContainEqual(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'tool',
              tool_call_id: WRITE_NOTE_CALL_ID,
              content: expect.stringContaining(`"result":"${CHANGE_REQUEST_SENTENCE}"`),
            }),
          ]),
        }),
      );
    });

    it('lets the model propose a revised call that needs its own approval', async () => {
      const { orchestrator, callTool } = makeApprovalHarness(ROOT_FINAL, REVISED_CALL_ID);

      await runTurn({
        orchestrator,
        sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      });
      await runTurn({
        orchestrator,
        sendBatch: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: ROOT_ID,
            tool_call_id: WRITE_NOTE_CALL_ID,
            approval: { status: 'deny', reason: changeRequestReason(CHANGE_TEXT) },
          },
        ],
      });
      // A later message asks the model to try again, so the revised call comes in a new turn.
      const revised = await runTurn({
        orchestrator,
        sendBatch: [{ type: EventType.USER_MESSAGE, content: 'try again' }],
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(revised.result.required_actions).toMatchObject([
        {
          type: EventType.TOOL_APPROVAL_REQUIRED,
          thread_id: ROOT_ID,
          tool_calls: [{ id: REVISED_CALL_ID }],
        },
      ]);
    });
  });
});

function makeApprovalHarness(
  finalReply: string,
  revisedCallId?: string,
): {
  orchestrator: AgentThreadOrchestrator;
  thread: AgentThread;
  callTool: jest.Mock;
} {
  const { toolSet, callTool } = makeApprovalGatedWriteNoteToolSet();
  const agentThreadInput: AgentThreadConstructorInput = {
    definition: {
      modelClient: {
        create: jest
          .fn()
          .mockImplementationOnce(() => writeNoteToolCallStream())
          .mockImplementationOnce(() => textReplyStream(finalReply))
          .mockImplementationOnce(() =>
            revisedCallId === undefined ? textReplyStream(finalReply) : writeNoteToolCallStream(revisedCallId),
          )
          .mockImplementation(() => textReplyStream(finalReply)),
        createNonStream: jest.fn(),
      },
      instruction: INSTRUCTION,
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: undefined,
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: ROOT_ID,
    title: 'orchestration-approval',
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: [
      {
        systemToolSets: [toolSet],
        preSendProcessors: undefined,
        preLLMProcessors: undefined,
        preLLMEphemeralProcessors: undefined,
        postToolCallProcessors: undefined,
        toolResponseProcessors: undefined,
        instructionBuilders: undefined,
      },
    ],
    capabilityState: undefined,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  };

  const thread = new AgentThread(agentThreadInput);
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent in approval test')),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  return { orchestrator, thread, callTool };
}
