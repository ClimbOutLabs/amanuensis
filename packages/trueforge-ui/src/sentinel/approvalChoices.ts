import type { SentinelApprovalCard } from './types.js';

/** The approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Approve for this chat', hint: 'Allow this kind of call for the rest of this chat.' },
  alwaysAllow: { label: 'Always allow', hint: 'Remember this for every chat.' },
  changeIt: { label: 'Change it', hint: 'Ask the agent to change this first. Nothing runs now.' },
  deny: { label: 'Deny', hint: 'Do not run this call.' },
} as const;

/**
 * The choices on a mail send to an address not on the Email list. Approving adds the shown addresses, so no
 * chat-wide or always grant is offered on it.
 */
export const NEW_RECIPIENT_CHOICES = {
  approve: { label: 'Add and send', hint: 'Add the addresses shown to your send list, then send.' },
  cancel: { label: 'Cancel', hint: 'Do not send. Nothing is added to your send list.' },
} as const;

export function isNewRecipientCard(card: SentinelApprovalCard): boolean {
  return (card.mail_new_recipients ?? []).length > 0;
}

/** Cards with content a person may want to edit: a mail, a calendar event, a new schedule, or a new specialist. */
export function offersChangeIt(card: SentinelApprovalCard): boolean {
  return (
    card.email !== null ||
    card.calendar_event !== null ||
    (card.schedule !== null && card.schedule.action === 'create') ||
    card.persona !== null
  );
}
