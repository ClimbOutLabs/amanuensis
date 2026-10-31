/**
 * The outcome line's level routing: a call to a tool that is not in the mapping already drew
 * the canonical unknown-tool warning where the call was first seen, so its outcome line logs
 * at info and the case carries exactly one warning in total. Every other failure still logs
 * its outcome line at warn, exactly once, memoized replays included.
 */
import type { ToolCallResult } from '../../../src/core/mcp/executeToolCalls';
import { logToolCallOutcome } from '../../../src/core/runtime/AgentThread';
import { makeSilentLogger } from '../harnessMocks';

const silentLogger = makeSilentLogger();
const info = jest.spyOn(silentLogger, 'info');
const warn = jest.spyOn(silentLogger, 'warn');

function makeResult(overrides: Partial<ToolCallResult>): ToolCallResult {
  const base: ToolCallResult = {
    message: { role: 'tool', tool_call_id: 'call-1', content: 'result text' },
    rawContent: 'result text',
    toolCallInfo: undefined,
    screen: undefined,
    info: undefined,
    failure: true,
    isStructuredContent: false,
    completedAt: '2026-10-27T00:00:00.000Z',
    memoized: false,
    repeatCount: 1,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'never_ran',
    remediation: undefined,
    admissionProvenance: { source: 'internal' },
    images: [],
  };
  return { ...base, ...overrides };
}

describe('logToolCallOutcome levels', () => {
  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
  });

  it('logs the unknown-tool outcome at info, so the canonical warning stays the only warning', () => {
    logToolCallOutcome(silentLogger, {
      toolName: 'totally_unknown_tool',
      result: makeResult({
        message: {
          role: 'tool',
          tool_call_id: 'call-unknown',
          content: 'Tool totally_unknown_tool not found in tool mapping',
        },
        rawContent: 'Tool totally_unknown_tool not found in tool mapping',
        disposition: 'never_ran',
        remediation: {
          reason_code: 'unknown_tool',
          message: 'Use only a tool that is available in this conversation, or continue without a tool.',
          suggested_action: 'change_strategy',
        },
      }),
    });

    expect(warn).toHaveBeenCalledTimes(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Tool call totally_unknown_tool: never_ran', {
      toolCallId: 'call-unknown',
      toolName: 'totally_unknown_tool',
      disposition: 'never_ran',
      error: 'Tool totally_unknown_tool not found in tool mapping',
    });
  });

  it('still logs a policy-blocked outcome at warn, exactly once', () => {
    logToolCallOutcome(silentLogger, {
      toolName: 'lookup',
      result: makeResult({
        message: { role: 'tool', tool_call_id: 'call-blocked', content: '{"error":"Blocked before it could run."}' },
        rawContent: '{"error":"Blocked before it could run."}',
        disposition: 'policy_blocked',
        remediation: {
          reason_code: 'tool_policy_blocked',
          message: 'Use a tool that is allowed in this conversation or change strategy.',
          suggested_action: 'change_strategy',
        },
      }),
    });

    expect(info).toHaveBeenCalledTimes(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Tool call lookup: policy_blocked', {
      toolCallId: 'call-blocked',
      toolName: 'lookup',
      disposition: 'policy_blocked',
      error: 'Blocked before it could run.',
    });
  });

  it('still logs a memoized failure at warn, exactly once, with its memoized flag', () => {
    logToolCallOutcome(silentLogger, {
      toolName: 'lookup',
      result: makeResult({
        message: { role: 'tool', tool_call_id: 'call-memo', content: '{"error":"The tool could not be prepared."}' },
        rawContent: '{"error":"The tool could not be prepared."}',
        disposition: 'never_ran',
        memoized: true,
        remediation: {
          reason_code: 'tool_pre_dispatch_failed',
          message: 'The tool could not be prepared and was not executed. Retry once or choose another tool.',
          suggested_action: 'retry',
        },
      }),
    });

    expect(info).toHaveBeenCalledTimes(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Tool call lookup: never_ran', {
      toolCallId: 'call-memo',
      toolName: 'lookup',
      disposition: 'never_ran',
      memoized: true,
      error: 'The tool could not be prepared.',
    });
  });

  it('still logs a memoized success at info, exactly once, with its memoized flag', () => {
    logToolCallOutcome(silentLogger, {
      toolName: 'lookup',
      result: makeResult({
        failure: false,
        disposition: 'executed_ok',
        memoized: true,
      }),
    });

    expect(warn).toHaveBeenCalledTimes(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Tool call lookup: executed_ok', {
      toolCallId: 'call-1',
      toolName: 'lookup',
      disposition: 'executed_ok',
      memoized: true,
    });
  });
});
