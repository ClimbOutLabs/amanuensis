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
  createTurnStream: ReturnType<typeof vi.fn>;
  getTurn: ReturnType<typeof vi.fn>;
}

function createFakeClient(sessions: Partial<FakeSessions>): {
  extensions: ReturnType<typeof createSessionResyncExtensions>;
  sessions: FakeSessions;
} {
  const full: FakeSessions = {
    listTurns: vi.fn(async () => ({ data: [] })),
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
      isPendingApprovalsError(
        new Error('user message cannot be sent while approvals or questions are pending'),
      ),
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
      listTurns: vi.fn(async () => ({ data: [turn] })),
    });
    const tip = await extensions.peekSessionTip({ sessionId: 'ses_1' });
    assert.deepEqual(tip, {
      turnId: 'trn_1',
      status: 'done',
      pendingApprovals: [
        { toolCallId: 'call_1', threadId: 'main', createdAt: '2026-09-25T00:00:00.000Z' },
      ],
    });
    assert.deepEqual(sessions.listTurns.mock.calls[0], ['ses_1', { limit: 1 }]);
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
      listTurns: vi.fn(async () => ({ data: [turn] })),
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
      listTurns: vi.fn(async () => ({ data: [turn] })),
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
      listTurns: vi.fn(async () => ({ data: [doneTurn()] })),
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
      listTurns: vi.fn(async () => ({ data: [turn] })),
      createTurnStream: vi.fn(async () => {
        throw new Error('No pending approval for tool call call_1');
      }),
    });
    const result = await extensions.dismissPendingApprovals({ sessionId: 'ses_1', reason: 'x' });
    assert.deepEqual(result, { dismissed: 0, alreadyResolved: true });
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
