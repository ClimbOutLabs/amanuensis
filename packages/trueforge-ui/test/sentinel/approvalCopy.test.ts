import { describe, expect, it } from 'vitest';

import {
  approvalFacts,
  approvalQuestion,
  approvalSentLine,
  approveVerb,
  cardConsequence,
  cardHeadline,
  cardReason,
  declineVerb,
  GENERIC_CARD_HEADLINE,
  outboundRepeatsFacts,
  safeVerb,
} from '../../src/sentinel/approvalCopy.js';
import type { SentinelApprovalCard } from '../../src/sentinel/types.js';
import { approvalSpeechLine } from '../../src/utils/speechText.js';

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

  it('names a held search by its provider, never by a connector id', () => {
    const card = cardWith({
      copy: { headline: 'Search the web with Tavily for harbour tides?', consequence: null, reason: null },
      destination: null,
      destination_host: 'Tavily',
    });
    expect(approvalFacts(card)).toEqual([]);
  });

  it('lists a page address once, without the site it already names', () => {
    const card = cardWith({
      copy: { headline: 'Open a page on example.org?', consequence: null, reason: null },
      destination: 'https://www.example.org/tickets',
      destination_host: 'www.example.org',
      outbound_text: 'https://www.example.org/tickets',
    });
    expect(approvalFacts(card)).toEqual([{ label: 'Address', value: 'https://www.example.org/tickets' }]);
    expect(outboundRepeatsFacts(card, 'https://www.example.org/tickets')).toBe(true);
    expect(outboundRepeatsFacts(card, 'url: https://www.example.org/other')).toBe(false);
  });

  it('drops a site the question already names, but always lists who it goes to, an amount and a command', () => {
    const card = cardWith({
      copy: { headline: 'Type "Grace" into "Name" on shop.example?', consequence: null, reason: null },
      destination: 'shop.example',
      destination_host: 'shop.example',
      recipient: 'Grace',
      amount: '2',
      parsed_command: 'rm -r old',
    });
    expect(approvalFacts(card)).toEqual([
      { label: 'To', value: 'Grace' },
      { label: 'Amount', value: '2' },
      { label: 'Command', value: 'rm -r old', mono: true },
    ]);
  });

  it('lists a site that differs from the address it receives the call', () => {
    const card = cardWith({ destination: 'acme-corp', destination_host: 'api.acme.example' });
    expect(approvalFacts(card)).toEqual([
      { label: 'Where', value: 'acme-corp' },
      { label: 'Sends to', value: 'api.acme.example' },
    ]);
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

  it('says "Add and save draft" for a draft to a new address, since approving adds it and saves', () => {
    const card = cardWith({ mail_new_recipients: ['a@x.com'], mail_draft: true });
    expect(approveVerb(card)).toBe('Add and save draft');
    expect(declineVerb(card)).toBe("Don't save");
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

  it('calls a persona add a persona in the title and the stub', () => {
    const card = cardWith({
      persona: {
        name: 'Tax helper',
        description: 'Files receipts.',
        instructions: 'Keep every receipt.',
        model_name: 'fast',
      },
    });
    expect(approvalQuestion(card)).toBe('Add the persona "Tax helper"?');
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

  it('gives the generic headline and a plain verb for a card with no fields to build a question from', () => {
    const card = cardWith({});
    expect(approvalQuestion(card)).toBe(GENERIC_CARD_HEADLINE);
    expect(approveVerb(card)).toBe('Allow');
    expect(declineVerb(card)).toBe('Not now');
  });

  it('shows the time in the line of an answered card', () => {
    const card = cardWith({ calendar_event: null });
    expect(approvalSentLine(card, '09:14')).toBe('Allowed · 09:14');
    expect(approvalSentLine(cardWith({ email: reply }), '09:14')).toBe('Sent to Rui · 09:14');
  });

  it('reads the headline, consequence and reason from the server copy when the card carries it', () => {
    const card = cardWith({
      copy: {
        headline: 'Delete "Dentist", Fri 7 Nov, 3:00 PM?',
        consequence: "This removes the event from the calendar. It can't be restored from here.",
        reason: 'Aman always asks before deleting an event in this calendar.',
      },
      cannot_be_undone: 'A different, older note.',
    });
    expect(cardHeadline(card)).toBe('Delete "Dentist", Fri 7 Nov, 3:00 PM?');
    expect(cardConsequence(card)).toBe("This removes the event from the calendar. It can't be restored from here.");
    expect(cardReason(card)).toBe('Aman always asks before deleting an event in this calendar.');
  });

  it('falls back to the older consequence on a card saved before copy existed, with the generic headline', () => {
    const card = cardWith({ cannot_be_undone: "Once this is sent, it can't be unsent." });
    expect(cardHeadline(card)).toBe(GENERIC_CARD_HEADLINE);
    expect(cardConsequence(card)).toBe("Once this is sent, it can't be unsent.");
    expect(cardReason(card)).toBeNull();
  });

  it('never lets an id saved in an old card reach a headline surface', () => {
    // A card saved by the old calendar path before copy existed: its stored sentence names the
    // event by its id. Every surface that shows a headline takes it from cardHeadline or the
    // question built from the card's fields, so the id reaches none of them.
    const idToken = ['ev1', 'L2NhbGVu', 'ZGFyL2Rh', 'dGlvbi05', 'ZjhlN2Q2', 'YzViNGE'].join('.');
    const card = cardWith({ plain_what: `Delete the event with id ${idToken}? Its title could not be read.` });
    expect(cardHeadline(card)).toBe(GENERIC_CARD_HEADLINE);
    expect(approvalQuestion(card)).toBe(GENERIC_CARD_HEADLINE);
    expect(approvalSpeechLine(cardHeadline(card))).not.toContain(idToken);
    expect(cardHeadline(card)).not.toContain(idToken);
  });

  it('names the safe choice for the card kind', () => {
    expect(safeVerb(cardWith({ email: reply }))).toBe("Don't send");
    expect(safeVerb(cardWith({ email: { ...reply, action: 'save' } }))).toBe("Don't save");
    expect(safeVerb(cardWith({ destructive: true }))).toBe('Keep it');
    expect(safeVerb(cardWith({}))).toBe('Not now');
    expect(safeVerb(cardWith({ email: reply, mail_new_recipients: ['a@x.com'] }))).toBe("Don't send");
  });
});
