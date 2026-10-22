import type { SessionEventItem } from '../../../src/agent-session/schemas/events';
import type { TurnState } from '../../../src/agent-session/schemas/turn';
import { EventType } from '../../../src/core/events/schema';
import {
  upgradeArchivedApprovalEvent,
  upgradeArchivedTurnState,
  upgradeStoredSessionEventItem,
  upgradeStoredTurnState,
} from '../../../src/core/permissions/storedCards';

/** A card as archives written before recipients carried a name hold it: bare address strings. */
const OLDER_EMAIL = {
  action: 'change',
  to: ['grace@example.com'],
  cc: ['lin@example.com'],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  replaces: { subject: 'Old lease', to: ['sam@example.com'] },
  reply_in_thread: null,
};

const UPGRADED_EMAIL = {
  action: 'change',
  to: [{ name: '', address: 'grace@example.com' }],
  cc: [{ name: '', address: 'lin@example.com' }],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  replaces: { subject: 'Old lease', to: [{ name: '', address: 'sam@example.com' }] },
  reply_in_thread: null,
};

/** What the archive upgrade returns: the same card, with a reply address that defaults to the sender. */
const ARCHIVED_UPGRADED_EMAIL = { ...UPGRADED_EMAIL, reply_to: null };

const CARD = {
  plain_what: 'Change',
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
  email: OLDER_EMAIL,
  calendar_event: null,
  schedule: null,
};

const CALL = { id: 'call-1', source_event_id: 'event-source', tier: 3, tier3_card: CARD };

const APPROVAL = {
  type: EventType.TOOL_APPROVAL_REQUIRED,
  id: 'event-approval',
  created_at: '2026-09-30T10:00:00.000Z',
  thread_id: 'main',
  tool_calls: [CALL],
};

/** A value as a store or archive hands it back: parsed from JSON, so TypeScript does not check its shape. */
function storedAs<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}

describe('upgradeArchivedApprovalEvent', () => {
  it('reads each bare address stored on a card as a recipient with no name', () => {
    expect(upgradeArchivedApprovalEvent(APPROVAL)).toMatchObject({
      tool_calls: [{ tier3_card: { email: ARCHIVED_UPGRADED_EMAIL } }],
    });
  });

  it('leaves a card already in the name-and-address form as it is', () => {
    const named = { ...ARCHIVED_UPGRADED_EMAIL, to: [{ name: 'Grace Lee', address: 'grace@example.com' }] };
    const event = { ...APPROVAL, tool_calls: [{ ...CALL, tier3_card: { ...CARD, email: named } }] };
    expect(upgradeArchivedApprovalEvent(event)).toEqual(event);
  });

  it('passes through events that are not approvals', () => {
    const message = { type: EventType.MODEL_MESSAGE, id: 'event-1', content: 'Hello' };
    expect(upgradeArchivedApprovalEvent(message)).toBe(message);
  });
});

describe('upgradeArchivedTurnState', () => {
  it('upgrades the approval cards a finished turn still waits on, and keeps its other fields', () => {
    const state = { status: 'done', completed_at: '2026-09-30T10:05:00.000Z', required_actions: [APPROVAL] };
    expect(upgradeArchivedTurnState(state)).toMatchObject({
      status: 'done',
      completed_at: '2026-09-30T10:05:00.000Z',
      required_actions: [{ tool_calls: [{ tier3_card: { email: ARCHIVED_UPGRADED_EMAIL } }] }],
    });
  });

  it('passes through a turn state with no pending actions', () => {
    const state = { status: 'running' };
    expect(upgradeArchivedTurnState(state)).toBe(state);
  });
});

describe('upgradeStoredSessionEventItem and upgradeStoredTurnState', () => {
  it('reads a stored approval with bare address strings in the typed shape the server returns', () => {
    const item = upgradeStoredSessionEventItem(storedAs<SessionEventItem>({ turn_id: 'turn-1', event: APPROVAL }));
    expect(item.event).toMatchObject({
      id: 'event-approval',
      created_at: '2026-09-30T10:00:00.000Z',
      tool_calls: [{ tier3_card: { email: UPGRADED_EMAIL } }],
    });
  });

  it('returns a stored item that is not an approval unchanged', () => {
    const item = { turn_id: 'turn-1', event: { type: EventType.MODEL_MESSAGE, id: 'event-1', content: 'Hello' } };
    expect(upgradeStoredSessionEventItem(storedAs<SessionEventItem>(item))).toEqual(item);
  });

  it('upgrades the pending approvals of a done turn', () => {
    const state = storedAs<TurnState>({
      status: 'done',
      output: null,
      required_actions: [APPROVAL],
      completed_at: '2026-09-30T10:05:00.000Z',
    });
    expect(upgradeStoredTurnState(state)).toMatchObject({
      status: 'done',
      required_actions: [{ tool_calls: [{ tier3_card: { email: UPGRADED_EMAIL } }] }],
    });
  });
});
