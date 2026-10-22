import { createTurnToolCallLedger, mergeTurnToolCallLedgers } from '../../../src/core/mcp/executeToolCalls';
import {
  MAIN_THREAD_STEP_BUDGET,
  REMOVED_TOOL_RESULT,
  SUB_AGENT_STEP_BUDGET,
  ToolResultKindSchema,
  removedToolMessage,
  retryIsDue,
  settleRetry,
  stepBudgetFor,
  toolResultKind,
  unfinishedNotice,
  unfinishedReasonFor,
} from '../../../src/core/runtime/replyBudget';

const ok = {
  disposition: 'executed_ok',
  failure: false,
  unavailable: false,
  removed: false,
  ruleRefused: false,
} as const;

describe('toolResultKind', () => {
  it('maps each disposition to one kind', () => {
    expect(toolResultKind(ok)).toBe('ok');
    expect(toolResultKind({ ...ok, disposition: 'denied' })).toBe('refused');
    expect(toolResultKind({ ...ok, disposition: 'policy_blocked', ruleRefused: true })).toBe('refused');
    expect(toolResultKind({ ...ok, disposition: 'executed_nonzero' })).toBe('error_retryable');
    expect(toolResultKind({ ...ok, disposition: 'never_ran' })).toBe('error_retryable');
    expect(toolResultKind({ ...ok, disposition: 'outcome_unknown' })).toBe('error_final');
  });

  it('treats a policy block without the tool policy rule as a step to fix, not a refusal', () => {
    expect(toolResultKind({ ...ok, disposition: 'policy_blocked', ruleRefused: false })).toBe('error_retryable');
  });

  it('marks an executed call that reported a failure as retryable', () => {
    expect(toolResultKind({ ...ok, failure: true })).toBe('error_retryable');
  });

  it('marks a tool that is not in this chat as unavailable, whatever the disposition', () => {
    expect(toolResultKind({ ...ok, disposition: 'never_ran', unavailable: true })).toBe('unavailable');
  });

  it('makes a call to an already removed tool final, since it was rejected unrun', () => {
    expect(toolResultKind({ ...ok, disposition: 'never_ran', removed: true })).toBe('error_final');
  });

  it('only ever yields a kind from the schema', () => {
    for (const disposition of [
      'executed_ok',
      'denied',
      'policy_blocked',
      'never_ran',
      'executed_nonzero',
      'outcome_unknown',
    ] as const) {
      expect(ToolResultKindSchema.safeParse(toolResultKind({ ...ok, disposition })).success).toBe(true);
    }
  });
});

describe('retry', () => {
  it('lets a retryable error retry once and then makes it final', () => {
    const first = settleRetry({ previousKind: null, previousRetried: false, kind: 'error_retryable' });
    expect(first).toEqual({ kind: 'error_retryable', retried: false });
    expect(retryIsDue({ lastKind: first.kind, retried: first.retried })).toBe(true);

    const second = settleRetry({ previousKind: first.kind, previousRetried: first.retried, kind: 'error_retryable' });
    expect(second).toEqual({ kind: 'error_final', retried: true });
    expect(retryIsDue({ lastKind: second.kind, retried: second.retried })).toBe(false);
  });

  it('does not spend a retry on a call that succeeded', () => {
    expect(settleRetry({ previousKind: 'error_retryable', previousRetried: false, kind: 'ok' })).toEqual({
      kind: 'ok',
      retried: true,
    });
  });
});

describe('step budget', () => {
  it('gives the main thread 8 steps and each sub-agent 4', () => {
    expect(stepBudgetFor({ isSubAgent: false })).toBe(MAIN_THREAD_STEP_BUDGET);
    expect(stepBudgetFor({ isSubAgent: true })).toBe(SUB_AGENT_STEP_BUDGET);
    expect([MAIN_THREAD_STEP_BUDGET, SUB_AGENT_STEP_BUDGET]).toEqual([8, 4]);
  });
});

describe('removed tool wording', () => {
  it('says what the person declined, in plain words, and what to do next', () => {
    expect(removedToolMessage({ toolName: 'create_event', reason: 'declined' })).toBe(
      'The person declined create event. Do not try it again. Tell them what you did and did not do.',
    );
    expect(removedToolMessage({ toolName: 'create_event', reason: 'unavailable' })).toBe(
      'create event is not available here. Do not try it again. Tell them what you did and did not do.',
    );
    expect(REMOVED_TOOL_RESULT).toContain('removed from this reply');
  });
});

describe('unfinished reply', () => {
  it('gives a plain reason for each kind that did not finish', () => {
    expect(unfinishedReasonFor('ok')).toBeNull();
    expect(unfinishedReasonFor('refused')).toBe('a step was declined');
    expect(unfinishedReasonFor('error_final')).toBe('a step failed');
    expect(unfinishedNotice('a step failed')).toBe('Not finished: a step failed.');
  });
});

describe('ledger', () => {
  it('keeps the largest step count per thread and the union of removed tools', () => {
    const root = createTurnToolCallLedger();
    root.stepsByThread.set('main', 3);
    root.removedTools.push('create_event');
    const child = createTurnToolCallLedger();
    child.stepsByThread.set('main', 5);
    child.stepsByThread.set('sub-1', 2);
    child.removedTools.push('create_event', 'send_mail');

    const merged = mergeTurnToolCallLedgers([root, child]);

    expect(merged.stepsByThread.get('main')).toBe(5);
    expect(merged.stepsByThread.get('sub-1')).toBe(2);
    expect(merged.removedTools).toEqual(['create_event', 'send_mail']);
  });
});
