import type { TurnRecord, TurnState } from '@truefoundry/trueforge-core/agent-session';
import type { ActionRequiredEvent } from '@truefoundry/trueforge-core/core/events/schema';
import winston from 'winston';

import type { TurnCustom } from '../../../../src/db/sessionCustom';
import { deliverPendingTelegramReplies } from '../../../../src/runtime/telegram/telegramReplies';
import { createTelegramService } from '../../../../src/runtime/telegram/telegramService';
import {
  fakePairedConnection,
  FakeTelegramClient,
  immediateQueue,
  InMemoryTelegramStore,
} from '../../../fixtures/telegramFakes';

const logger = winston.createLogger({ silent: true });

function turnWith(state: TurnState): TurnRecord<TurnCustom> {
  return {
    turn_id: 'turn-1',
    session_id: 'session-1',
    first_turn_id: 'turn-1',
    ancestor_ids: [],
    previous_turn_id: null,
    state,
    input: [],
    snapshot: { threads: {}, mcp_servers: null, sandbox_info: null },
    created_at: new Date('2026-11-06T00:00:00.000Z'),
    updated_at: new Date('2026-11-06T00:00:00.000Z'),
    custom: null,
  };
}

const APPROVAL_ACTION: ActionRequiredEvent = {
  type: 'tool.approval_required',
  id: 'event-1',
  created_at: '2026-11-06T00:00:00.000Z',
  thread_id: 'main',
  tool_calls: [
    {
      id: 'call-1',
      source_event_id: 'event-1',
      tier3_card: {
        plain_what: 'Send the email to Sam.',
        plain_why: 'You asked for the summary to be sent.',
        cannot_be_undone: null,
        why_asked_again: null,
        destination: null,
        recipient: 'sam@example.com',
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
    },
  ],
};

function harness(turn: TurnRecord<TurnCustom> | undefined) {
  const store = new InMemoryTelegramStore();
  store.connection = fakePairedConnection();
  const client = new FakeTelegramClient();
  const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
  void store.addPendingReply({
    tenant_id: 'local',
    created_by: 'test-user',
    connection_id: 'conn-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    chat_id: '777',
  });
  const deps = {
    store,
    service,
    queue: immediateQueue,
    sessionStore: { getTurn: () => Promise.resolve(turn) },
    logger,
  };
  return { store, client, deps };
}

describe('telegram pending replies', () => {
  it('leaves a running turn alone', async () => {
    const { store, client, deps } = harness(turnWith({ status: 'running' }));
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(0);
    expect(store.pendingReplies).toHaveLength(1);
  });

  it('sends a finished turn its answer and clears the debt', async () => {
    const { store, client, deps } = harness(
      turnWith({
        status: 'done',
        output: {
          type: 'model.message',
          id: 'msg-1',
          thread_id: 'main',
          content: 'Tomorrow is clear until noon.',
          created_at: '2026-11-06T00:01:00.000Z',
        },
        required_actions: [],
        completed_at: '2026-11-06T00:01:00.000Z',
      }),
    );
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toEqual([{ chat_id: '777', text: 'Tomorrow is clear until noon.', inline_buttons: undefined }]);
    expect(store.pendingReplies).toHaveLength(0);
  });

  it('sends an approval ask with buttons and keeps the row the buttons point at', async () => {
    const { store, client, deps } = harness(
      turnWith({
        status: 'done',
        output: null,
        required_actions: [APPROVAL_ACTION],
        completed_at: '2026-11-06T00:01:00.000Z',
      }),
    );
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
    const sent = client.sent[0];
    expect(sent?.text).toContain('Send the email to Sam.');
    expect(sent?.text).toContain('To: sam@example.com');
    expect(store.pendingApprovals).toHaveLength(1);
    const approval = store.pendingApprovals[0];
    expect(sent?.inline_buttons).toEqual([
      [
        { text: 'Approve', callback_data: `tg:a:${approval?.id ?? ''}` },
        { text: 'Deny', callback_data: `tg:d:${approval?.id ?? ''}` },
      ],
    ]);
    expect(store.pendingReplies).toHaveLength(0);
  });

  it('tells the person to open the app for an action buttons cannot answer', async () => {
    const responseAction: ActionRequiredEvent = {
      type: 'tool.response_required',
      id: 'event-2',
      created_at: '2026-11-06T00:00:00.000Z',
      thread_id: 'main',
      tool_calls: [{ id: 'call-2', source_event_id: 'event-2' }],
    };
    const { client, deps } = harness(
      turnWith({
        status: 'done',
        output: null,
        required_actions: [responseAction],
        completed_at: '2026-11-06T00:01:00.000Z',
      }),
    );
    await deliverPendingTelegramReplies(deps);
    expect(client.sent.map(entry => entry.text)).toEqual([
      'Aman needs something only the app can give. Open Aman to continue.',
    ]);
  });

  it('sends the plain line for a turn that ended in an error', async () => {
    const { client, deps } = harness(
      turnWith({ status: 'error', message: 'boom', completed_at: '2026-11-06T00:01:00.000Z' }),
    );
    await deliverPendingTelegramReplies(deps);
    expect(client.sent[0]?.text).toContain('Something went wrong with that answer.');
  });

  it('clears the debt even when the send fails: one attempt, never a repeat', async () => {
    const { store, client, deps } = harness(
      turnWith({
        status: 'done',
        output: {
          type: 'model.message',
          id: 'msg-1',
          thread_id: 'main',
          content: 'An answer.',
          created_at: '2026-11-06T00:01:00.000Z',
        },
        required_actions: [],
        completed_at: '2026-11-06T00:01:00.000Z',
      }),
    );
    client.failSend = true;
    await deliverPendingTelegramReplies(deps);
    expect(store.pendingReplies).toHaveLength(0);
  });

  it('clears the debt when the turn is gone', async () => {
    const { store, client, deps } = harness(undefined);
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(0);
    expect(store.pendingReplies).toHaveLength(0);
  });
});
