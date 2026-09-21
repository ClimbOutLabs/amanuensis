import { createLogger, transports } from 'winston';

import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import {
  createToolCallMemoState,
  executeToolCalls,
  prepareSideEffectToolCalls,
  toToolCallMemoSnapshot,
} from '../../../src/core/mcp/executeToolCalls';

interface CallSpec {
  id: string;
  name: string;
  args?: Record<string, unknown> | undefined;
  effect?: InternalToolCallInfo['effect'];
  readOnlyHint?: boolean | undefined;
  clientSide?: boolean | undefined;
}

function assistantMessage(calls: CallSpec[]): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      tool_info: {
        type: 'mcp',
        mcp_server_id: 'test',
        mcp_server_name: 'test',
        original_tool_name: call.name,
        is_approval_required: false,
        effect: call.effect,
        read_only_hint: call.readOnlyHint,
        is_client_side: call.clientSide,
      },
    })),
  };
}

function trackingToolSet(name: string): { toolSet: IToolSet; callTool: jest.Mock } {
  const callTool = jest.fn(async () => toolResultResponse({ text: `result:${name}` }));
  const toolSet: IToolSet = {
    name,
    id: name,
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool,
  };
  return { toolSet, callTool };
}

function mappingFor(
  toolSet: IToolSet,
  specs: CallSpec[],
): Map<string, { toolSet: IToolSet; originalToolName: string }> {
  return new Map(specs.map(spec => [spec.name, { toolSet, originalToolName: spec.name }]));
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('parallel tool-call dispatch', () => {
  it('dispatches read-only calls concurrently while preserving input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const { toolSet, callTool } = trackingToolSet('inspector');
    callTool.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(25);
      active -= 1;
      return toolResultResponse({ text: 'inspected' });
    });
    const specs: CallSpec[] = [0, 1, 2, 3].map(n => ({
      id: `inspect-${n}`,
      name: `inspect_${n}`,
      args: { target: `file-${n}` },
      effect: 'inspect',
    }));

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults).toHaveLength(4);
    expect(maximumActive).toBeGreaterThan(1);
    expect(result.toolCallResults.map(item => item.message.tool_call_id)).toEqual(specs.map(spec => spec.id));
    expect(result.toolCallResults.every(item => !item.failure)).toBe(true);
  });

  it('caps concurrent read dispatch at the configured limit', async () => {
    let active = 0;
    let maximumActive = 0;
    const { toolSet, callTool } = trackingToolSet('inspector');
    callTool.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(20);
      active -= 1;
      return toolResultResponse({ text: 'inspected' });
    });
    const specs: CallSpec[] = Array.from({ length: 10 }, (_, n) => ({
      id: `read-${n}`,
      name: `read_${n}`,
      args: { target: `file-${n}` },
      effect: 'inspect',
    }));

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
      toolDispatchMaxConcurrency: 4,
    });

    expect(result.toolCallResults).toHaveLength(10);
    expect(maximumActive).toBe(4);
    expect(result.toolCallResults.map(item => item.message.tool_call_id)).toEqual(specs.map(spec => spec.id));
  });

  it('runs reads concurrently while stateful calls stay sequential and ordered', async () => {
    const spans = new Map<string, { start: number; end: number }>();
    const { toolSet, callTool } = trackingToolSet('mixed');
    callTool.mockImplementation(async request => {
      const startedAt = Date.now();
      await delay(25);
      spans.set(request.name, { start: startedAt, end: Date.now() });
      return toolResultResponse({ text: `result:${request.name}` });
    });
    const specs: CallSpec[] = [
      { id: 'read-1', name: 'inspect_a', args: { target: 'a' }, effect: 'inspect' },
      { id: 'edit-1', name: 'apply_patch', args: { patch: 'a' }, effect: 'edit' },
      { id: 'read-2', name: 'inspect_b', args: { target: 'b' }, effect: 'inspect' },
      { id: 'exec-1', name: 'run_cmd', args: { command: 'true' }, effect: 'execute' },
    ];

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults).toHaveLength(4);
    expect(result.toolCallResults.map(item => item.message.tool_call_id)).toEqual(specs.map(spec => spec.id));
    const readA = spans.get('inspect_a');
    const readB = spans.get('inspect_b');
    const edit = spans.get('apply_patch');
    const exec = spans.get('run_cmd');
    expect(readA).toBeDefined();
    expect(readB).toBeDefined();
    expect(edit).toBeDefined();
    expect(exec).toBeDefined();
    if (readA === undefined || readB === undefined || edit === undefined || exec === undefined) {
      return;
    }
    // The two reads overlapped in Phase A.
    expect(readA.start).toBeLessThan(readB.end);
    expect(readB.start).toBeLessThan(readA.end);
    // Phase B starts only after Phase A settles, and runs one call at a time.
    expect(edit.start).toBeGreaterThanOrEqual(Math.max(readA.end, readB.end));
    expect(exec.start).toBeGreaterThanOrEqual(edit.end);
  });

  it('times out a hung side-effect call as outcome_unknown and blocks an identical retry', async () => {
    const { toolSet, callTool } = trackingToolSet('sandbox');
    callTool.mockImplementation(() => new Promise<ReturnType<typeof toolResultResponse>>(() => {}));
    const mapping = new Map([['apply_patch', { toolSet, originalToolName: 'apply_patch' }]]);
    const specs: CallSpec[] = [{ id: 'edit-hung', name: 'apply_patch', args: { patch: 'x' }, effect: 'edit' }];
    const message = assistantMessage(specs);
    const memoState = createToolCallMemoState();
    const prepared = prepareSideEffectToolCalls({
      assistantMessage: message,
      toolMapping: mapping,
      approvalDecisions: new Map(),
      memoState,
    });
    expect(prepared.callIds).toContain('edit-hung');

    const result = await executeToolCalls({
      assistantMessage: message,
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
      preparedSideEffectCalls: prepared,
      toolCallTimeoutMs: 50,
    });

    expect(result.toolCallResults[0]).toMatchObject({
      disposition: 'outcome_unknown',
      remediation: { reason_code: 'execution_interrupted', suggested_action: 'inspect_state' },
    });
    expect(callTool).toHaveBeenCalledTimes(1);

    // The durable marker is retained, so an identical retry after recovery is
    // blocked instead of re-dispatching a call whose outcome is unknown.
    const recoveredMemo = createToolCallMemoState(toToolCallMemoSnapshot(memoState));
    const replayPrepared = prepareSideEffectToolCalls({
      assistantMessage: message,
      toolMapping: mapping,
      approvalDecisions: new Map(),
      memoState: recoveredMemo,
    });
    const replay = await executeToolCalls({
      assistantMessage: message,
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: recoveredMemo,
      preparedSideEffectCalls: replayPrepared,
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(replay.toolCallResults[0]).toMatchObject({ failure: true, repeatedSideEffect: true });
  });

  it('records abort-queued calls as never_ran and aborted mid-dispatch calls as outcome_unknown', async () => {
    const started: string[] = [];
    const { toolSet, callTool } = trackingToolSet('inspector');
    callTool.mockImplementation(async request => {
      started.push(request.name);
      await delay(100);
      return toolResultResponse({ text: 'inspected' });
    });
    const specs: CallSpec[] = [0, 1, 2].map(n => ({
      id: `read-${n}`,
      name: `inspect_${n}`,
      args: { target: `t${n}` },
      effect: 'inspect',
    }));
    const controller = new AbortController();
    const pending = executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
      signal: controller.signal,
      toolDispatchMaxConcurrency: 1,
    });
    await delay(30);
    controller.abort();
    const result = await pending;

    expect(result.toolCallResults.map(item => item.message.tool_call_id)).toEqual(specs.map(spec => spec.id));
    expect(result.toolCallResults.map(item => item.disposition)).toEqual(['outcome_unknown', 'never_ran', 'never_ran']);
    // Only the first call reached the provider; the queued calls never invoked it.
    expect(started).toEqual(['inspect_0']);
  });

  it('detaches a timed-out memoized read from the memo and logs its late settlement', async () => {
    const { toolSet, callTool } = trackingToolSet('inspector');
    let resolveProvider: ((value: ReturnType<typeof toolResultResponse>) => void) | undefined;
    const providerPromise = new Promise<ReturnType<typeof toolResultResponse>>(resolve => {
      resolveProvider = resolve;
    });
    callTool.mockImplementation(() => providerPromise);
    const specs: CallSpec[] = [{ id: 'read-late', name: 'inspect_late', args: { target: 't' }, effect: 'inspect' }];
    const logger = createLogger({ transports: [new transports.Console({ silent: true })] });
    const debugSpy = jest.spyOn(logger, 'debug');
    const memoState = createToolCallMemoState();

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
      toolCallTimeoutMs: 30,
      logger,
    });

    expect(result.toolCallResults[0]).toMatchObject({ disposition: 'outcome_unknown' });

    // The provider answers after the turn gave up waiting.
    resolveProvider?.(toolResultResponse({ text: 'late' }));
    await providerPromise;
    await delay(10);

    expect(memoState.entries.size).toBe(0);
    expect(memoState.inflight.size).toBe(0);
    expect(debugSpy).toHaveBeenCalledWith(
      'Tool provider settled after the dispatch deadline',
      expect.objectContaining({ toolCallId: 'read-late', outcome: 'resolved' }),
    );
    debugSpy.mockRestore();
  });

  it('keeps client-side read-only calls out of the concurrent phase', async () => {
    const spans = new Map<string, { start: number; end: number }>();
    const { toolSet, callTool } = trackingToolSet('mixed');
    callTool.mockImplementation(async request => {
      const startedAt = Date.now();
      await delay(request.name === 'slow_inspect' ? 60 : 0);
      spans.set(request.name, { start: startedAt, end: Date.now() });
      return toolResultResponse({ text: 'ok' });
    });
    const specs: CallSpec[] = [
      { id: 'read-slow', name: 'slow_inspect', args: { target: 'slow' }, effect: 'inspect' },
      { id: 'read-client', name: 'client_read', args: { target: 'c' }, readOnlyHint: true, clientSide: true },
    ];

    const result = await executeToolCalls({
      assistantMessage: assistantMessage(specs),
      toolMapping: mappingFor(toolSet, specs),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults).toHaveLength(2);
    const slow = spans.get('slow_inspect');
    const client = spans.get('client_read');
    expect(slow).toBeDefined();
    expect(client).toBeDefined();
    if (slow === undefined || client === undefined) {
      return;
    }
    // A client-side call resolves locally without provider I/O: it stays
    // concurrency-neutral in Phase B instead of overlapping Phase-A reads.
    expect(client.start).toBeGreaterThanOrEqual(slow.end);
  });
});
