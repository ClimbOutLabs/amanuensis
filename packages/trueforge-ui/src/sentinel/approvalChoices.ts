import type { SentinelApprovalCard } from './types.js';

/** The approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Approve for this chat', hint: 'Allow this kind of call for the rest of this chat.' },
  alwaysAllow: { label: 'Always allow', hint: 'Remember this for every chat.' },
  changeIt: { label: 'Change it', hint: 'Ask the agent to change this first. Nothing runs now.' },
  deny: { label: 'Deny', hint: 'Do not run this call.' },
} as const;

/** Cards with content a person may want to edit: a mail, a calendar event, a new schedule, or a new specialist. */
export function offersChangeIt(card: SentinelApprovalCard): boolean {
  return (
    card.email !== null ||
    card.calendar_event !== null ||
    (card.schedule !== null && card.schedule.action === 'create') ||
    card.persona !== null
  );
}
