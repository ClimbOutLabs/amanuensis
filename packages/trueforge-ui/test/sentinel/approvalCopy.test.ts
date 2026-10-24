import { describe, expect, it } from 'vitest';

import {
  approvalQuestion,
  approvalSentLine,
  approvalStub,
  approveVerb,
  declineVerb,
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
  it('asks "Send this reply to Rui?" for a reply, with Allow and Not now', () => {
    const card = cardWith({ email: reply });
    expect(approvalQuestion(card)).toBe('Send this reply to Rui?');
    expect(approveVerb(card)).toBe('Allow');
    expect(declineVerb(card)).toBe('Not now');
  });

  it('never shows a search connector id on a held search stub', () => {
    const card = cardWith({
      plain_what: 'Search the web with Tavily for harbour tides?',
      destination: null,
      destination_host: 'Tavily',
    });
    const stub = approvalStub(card);
    expect(stub.detail).not.toMatch(/tavily-|mcp\./i);
    expect(stub.detail).toBe('Open Details to see what it does');
  });

  it('asks "Send this email to a@x.com and 1 more?" for a new message, whatever the number of recipients', () => {
    const card = cardWith({ email: { ...reply, reply_in_thread: null, to: [bare('a@x.com'), bare('b@x.com')] } });
    expect(approvalQuestion(card)).toBe('Send this email to a@x.com and 1 more?');
    expect(approveVerb(card)).toBe('Allow');
  });

  it('says "Add and send" for a send to a new address, since approving adds it', () => {
    const card = cardWith({ email: { ...reply, reply_in_thread: null }, mail_new_recipients: ['a@x.com'] });
    expect(approvalQuestion(card)).toBe('Send this email to Rui?');
    expect(approveVerb(card)).toBe('Add and send');
    expect(declineVerb(card)).toBe("Don't send");
  });

  it('asks "Save this draft?" with Allow, and Not now to decline', () => {
    const card = cardWith({ email: { ...reply, action: 'save' } });
    expect(approvalQuestion(card)).toBe('Save this draft?');
    expect(approveVerb(card)).toBe('Allow');
    expect(declineVerb(card)).toBe('Not now');
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
    expect(approveVerb(card)).toBe('Allow');
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
    expect(approveVerb(card)).toBe('Allow');
  });

  it('falls back to the server sentence and a plain verb for other actions', () => {
    const card = cardWith({});
    expect(approvalQuestion(card)).toBe('Run the report.');
    expect(approveVerb(card)).toBe('Allow');
    expect(declineVerb(card)).toBe('Not now');
  });

  it('shows the time in the sent line once a ticket is done, and the stub carries no state', () => {
    const card = cardWith({ calendar_event: null });
    expect(approvalSentLine(card, '09:14')).toBe('Done · 09:14');
    expect(approvalSentLine(cardWith({ email: reply }), '09:14')).toBe('Sent to Rui · 09:14');
    const stub = approvalStub(card);
    expect(stub).toEqual({ what: 'Action', detail: 'Open Details to see what it does' });
    expect('state' in stub).toBe(false);
  });
});
