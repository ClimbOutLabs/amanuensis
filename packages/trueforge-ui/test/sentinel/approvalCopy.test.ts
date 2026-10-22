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
};

describe('approval copy', () => {
  it('asks a reply as a question to the person it answers', () => {
    const card = cardWith({ email: reply });
    expect(approvalQuestion(card)).toBe('Send this reply to Rui?');
    expect(approveVerb(card)).toBe('Send it');
    expect(declineVerb(card)).toBe("Don't send");
    expect(approvalStub(card, { sentAt: null })).toEqual({
      what: 'Reply to Rui',
      detail: 'Lease renewal',
      state: 'Waiting for you',
    });
  });

  it('counts the other recipients of a new email', () => {
    const card = cardWith({ email: { ...reply, reply_in_thread: null, to: [bare('a@x.com'), bare('b@x.com')] } });
    expect(approvalQuestion(card)).toBe('Send this email to a@x.com and 1 more?');
  });

  it('asks a draft to be saved, with no send verb', () => {
    const card = cardWith({ email: { ...reply, action: 'save' } });
    expect(approvalQuestion(card)).toBe('Save this draft?');
    expect(approveVerb(card)).toBe('Save it');
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

  it('shows the time once sent, in the badge and the stub', () => {
    const card = cardWith({ email: reply });
    expect(approvalSentLine(card, '09:14')).toBe('Sent to Rui · 09:14');
    expect(approvalStub(card, { sentAt: '09:14' }).state).toBe('Sent 09:14');
    expect(approvalSentLine(cardWith({}), '09:14')).toBe('Done · 09:14');
  });
});
