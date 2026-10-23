import { createTurnToolCallLedger, mergeTurnToolCallLedgers } from '../../../src/core/mcp/executeToolCalls';
import {
  clearUnfinished,
  DEFAULT_REPLY_STEP_BUDGET,
  recordUnfinished,
  REMOVED_TOOL_RESULT,
  removedToolMessage,
  retryIsDue,
  settleRetry,
  stepBudgetFor,
  toolResultKind,
  ToolResultKindSchema,
  unfinishedKindFor,
  UnfinishedKindSchema,
  unfinishedNotice,
  withoutUnfinishedNotices,
} from '../../../src/core/runtime/replyBudget';

const ok = {
  disposition: 'executed_ok',
  failure: false,
  unavailable: false,
  removed: false,
  expired: false,
} as const;

describe('toolResultKind', () => {
  it('maps each disposition to one kind', () => {
    expect(toolResultKind(ok)).toBe('ok');
    expect(toolResultKind({ ...ok, disposition: 'denied' })).toBe('declined');
    expect(toolResultKind({ ...ok, disposition: 'policy_blocked' })).toBe('blocked');
    expect(toolResultKind({ ...ok, disposition: 'executed_nonzero' })).toBe('error_retryable');
    expect(toolResultKind({ ...ok, disposition: 'never_ran' })).toBe('error_retryable');
    expect(toolResultKind({ ...ok, disposition: 'outcome_unknown' })).toBe('error_final');
  });

  it('keeps a rule block to its own call: it is a block, never a decline', () => {
    expect(toolResultKind({ ...ok, disposition: 'policy_blocked' })).toBe('blocked');
    expect(unfinishedKindFor('blocked')).toBe('blocked');
  });

  it('tells a card that expired unanswered from the person saying no', () => {
    expect(toolResultKind({ ...ok, disposition: 'denied', expired: true })).toBe('expired');
    expect(unfinishedKindFor('expired')).toBe('expired');
    expect(unfinishedNotice('expired')).not.toMatch(/you said no|declined|held off/i);
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
  it('gives the main thread 8 steps and each sub-agent 4 by default', () => {
    expect(stepBudgetFor({ isSubAgent: false, budget: DEFAULT_REPLY_STEP_BUDGET })).toBe(8);
    expect(stepBudgetFor({ isSubAgent: true, budget: DEFAULT_REPLY_STEP_BUDGET })).toBe(4);
  });

  it('takes its numbers from the budget it is given', () => {
    expect(stepBudgetFor({ isSubAgent: false, budget: { main: 3, sub: 2 } })).toBe(3);
    expect(stepBudgetFor({ isSubAgent: true, budget: { main: 3, sub: 2 } })).toBe(2);
  });
});

describe('removed tool wording', () => {
  it('says what the person declined, in plain words, and what to do next', () => {
    expect(removedToolMessage({ toolName: 'create_event', reason: 'declined' })).toBe(
      'The person declined create event. Do not try it again or ask again. Say once, plainly, that it was skipped, and carry on with the rest.',
    );
    expect(removedToolMessage({ toolName: 'create_event', reason: 'unavailable' })).toBe(
      'create event is not available here. Do not try it again. Tell them what you did and did not do.',
    );
    expect(REMOVED_TOOL_RESULT).toContain('removed from this reply');
  });
});

describe('unfinished reply', () => {
  it('gives one plain sentence with a next step for each reason', () => {
    expect(unfinishedKindFor('ok')).toBeNull();
    expect(unfinishedKindFor('declined')).toBe('declined');
    expect(unfinishedKindFor('error_final')).toBe('failed');
    expect(unfinishedNotice('declined')).toBe('Skipped, as you asked.');
    expect(unfinishedNotice('failed')).toBe('One step failed, so this is not finished. Reply "try again" to retry.');
    expect(unfinishedNotice('budget')).toBe(
      'Stopped after many steps without finishing. Reply "continue" to carry on.',
    );
  });

  it('keeps the first reason, so a later failure cannot overwrite it', () => {
    const failed = recordUnfinished({ current: undefined, kind: 'failed' });
    expect(recordUnfinished({ current: failed, kind: 'budget' })).toBe('failed');
  });

  it('lets a decline or an unavailable tool replace the reason, and keeps it through a clean step', () => {
    const declined = recordUnfinished({ current: 'failed', kind: 'declined' });
    expect(declined).toBe('declined');
    expect(clearUnfinished({ current: declined })).toBe('declined');
    expect(clearUnfinished({ current: 'failed' })).toBeUndefined();
  });

  it('keeps an expired card as the reason through a clean step', () => {
    expect(recordUnfinished({ current: 'failed', kind: 'expired' })).toBe('expired');
    expect(clearUnfinished({ current: 'expired' })).toBe('expired');
  });

  it("names no assistant and only reads as the person's choice for their own decline", () => {
    for (const kind of UnfinishedKindSchema.options) {
      const line = unfinishedNotice(kind);
      expect(line).not.toMatch(/\bAman\b/);
      expect(/as you asked|you said no|you declined/i.test(line)).toBe(kind === 'declined');
    }
  });

  it("leaves an older version's line out of an earlier reply the model reads again", () => {
    const answer = 'Understood, skipping the reminder.';
    const older = 'You said no to one step, so Aman did not finish. Ask again if you want that step done.';
    expect(withoutUnfinishedNotices(`${answer}\n\n${older}`)).toBe(answer);
    expect(withoutUnfinishedNotices(answer)).toBe(answer);
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

  it('keeps each thread its own rejection streak and its own reason', () => {
    const root = createTurnToolCallLedger();
    root.removedToolRejectionStreaks.set('main', 1);
    root.unfinishedByThread.set('main', 'failed');
    const child = createTurnToolCallLedger();
    child.removedToolRejectionStreaks.set('sub-1', 2);
    child.unfinishedByThread.set('sub-1', 'blocked');

    const merged = mergeTurnToolCallLedgers([root, child]);

    expect(merged.removedToolRejectionStreaks.get('main')).toBe(1);
    expect(merged.removedToolRejectionStreaks.get('sub-1')).toBe(2);
    expect(merged.unfinishedByThread.get('main')).toBe('failed');
    expect(merged.unfinishedByThread.get('sub-1')).toBe('blocked');
  });
});
