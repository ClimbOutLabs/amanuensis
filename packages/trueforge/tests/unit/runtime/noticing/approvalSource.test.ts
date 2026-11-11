import type { ISessionStore, SessionRecord, TurnRecord } from '@truefoundry/trueforge-core/agent-session';

import type { SessionCustom, TurnCustom } from '../../../../src/db/sessionCustom';
import { sessionApprovalSource } from '../../../../src/runtime/noticing/approvalSource';

const NOW = new Date('2026-11-05T15:00:00.000Z');

function session({ id, owner, updated }: { id: string; owner: string; updated: string }): SessionRecord<SessionCustom> {
  return {
    tenant_id: 'default',
    session_id: id,
    created_by_subject: { subject_id: owner, subject_type: 'user', subject_display_name: owner },
    agent: { type: 'reference', id: 'agent-1', name: 'test-agent' },
    title: null,
    folder_id: null,
    repository_id: null,
    workspace_cwd: null,
    external_id: null,
    source: null,
    last_turn_id: `turn-${id}`,
    created_at: new Date(updated),
    updated_at: new Date(updated),
    last_activity_timestamp_ms: 0,
    approval_grants: [],
    task_checklist: { revision: 0, items: [] },
    metrics: { total_duration_ms: 0, total_turns: 0 },
    metadata: {},
    custom: null,
    is_incognito: false,
    private_expires_at: null,
  };
}

function turn({
  sessionId,
  state,
}: {
  sessionId: string;
  state: TurnRecord<TurnCustom>['state'];
}): TurnRecord<TurnCustom> {
  return {
    turn_id: `turn-${sessionId}`,
    session_id: sessionId,
    first_turn_id: `turn-${sessionId}`,
    ancestor_ids: [],
    previous_turn_id: null,
    state,
    input: [],
    snapshot: { threads: {}, mcp_servers: null, sandbox_info: null },
    created_at: NOW,
    updated_at: NOW,
    custom: null,
  };
}

function waitingOn({ approvalId, at }: { approvalId: string; at: string }): TurnRecord<TurnCustom>['state'] {
  return {
    status: 'done',
    output: null,
    completed_at: at,
    required_actions: [
      {
        type: 'tool.approval_required',
        id: approvalId,
        created_at: at,
        thread_id: 'main',
        tool_calls: [],
      },
    ],
  };
}

describe('sessionApprovalSource', () => {
  it('lists open approval requests for everyone, newest chats first, and stops once chats are too old', async () => {
    const pages = [
      [
        session({ id: 'a', owner: 'alice', updated: '2026-11-05T14:50:00.000Z' }),
        session({ id: 'b', owner: 'bob', updated: '2026-11-05T14:45:00.000Z' }),
      ],
      [
        session({ id: 'c', owner: 'carol', updated: '2026-11-05T14:40:00.000Z' }),
        // Older than a request stays open, so neither this nor anything after it is read.
        session({ id: 'd', owner: 'dan', updated: '2026-11-05T14:20:00.000Z' }),
      ],
      [session({ id: 'e', owner: 'erin', updated: '2026-11-05T14:10:00.000Z' })],
    ];
    const turns: Record<string, TurnRecord<TurnCustom>['state']> = {
      a: waitingOn({ approvalId: 'approval-a', at: '2026-11-05T14:50:00.000Z' }),
      b: { status: 'running' },
      c: waitingOn({ approvalId: 'approval-c', at: '2026-11-05T14:40:00.000Z' }),
      d: waitingOn({ approvalId: 'approval-d', at: '2026-11-05T14:20:00.000Z' }),
      e: waitingOn({ approvalId: 'approval-e', at: '2026-11-05T14:10:00.000Z' }),
    };
    const listSessions = jest.fn<
      ReturnType<ISessionStore<SessionCustom, TurnCustom>['listSessions']>,
      Parameters<ISessionStore<SessionCustom, TurnCustom>['listSessions']>
    >(input => {
      const index = input.page_token === undefined ? 0 : Number(input.page_token);
      return Promise.resolve({
        data: pages[index] ?? [],
        pagination: { limit: 100, ...(index + 1 < pages.length ? { next_page_token: String(index + 1) } : {}) },
      });
    });
    const getTurn = jest.fn<
      ReturnType<ISessionStore<SessionCustom, TurnCustom>['getTurn']>,
      Parameters<ISessionStore<SessionCustom, TurnCustom>['getTurn']>
    >(input => {
      const sessionId = input.session_id;
      const state = turns[sessionId];
      return Promise.resolve(state === undefined ? undefined : turn({ sessionId, state }));
    });

    const waiting = await sessionApprovalSource({
      sessionStore: { listSessions, getTurn },
      tenant_id: 'default',
      now: () => NOW,
    }).listWaiting();

    expect(waiting).toEqual([
      {
        owner: { tenant_id: 'default', created_by: 'alice' },
        session_id: 'a',
        approval_id: 'approval-a',
        waiting_since: new Date('2026-11-05T14:50:00.000Z'),
      },
      {
        owner: { tenant_id: 'default', created_by: 'carol' },
        session_id: 'c',
        approval_id: 'approval-c',
        waiting_since: new Date('2026-11-05T14:40:00.000Z'),
      },
    ]);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions.mock.calls[0]?.[0]).toMatchObject({
      tenant_id: 'default',
      created_by_or_agent_ids: undefined,
      include_private: false,
    });
    expect(getTurn.mock.calls.map(call => call[0].session_id)).toEqual(['a', 'b', 'c']);
  });
});
