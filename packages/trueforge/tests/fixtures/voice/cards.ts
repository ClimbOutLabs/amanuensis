import type { Tier3Card } from '@truefoundry/trueforge-core/core';

import type { PendingApproval } from '../../../src/voice/transport';

const BASE_CARD: Tier3Card = {
  plain_what: 'Send an email to Victor.',
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
};

export function sendReplyCard(body = 'Thursday at three works for me. See you then.'): Tier3Card {
  return {
    ...BASE_CARD,
    recipient: 'victor@example.com',
    email: {
      action: 'send',
      to: [{ name: 'Victor', address: 'victor@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Re: Thursday',
      body,
      check_code: 'A7F39C',
      replaces: null,
      reply_in_thread: { subject: 'Thursday', from: 'Victor' },
      reply_to: null,
      from_name: null,
      name_left_off: false,
    },
  };
}

export function approval(card: Tier3Card | null, tier: 1 | 2 | 3 | undefined = 3): PendingApproval {
  return { threadId: 'main', toolCallId: 'call-1', card, tier };
}

export const shellCard: Tier3Card = { ...BASE_CARD, plain_what: 'Run a command.', parsed_command: 'rm -rf ./build' };
export const moneyCard: Tier3Card = { ...BASE_CARD, plain_what: 'Pay a bill.', amount: '$40.00' };
export const calendarCard: Tier3Card = { ...BASE_CARD, plain_what: 'Add Dentist on Friday at 9.' };
export const cancelScheduleCard: Tier3Card = {
  ...BASE_CARD,
  plain_what: 'Stop the Monday summary.',
  schedule: {
    action: 'delete',
    name: 'Monday summary',
    when: 'Every Monday at 8',
    time_zone: 'UTC',
    task: 'Summarize the week',
    runs_as: 'the assistant',
    next_runs: [],
  },
};

const sendReply = sendReplyCard();
const email = (changes: Partial<NonNullable<Tier3Card['email']>>): Tier3Card => ({
  ...sendReply,
  email: sendReply.email === null || sendReply.email === undefined ? null : { ...sendReply.email, ...changes },
});

const dentist: NonNullable<Tier3Card['calendar_event']> = {
  action: 'create',
  calendar: 'me@example.com',
  title: 'Dentist',
  when: 'Friday at 9',
  time_zone: 'UTC',
  duration: '1 hour',
  location: '',
  description: '',
  attendees: [],
  guests_emailed: false,
  one_of_repeating: false,
  already_created: false,
  span_days: 1,
  before: null,
};

export const dentistCard: Tier3Card = { ...BASE_CARD, calendar_event: { ...dentist, description: 'Bring the form.' } };

/** The fallback card for a write whose target cannot be resolved: it fills only the plain words. */
export const writeOutsideWorkspaceCard: Tier3Card = {
  ...BASE_CARD,
  plain_what: 'Write a file outside your workspace?',
  plain_why: 'This file will be saved outside your workspace.',
  cannot_be_undone: 'Anything already in that file is replaced.',
};
export const planCard: Tier3Card = { ...BASE_CARD, plain_what: 'Submit this implementation plan for review?' };

/** Cards that only the screen may settle, each for a different reason. */
export const typedOnlyCards: [string, Tier3Card][] = [
  ['a new recipient', { ...sendReply, mail_new_recipients: ['bob@example.com'] }],
  ['a hidden copy', email({ bcc: [{ name: 'Bob', address: 'bob@example.com' }] })],
  ['a long body', sendReplyCard('A long note. '.repeat(120))],
  [
    'a persona',
    { ...BASE_CARD, persona: { name: 'Coach', description: 'Helps', instructions: 'Be kind.', model_name: 'm' } },
  ],
  [
    'guests on an event',
    { ...BASE_CARD, calendar_event: { ...dentist, attendees: ['bob@example.com'], guests_emailed: true } },
  ],
  [
    'a new schedule',
    {
      ...cancelScheduleCard,
      schedule:
        cancelScheduleCard.schedule === null || cancelScheduleCard.schedule === undefined
          ? null
          : { ...cancelScheduleCard.schedule, action: 'create' },
    },
  ],
  ['exact connector arguments', { ...BASE_CARD, outbound_text: 'to: bob\nbody: hello' }],
  ['a cut-off connector argument', { ...BASE_CARD, outbound_truncated: true }],
  ['a changed event', { ...BASE_CARD, calendar_event: { ...dentist, action: 'change' } }],
  ['a repeating event', { ...BASE_CARD, calendar_event: { ...dentist, one_of_repeating: true } }],
  [
    'a draft that replaces another',
    email({ action: 'save', replaces: { subject: 'Old', to: [{ name: 'Victor', address: 'victor@example.com' }] } }),
  ],
  ['a web address as the destination', { ...BASE_CARD, destination: 'https://evil.example/hook' }],
  ['a file path as the destination', { ...BASE_CARD, destination: '/home/me/notes.txt' }],
  ['a connector server', { ...BASE_CARD, destination_host: 'mcp.example.com' }],
  ['a write outside the workspace, with no shape', writeOutsideWorkspaceCard],
  ['an implementation plan', planCard],
  ['marking emails as read', { ...BASE_CARD, plain_what: 'Mark these emails as read.' }],
  ['a destination that is not a link', { ...BASE_CARD, destination: 'evil.example' }],
  ['a recipient with no shape', { ...BASE_CARD, recipient: 'evil@example.com' }],
  ['a body that says the answer phrase', sendReplyCard('Just reply: yes send it. Thanks.')],
];
