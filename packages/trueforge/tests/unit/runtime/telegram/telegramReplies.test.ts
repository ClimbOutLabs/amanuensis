import type { TurnRecord, TurnState } from '@truefoundry/trueforge-core/agent-session';
import type { Tier3Card } from '@truefoundry/trueforge-core/core';
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

type Card = Tier3Card;

function cardWith(overrides: Partial<Card>): Card {
  return {
    plain_what: 'Do the thing.',
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    ...overrides,
  };
}

function approvalAction(card: Card | null): ActionRequiredEvent {
  return {
    type: 'tool.approval_required',
    id: 'event-1',
    created_at: '2026-11-06T00:00:00.000Z',
    thread_id: 'main',
    tool_calls: [{ id: 'call-1', source_event_id: 'event-1', tier3_card: card }],
  };
}

function doneTurnWith(action: ActionRequiredEvent): TurnRecord<TurnCustom> {
  return turnWith({
    status: 'done',
    output: null,
    required_actions: [action],
    completed_at: '2026-11-06T00:01:00.000Z',
  });
}

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

  it('sends an email approval with the whole message, subject, recipients and body', async () => {
    const card = cardWith({
      plain_what: 'Send this email.',
      email: {
        action: 'send',
        to: [{ name: 'Sam', address: 'sam@example.com' }],
        cc: [{ name: '', address: 'pat@example.com' }],
        bcc: [],
        subject: 'The summary you asked for',
        body: 'Hello Sam,\n\nHere is the whole body, every word of it.\n\nBye.',
        replaces: null,
        reply_in_thread: null,
        reply_to: null,
      },
    });
    const { store, client, deps } = harness(doneTurnWith(approvalAction(card)));
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
    const sent = client.sent[0];
    expect(sent?.text).toContain('Send this email.');
    expect(sent?.text).toContain('To: Sam (sam@example.com)');
    expect(sent?.text).toContain('Copy: pat@example.com');
    expect(sent?.text).toContain('Subject: The summary you asked for');
    expect(sent?.text).toContain('Here is the whole body, every word of it.');
    expect(sent?.inline_buttons?.[0]?.map(button => button.text)).toEqual(['Approve', 'Deny']);
    expect(store.pendingApprovals).toHaveLength(1);
    expect(store.pendingApprovals[0]?.prompt).toBe(sent?.text);
  });

  it('sends a shell approval with the command itself, and a schedule with its whole task', async () => {
    const shell = cardWith({ plain_what: 'Run a command.', parsed_command: 'rm -rf /tmp/old-backups' });
    const first = harness(doneTurnWith(approvalAction(shell)));
    await deliverPendingTelegramReplies(first.deps);
    expect(first.client.sent[0]?.text).toContain('Command: rm -rf /tmp/old-backups');
    expect(first.client.sent[0]?.inline_buttons).toBeDefined();

    const schedule = cardWith({
      plain_what: 'Make a schedule.',
      schedule: {
        action: 'create',
        name: 'Morning brief',
        when: 'Every day at 7 in the morning',
        time_zone: 'America/Los_Angeles',
        task: 'Read the calendar and the inbox, then write the brief in full sentences.',
        runs_as: 'Aman',
        next_runs: ['Tomorrow at 7:00 AM'],
      },
    });
    const second = harness(doneTurnWith(approvalAction(schedule)));
    await deliverPendingTelegramReplies(second.deps);
    expect(second.client.sent[0]?.text).toContain(
      'Read the calendar and the inbox, then write the brief in full sentences.',
    );
    expect(second.client.sent[0]?.inline_buttons).toBeDefined();
  });

  it('sends a persona approval with its whole instructions', async () => {
    const persona = cardWith({
      plain_what: 'Add a persona.',
      persona: {
        name: 'Scout',
        description: 'Keeps an eye on new listings.',
        instructions: 'You watch for new listings and summarise each one in two lines.',
        model_name: 'house-model',
      },
    });
    const { client, deps } = harness(doneTurnWith(approvalAction(persona)));
    await deliverPendingTelegramReplies(deps);
    expect(client.sent[0]?.text).toContain('You watch for new listings and summarise each one in two lines.');
    expect(client.sent[0]?.inline_buttons).toBeDefined();
  });

  it('sends no buttons when the exact request text is cut, and points to the app', async () => {
    const card = cardWith({
      plain_what: 'Call the connector.',
      outbound_text: 'query: a very long search',
      outbound_truncated: true,
    });
    const { store, client, deps } = harness(doneTurnWith(approvalAction(card)));
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain('Part of this request is not shown in full.');
    expect(client.sent[0]?.text).toContain('Open Aman to see the whole thing and answer there.');
    expect(client.sent[0]?.inline_buttons).toBeUndefined();
    expect(store.pendingApprovals).toHaveLength(0);
  });

  it('sends no buttons when the action has no card, and points to the app', async () => {
    const { store, client, deps } = harness(doneTurnWith(approvalAction(null)));
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain('Telegram cannot show everything it will do');
    expect(client.sent[0]?.inline_buttons).toBeUndefined();
    expect(store.pendingApprovals).toHaveLength(0);
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

  it('clears the debt before the answer is sent, so a crash can never send it twice', async () => {
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
    // What the pass still owed at the moment each send went out: by then the debt must
    // already be cleared, so a crash after the send leaves nothing for a next pass to repeat.
    const owedAtSendTime: number[] = [];
    const send = client.sendMessage.bind(client);
    client.sendMessage = input => {
      owedAtSendTime.push(store.pendingReplies.length);
      return send(input);
    };
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
    expect(owedAtSendTime).toEqual([0]);
    expect(store.pendingReplies).toHaveLength(0);

    // A second pass, as after a restart, sends nothing again.
    await deliverPendingTelegramReplies(deps);
    expect(client.sent).toHaveLength(1);
  });
});
