import { describe, expect, it } from 'vitest';

import { HOLD_SAY, searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';

import {
  approvalQuestion,
  approvalStub,
  approveVerb,
  declineVerb,
  searchHoldParts,
} from '../../src/sentinel/approvalCopy.js';
import type { SentinelApprovalCard } from '../../src/sentinel/types.js';

function cardWith(overrides: Partial<SentinelApprovalCard>): SentinelApprovalCard {
  return {
    plain_what: 'Run the report.',
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
    email: null,
    calendar_event: null,
    schedule: null,
    persona: null,
    ...overrides,
  };
}

const bare = (address: string) => ({ name: '', address });

const reply: SentinelApprovalCard['email'] = {
  action: 'send',
  to: [{ name: 'Rui', address: 'rui@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lease renewal',
  body: 'Thursday works.',
  replaces: null,
  reply_in_thread: { subject: 'Lease renewal', from: 'rui@example.com' },
  reply_to: null,
};

describe('approval copy', () => {
  it('asks "Send this reply?" for a reply, with Send and Don\'t send', () => {
    const card = cardWith({ email: reply });
    expect(approvalQuestion(card)).toBe('Send this reply?');
    expect(approveVerb(card)).toBe('Send');
    expect(declineVerb(card)).toBe("Don't send");
  });

  it('never shows a search connector id on a held search stub', () => {
    const card = cardWith({
      plain_what: 'Search the web with Tavily for: harbour tides.',
      destination: null,
      destination_host: 'Tavily',
    });
    const stub = approvalStub(card, { sentAt: null });
    expect(stub.what).toBe('Web search');
    expect(stub.detail).toBeNull();
  });

  it('asks "Send this email?" for a new message, whatever the number of recipients', () => {
    const card = cardWith({ email: { ...reply, reply_in_thread: null, to: [bare('a@x.com'), bare('b@x.com')] } });
    expect(approvalQuestion(card)).toBe('Send this email?');
    expect(approveVerb(card)).toBe('Send');
  });

  it('says "Add and send" for a send to a new address, since approving adds it', () => {
    const card = cardWith({ email: { ...reply, reply_in_thread: null }, mail_new_recipients: ['a@x.com'] });
    expect(approvalQuestion(card)).toBe('Send this email?');
    expect(approveVerb(card)).toBe('Add and send');
    expect(declineVerb(card)).toBe("Don't send");
  });

  it('asks "Save this draft?" with Save draft, and Don\'t save to decline', () => {
    const card = cardWith({ email: { ...reply, action: 'save' } });
    expect(approvalQuestion(card)).toBe('Save this draft?');
    expect(approveVerb(card)).toBe('Save draft');
    expect(declineVerb(card)).toBe("Don't save");
  });

  it('names a calendar event and asks to add it', () => {
    const card = cardWith({
      calendar_event: {
        action: 'create',
        calendar: 'ada@example.com',
        title: 'Dentist',
        when: 'Friday 9:00',
        time_zone: 'Europe/Lisbon',
        duration: '1 hour',
        location: '',
        description: '',
        attendees: [],
        guests_emailed: false,
        one_of_repeating: false,
        before: null,
      },
    });
    expect(approvalQuestion(card)).toBe('Add "Dentist" to your calendar?');
    expect(approveVerb(card)).toBe('Add it');
  });

  it('asks a new schedule to be created', () => {
    const card = cardWith({
      schedule: {
        action: 'create',
        name: 'Morning brief',
        when: 'Weekdays',
        time_zone: 'UTC',
        task: '',
        runs_as: 'Aman',
        next_runs: [],
      },
    });
    expect(approvalQuestion(card)).toBe('Create the schedule "Morning brief"?');
    expect(approveVerb(card)).toBe('Create it');
  });

  it('falls back to the server sentence and a plain verb for other actions', () => {
    const card = cardWith({});
    expect(approvalQuestion(card)).toBe('Run the report.');
    expect(approveVerb(card)).toBe('Allow it');
    expect(declineVerb(card)).toBe('Not now');
  });

  it('shows the time in the stub once a ticket is done', () => {
    const card = cardWith({ calendar_event: null });
    expect(approvalStub(card, { sentAt: '09:14' }).state).toBe('Done 09:14');
  });

  it('leaves the stub state empty while a ticket waits, since the badge already says so', () => {
    expect(approvalStub(cardWith({ calendar_event: null }), { sentAt: null }).state).toBeNull();
  });
});

describe('searchHoldParts', () => {
  it('reads the query and the reason back from a held search sentence', () => {
    const text = searchHoldCardText({ summary: 'lamp: brass, 2 pack', say: HOLD_SAY.private_read });
    expect(searchHoldParts(text)).toEqual({ query: 'lamp: brass, 2 pack', reason: HOLD_SAY.private_read });
  });

  it('keeps a period that ends the query', () => {
    const text = searchHoldCardText({ summary: 'open hours of St. Mary Inc.', say: HOLD_SAY.search_setting });
    expect(searchHoldParts(text)).toEqual({ query: 'open hours of St. Mary Inc.', reason: HOLD_SAY.search_setting });
  });

  it('drops only the closing period of a query that does not end in one', () => {
    const text = searchHoldCardText({ summary: 'lamp', say: HOLD_SAY.search_setting });
    expect(searchHoldParts(text)?.query).toBe('lamp');
  });

  it('returns undefined for a card that is not a held search', () => {
    expect(searchHoldParts('Send $250 to Acme Corp')).toBeUndefined();
  });
});
