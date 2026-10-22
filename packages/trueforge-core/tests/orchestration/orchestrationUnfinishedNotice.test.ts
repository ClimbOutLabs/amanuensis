/** The line that ends a reply which did not finish: it names the true reason, and only on that reply. */
import { EventType } from '../../src/core/events/schema';
import type { IToolSet } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { approvalExpiredReason } from '../../src/core/permissions/approvalExpiry';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import type { AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { unfinishedNotice } from '../../src/core/runtime/replyBudget';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import {
  llmCreateInputs,
  makeApprovalGatedWriteNoteToolSet,
  runTurn,
  textReplyStream,
  WRITE_NOTE_CALL_ID,
  WRITE_NOTE_TOOL_NAME,
  writeNoteToolCallStream,
} from './helpers/helpers';

const ROOT_ID = 'thread_root';
const DECLINE_LINE = unfinishedNotice('declined');
const EXPIRED_LINE = unfinishedNotice('expired');
const BLOCKED_LINE = unfinishedNotice('blocked');
const SAID_NO = /you said no|you declined|you held off|the person declined/i;

function harness(toolSet: IToolSet, replies: readonly string[]) {
  const create = jest.fn().mockImplementationOnce(() => writeNoteToolCallStream());
  for (const reply of replies) {
    create.mockImplementationOnce(() => textReplyStream(reply));
  }
  const input: AgentThreadConstructorInput = {
    definition: {
      modelClient: { create, createNonStream: jest.fn() },
      instruction: 'You are running in a test setup.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: undefined,
      modelId: undefined,
      configuredModels: undefined,
    },
    threadId: ROOT_ID,
    title: 'unfinished-notice',
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
  const thread = new AgentThread(input);
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent')),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  return { orchestrator, thread };
}

/** A write_note tool that a rule blocks before it runs: no card, no answer from the person. */
function ruleBlockedWriteNoteToolSet(): IToolSet {
  return new ToolSet({
    source: {
      name: 'notes',
      id: 'notes',
      listTools: () =>
        Promise.resolve({
          result: {
            tools: [
              {
                name: WRITE_NOTE_TOOL_NAME,
                description: 'Write a note',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                preload: true,
              },
            ],
          },
          wasInitialized: undefined,
        }),
      callTool: () => Promise.resolve(toolResultResponse({ text: 'note written' })),
      toolCallInfo: () =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: 'notes',
          mcp_server_name: 'notes',
          original_tool_name: WRITE_NOTE_TOOL_NAME,
          pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied: offline mode is on.' },
        }),
    },
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    preload: true,
  });
}

/** Every message the model was sent on its last call, as text. */
function lastModelMessages(thread: AgentThread): string {
  const inputs = llmCreateInputs(thread.definition.modelClient);
  return JSON.stringify(inputs.at(-1));
}

function denyTurn(reason: string) {
  return [
    {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: ROOT_ID,
      tool_call_id: WRITE_NOTE_CALL_ID,
      approval: { status: 'deny' as const, reason },
    },
  ];
}

describe('unfinished reply notice', () => {
  it('says a card that expired unanswered expired, and never that the person said no', async () => {
    const { toolSet, callTool } = makeApprovalGatedWriteNoteToolSet();
    const { orchestrator, thread } = harness(toolSet, ['The note was not written.']);

    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const expired = await runTurn({ orchestrator, sendBatch: denyTurn(approvalExpiredReason()) });

    expect(callTool).not.toHaveBeenCalled();
    expect(expired.result.output?.content).toContain(EXPIRED_LINE);
    expect(expired.result.output?.content).not.toMatch(SAID_NO);
    // The model reads the true reason, so it has no grounds to say the person declined.
    const sent = lastModelMessages(thread);
    expect(sent).toContain('They did not say no');
    expect(sent).not.toMatch(SAID_NO);
  });

  it('reports a rule-blocked call as blocked, not as a decline', async () => {
    const { orchestrator, thread } = harness(ruleBlockedWriteNoteToolSet(), ['I could not write the note.']);

    const blocked = await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });

    expect(blocked.result.output?.content).toContain(BLOCKED_LINE);
    expect(blocked.result.output?.content).not.toMatch(SAID_NO);
    expect(lastModelMessages(thread)).not.toMatch(SAID_NO);
  });

  it('adds the decline line only to the reply that had the decline', async () => {
    const { toolSet } = makeApprovalGatedWriteNoteToolSet();
    const { orchestrator, thread } = harness(toolSet, ['Skipping the note.', 'Here is a plan for today.']);

    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const declined = await runTurn({ orchestrator, sendBatch: denyTurn('not now') });
    expect(declined.result.output?.content).toContain(DECLINE_LINE);

    const later = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'what should I do first?' }],
    });

    expect(later.result.output?.content).toBe('Here is a plan for today.');
    // The earlier line is the person's, not the model's: left in, the model repeats it on replies it does not fit.
    expect(lastModelMessages(thread)).not.toContain(DECLINE_LINE);
  });
});
