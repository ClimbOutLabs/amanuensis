import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import {
  APPROVAL_AUTO_DENY_MINUTES,
  approvalAutoDenyReason,
  createSessionResyncExtensions,
  isPendingApprovalsError,
  publishBlockedSend,
  subscribeToBlockedSend,
} from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';

function approvalRequired(createdAt: string): TrueForgeApi.ToolApprovalRequiredEvent {
  return {
    type: 'tool.approval_required',
    id: 'evt_approval',
    threadId: 'main',
    createdAt,
    toolCalls: [{ id: 'call_1', sourceEventId: 'evt_model' }],
  };
}

function doneTurn(overrides: Partial<TrueForgeApi.Turn> = {}): TrueForgeApi.Turn {
  return {
    id: 'trn_1',
    sessionId: 'ses_1',
    createdAt: '2026-09-25T00:00:00.000Z',
    input: [],
    previousTurnId: null,
    state: {
      status: 'done',
      completedAt: '2026-09-25T00:00:01.000Z',
      output: null,
      requiredActions: [],
    },
    ...overrides,
  } as TrueForgeApi.Turn;
}

interface FakeSessions {
  listTurns: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
  createTurnStream: ReturnType<typeof vi.fn>;
  getTurn: ReturnType<typeof vi.fn>;
}

/**
 * A session with these turns in creation order. Mirrors the server: `listTurns` is oldest-first,
 * the event feed is newest-first on the active branch.
 */
function fakeTurns(turns: TrueForgeApi.Turn[]): Partial<FakeSessions> {
  return {
    listTurns: vi.fn(async (_sessionId: string, request?: { limit?: number }) => ({
      data: turns.slice(0, request?.limit ?? turns.length),
    })),
    listEvents: vi.fn(async (_sessionId: string, request?: { limit?: number }) => ({
      data: turns
        .toReversed()
        .slice(0, request?.limit ?? turns.length)
        .map(turn => ({ turnId: turn.id, event: { type: 'turn.created', id: `evt_${turn.id}` } })),
    })),
    getTurn: vi.fn(async (_sessionId: string, turnId: string) => ({
      data: turns.find(turn => turn.id === turnId),
    })),
  };
}

function pausedTurn(id: string): TrueForgeApi.Turn {
  return doneTurn({
    id,
    state: {
      status: 'done',
      completedAt: '2026-09-25T00:00:01.000Z',
      output: null,
      requiredActions: [approvalRequired('2026-09-25T00:00:00.000Z')],
    },
  });
}

function createFakeClient(sessions: Partial<FakeSessions>): {
  extensions: ReturnType<typeof createSessionResyncExtensions>;
  sessions: FakeSessions;
} {
  const full: FakeSessions = {
    listTurns: vi.fn(async () => ({ data: [] })),
    listEvents: vi.fn(async () => ({ data: [] })),
    createTurnStream: vi.fn(async () => {
      async function* empty(): AsyncGenerator<never> {
        // no events
      }
      return empty();
    }),
    getTurn: vi.fn(),
    ...sessions,
  };
  const extensions = createSessionResyncExtensions({
    sessions: full,
  } as unknown as Pick<TrueForge, 'sessions'>);
  return { extensions, sessions: full };
}

describe('isPendingApprovalsError', () => {
  it('matches the server 422 message', () => {
    assert.equal(
      isPendingApprovalsError(new Error('user message cannot be sent while approvals or questions are pending')),
      true,
    );
  });

  it('rejects null, undefined, and unrelated errors', () => {
    assert.equal(isPendingApprovalsError(null), false);
    assert.equal(isPendingApprovalsError(undefined), false);
    assert.equal(isPendingApprovalsError(new Error('boom')), false);
    assert.equal(isPendingApprovalsError('user message cannot be sent'), false);
  });
});

describe('peekSessionTip', () => {
  it('returns null when the session has no turns', async () => {
    const { extensions } = createFakeClient({});
    assert.equal(await extensions.peekSessionTip({ sessionId: 'ses_1' }), null);
  });

  it('reads pending approvals off a done tip turn', async () => {
    const turn = doneTurn({
      state: {
        status: 'done',
        completedAt: '2026-09-25T00:00:01.000Z',
        output: null,
        requiredActions: [approvalRequired('2026-09-25T00:00:00.000Z')],
      },
    });
    const { extensions, sessions } = createFakeClient({
      ...fakeTurns([turn]),
    });
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.deepEqual(tip, {
      turnId: 'trn_1',
      status: 'done',
      pendingApprovals: [{ toolCallId: 'call_1', threadId: 'main', createdAt: '2026-09-25T00:00:00.000Z' }],
    });
    assert.deepEqual(sessions.listEvents.mock.calls[0], ['ses_1', { limit: 1 }]);
    assert.equal(sessions.listTurns.mock.calls.length, 0);
  });

  it('reads the newest turn, not the first one', async () => {
    const { extensions } = createFakeClient(
      fakeTurns([pausedTurn('trn_1'), doneTurn({ id: 'trn_2' }), doneTurn({ id: 'trn_3' })]),
    );
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.deepEqual(tip, { turnId: 'trn_3', status: 'done', pendingApprovals: [] });
  });

  it('ignores non-approval required actions and running turns', async () => {
    const turn = doneTurn({
      state: {
        status: 'done',
        completedAt: '2026-09-25T00:00:01.000Z',
        output: null,
        requiredActions: [
          {
            type: 'tool.response_required',
            id: 'evt_resp',
            threadId: 'main',
            createdAt: '2026-09-25T00:00:00.000Z',
            toolCalls: [{ id: 'call_9', sourceEventId: 'evt_model' }],
          },
        ],
      },
    });
    const { extensions } = createFakeClient({
      ...fakeTurns([turn]),
    });
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.deepEqual(tip?.pendingApprovals, []);
  });
});

describe('dismissPendingApprovals', () => {
  it('denies every pending approval in one continuation turn', async () => {
    const turn = doneTurn({
      state: {
        status: 'done',
        completedAt: '2026-09-25T00:00:01.000Z',
        output: null,
        requiredActions: [approvalRequired('2026-09-25T00:00:00.000Z')],
      },
    });
    const { extensions, sessions } = createFakeClient({
      ...fakeTurns([turn]),
    });
    const result = await extensions.dismissPendingApprovals({
      sessionId: 'ses_1',
      reason: 'test reason',
    });
    assert.deepEqual(result, { dismissed: 1, alreadyResolved: false });
    assert.equal(sessions.createTurnStream.mock.calls.length, 1);
    const [sessionId, request] = sessions.createTurnStream.mock.calls[0] as [
      string,
      { input: TrueForgeApi.TurnInputItem[]; previousTurnId: string },
    ];
    assert.equal(sessionId, 'ses_1');
    assert.equal(request.previousTurnId, 'trn_1');
    assert.deepEqual(request.input, [
      {
        type: 'user.tool_approval',
        threadId: 'main',
        toolCallId: 'call_1',
        approval: { status: 'deny', reason: 'test reason' },
      },
    ]);
  });

  it('reports alreadyResolved when nothing is pending', async () => {
    const { extensions, sessions } = createFakeClient({
      ...fakeTurns([doneTurn()]),
    });
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 0, alreadyResolved: true });
    assert.equal(sessions.createTurnStream.mock.calls.length, 0);
  });

  it('reports alreadyResolved when the server won the race', async () => {
    const turn = doneTurn({
      state: {
        status: 'done',
        completedAt: '2026-09-25T00:00:01.000Z',
        output: null,
        requiredActions: [approvalRequired('2026-09-25T00:00:00.000Z')],
      },
    });
    const { extensions } = createFakeClient({
      ...fakeTurns([turn]),
      createTurnStream: vi.fn(async () => {
        throw new Error('No pending approval for tool call call_1');
      }),
    });
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 0, alreadyResolved: true });
  });
});

describe('answerHeldAction', () => {
  async function answerWith(answer: 'approve' | 'always_allow' | 'deny') {
    const { extensions, sessions } = createFakeClient({});
    await extensions.answerHeldAction({ sessionId: 'ses_1', threadId: 'main', toolCallId: 'call_held', answer });
    assert.equal(sessions.createTurnStream.mock.calls.length, 1);
    return sessions.createTurnStream.mock.calls[0];
  }

  it.each([
    ['approve', { status: 'allow', scope: 'once' }],
    ['always_allow', { status: 'allow', scope: 'always' }],
    ['deny', { status: 'deny' }],
  ] as const)('sends %s as one decision on the held call, chained from the newest turn', async (answer, approval) => {
    assert.deepEqual(await answerWith(answer), [
      'ses_1',
      {
        input: [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'call_held', approval }],
        previousTurnId: 'auto',
      },
    ]);
  });

  function streamOf(...events: object[]) {
    return vi.fn(async () => {
      async function* run() {
        for (const event of events) yield event;
      }
      return run();
    });
  }

  function replayMessage(toolCallId: string) {
    return { type: 'model.message', id: 'm1', toolCalls: [{ id: toolCallId }] };
  }

  function toolResponse(toolCallId: string, disposition: string) {
    return { type: 'tool.response.v2', toolCallId, disposition };
  }

  it.each([
    ['executed_ok', 'done'],
    ['executed_nonzero', 'failed'],
    ['outcome_unknown', 'unclear'],
    ['never_ran', 'not_run'],
    ['policy_blocked', 'not_run'],
    ['denied', 'not_run'],
  ] as const)('reports %s on the replayed call as %s', async (disposition, outcome) => {
    // The replay runs under a fresh call id, announced by the answer turn's own model message.
    const { extensions } = createFakeClient({
      createTurnStream: streamOf(replayMessage('call_replayed'), toolResponse('call_replayed', disposition)),
    });
    assert.equal(
      await extensions.answerHeldAction({
        sessionId: 'ses_1',
        threadId: 'main',
        toolCallId: 'call_held',
        answer: 'approve',
      }),
      outcome,
    );
  });

  it('ignores a result for a call the answer turn did not replay', async () => {
    const { extensions } = createFakeClient({
      createTurnStream: streamOf(replayMessage('call_replayed'), toolResponse('other_call', 'executed_ok')),
    });
    assert.equal(
      await extensions.answerHeldAction({
        sessionId: 'ses_1',
        threadId: 'main',
        toolCallId: 'call_held',
        answer: 'approve',
      }),
      'unclear',
    );
  });

  it('says it is unclear when the answer turn reports no tool result', async () => {
    const { extensions } = createFakeClient({ createTurnStream: streamOf({ type: 'model.message', id: 'm1' }) });
    assert.equal(
      await extensions.answerHeldAction({
        sessionId: 'ses_1',
        threadId: 'main',
        toolCallId: 'call_held',
        answer: 'approve',
      }),
      'unclear',
    );
  });

  it('lets a refusal reach the caller', async () => {
    const refusal = new Error('Expired, nothing was done. Ask again in chat.');
    const { extensions } = createFakeClient({ createTurnStream: vi.fn().mockRejectedValue(refusal) });
    await assert.rejects(
      extensions.answerHeldAction({ sessionId: 'ses_1', threadId: 'main', toolCallId: 'call_held', answer: 'approve' }),
      refusal,
    );
  });
});

describe('chat whose first turn kept historic required actions', () => {
  const turns = [pausedTurn('trn_1'), doneTurn({ id: 'trn_2' }), doneTurn({ id: 'trn_3' })];

  it('reports no pending approval on the tip', async () => {
    const { extensions } = createFakeClient(fakeTurns(turns));
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.equal(tip?.turnId, 'trn_3');
    assert.deepEqual(tip?.pendingApprovals, []);
  });

  it('dismisses nothing and sends no continuation', async () => {
    const { extensions, sessions } = createFakeClient(fakeTurns(turns));
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 0, alreadyResolved: true });
    assert.equal(sessions.createTurnStream.mock.calls.length, 0);
  });

  it('still denies a real pending approval on the newest turn', async () => {
    const { extensions, sessions } = createFakeClient(
      fakeTurns([doneTurn({ id: 'trn_1' }), doneTurn({ id: 'trn_2' }), pausedTurn('trn_3')]),
    );
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 1, alreadyResolved: false });
    const request: unknown = sessions.createTurnStream.mock.calls[0]?.[1];
    assert.ok(typeof request === 'object' && request !== null);
    assert.equal(Reflect.get(request, 'previousTurnId'), 'trn_3');
  });
});

describe('chat that paused on a card, was approved, then got a follow-up', () => {
  const approved = doneTurn({
    id: 'trn_2',
    previousTurnId: 'trn_1',
    input: [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'call_1', approval: { status: 'allow' } }],
  });
  const followUp = doneTurn({
    id: 'trn_3',
    previousTurnId: 'trn_2',
    input: [{ type: 'user.message', content: 'and one more thing' }],
  });
  const turns = [pausedTurn('trn_1'), approved, followUp];

  it('probes the follow-up as the tip and finds nothing pending', async () => {
    const { extensions } = createFakeClient(fakeTurns(turns));
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.deepEqual(tip, { turnId: 'trn_3', status: 'done', pendingApprovals: [] });
  });

  it('sends no continuation anchored on the turn that asked', async () => {
    const { extensions, sessions } = createFakeClient(fakeTurns(turns));
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 0, alreadyResolved: true });
    assert.equal(sessions.createTurnStream.mock.calls.length, 0);
  });
});

describe('getLastTurnInputTokens', () => {
  it('reads the newest turn metrics', async () => {
    const newest = doneTurn({
      id: 'trn_2',
      state: {
        status: 'done',
        completedAt: '2026-09-25T00:00:01.000Z',
        output: null,
        requiredActions: [],
        metrics: { totalInputTokens: 4321 },
      },
    });
    const { extensions } = createFakeClient(fakeTurns([doneTurn({ id: 'trn_1' }), newest]));
    assert.equal(await extensions.getLastTurnInputTokens({ sessionId: 'ses_1' }), 4321);
  });
});

describe('blocked-send pub/sub', () => {
  it('notifies subscribers and supports unsubscribe', () => {
    const seen: number[] = [];
    const unsub1 = subscribeToBlockedSend(() => seen.push(1));
    const unsub2 = subscribeToBlockedSend(() => seen.push(2));
    publishBlockedSend();
    assert.deepEqual(seen, [1, 2]);
    unsub1();
    unsub2();
    publishBlockedSend();
    assert.deepEqual(seen, [1, 2]);
  });
});

describe('approval auto-deny policy', () => {
  it('is a 30-minute fail-closed window', () => {
    assert.equal(APPROVAL_AUTO_DENY_MINUTES, 30);
    assert.match(approvalAutoDenyReason(), /30 minutes/);
    assert.match(approvalAutoDenyReason(), /denied/i);
  });
});
