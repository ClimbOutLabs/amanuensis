import { ImportEventListSchema, ImportTurnRecordSchema } from '../../../src/dataImport/importSchemas';

/** The email block as archives written before recipients carried a name hold it: bare address strings. */
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

const CARD = {
  plain_what: 'Change a saved draft in your Gmail.',
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

const CALL = { id: 'call-send', source_event_id: 'event-source', tier: 3, tier3_card: CARD };

const APPROVAL = {
  type: 'tool.approval_required',
  id: 'event-approval',
  created_at: '2026-09-30T10:00:00.000Z',
  thread_id: 'main',
  tool_calls: [CALL],
};

describe('importing approval cards written before recipients carried names', () => {
  it('reads each bare address as a recipient with no name, so the card still shows where mail goes', () => {
    const [event] = ImportEventListSchema.parse([structuredClone(APPROVAL)]);
    expect(event).toMatchObject({
      tool_calls: [
        {
          tier3_card: {
            email: {
              to: [{ name: '', address: 'grace@example.com' }],
              cc: [{ name: '', address: 'lin@example.com' }],
              bcc: [],
              replaces: { subject: 'Old lease', to: [{ name: '', address: 'sam@example.com' }] },
              reply_to: null,
            },
          },
        },
      ],
    });
  });

  it('leaves a card already in the name-and-address form as it is', () => {
    const named = {
      ...APPROVAL,
      tool_calls: [
        {
          ...CALL,
          tier3_card: {
            ...CARD,
            email: { ...OLDER_EMAIL, to: [{ name: 'Grace Lee', address: 'grace@example.com' }] },
          },
        },
      ],
    };
    const [event] = ImportEventListSchema.parse([structuredClone(named)]);
    expect(event).toMatchObject({
      tool_calls: [{ tier3_card: { email: { to: [{ name: 'Grace Lee', address: 'grace@example.com' }] } } }],
    });
  });
});

describe('importing a finished turn whose approval is still pending and was written before names', () => {
  it('upgrades the card in the turn state, so the strict read of the turn succeeds', () => {
    const turn = ImportTurnRecordSchema.parse({
      turn_id: 'turn-1',
      session_id: 'session-1',
      first_turn_id: 'turn-1',
      ancestor_ids: [],
      previous_turn_id: null,
      state: {
        status: 'done',
        output: null,
        required_actions: [structuredClone(APPROVAL)],
        completed_at: '2026-09-30T10:05:00.000Z',
      },
      input: [],
      custom: null,
      created_at: '2026-09-30T10:00:00.000Z',
      updated_at: '2026-09-30T10:05:00.000Z',
      snapshot: { threads: {} },
    });
    expect(turn.state).toMatchObject({
      status: 'done',
      required_actions: [
        {
          tool_calls: [{ tier3_card: { email: { to: [{ name: '', address: 'grace@example.com' }] } } }],
        },
      ],
    });
  });
});
