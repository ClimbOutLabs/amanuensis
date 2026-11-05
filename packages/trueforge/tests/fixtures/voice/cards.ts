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
      replaces: null,
      reply_in_thread: { subject: 'Thursday', from: 'Victor' },
      reply_to: null,
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
