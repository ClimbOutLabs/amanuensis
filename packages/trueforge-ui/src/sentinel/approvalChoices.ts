import { isSearchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import type { SentinelApprovalCard } from './types.js';

/** The approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Always allow this here', hint: "Don't ask again for this kind of action in this chat." },
  alwaysAllow: { label: 'Always allow', hint: 'Remember this for every chat.' },
  alwaysAllowTool: {
    label: 'Always allow this tool',
    hint: 'Run this tool on this connector without asking, in every chat, until you remove it in settings.',
  },
  changeIt: { label: 'Change it', hint: 'Ask the agent to change this first. Nothing runs now.' },
  deny: { label: 'Deny', hint: 'Do not run this call.' },
} as const;

/**
 * The choices on a mail send to an address not on the Email list. Approving adds the shown addresses, so no
 * chat-wide or always grant is offered on it.
 */
export const NEW_RECIPIENT_CHOICES = {
  approve: { label: 'Add and send', hint: 'Add the addresses shown to your send list, then send.' },
  cancel: { label: "Don't send", hint: 'Do not send. Nothing is added to your send list.' },
} as const;

/** The buttons on a mail card. Edit is the same path as Change it: the agent revises the mail first. */
export const EMAIL_CHOICES = {
  edit: { label: 'Edit', hint: 'Ask the agent to change this first. Nothing is sent now.' },
  saveDraft: { label: 'Save as draft', hint: 'Save this as a draft. Nothing is sent.' },
} as const;

/**
 * The server option that saves a mail as a draft instead of sending it. The card shows Save as draft
 * only when the server offers this option on the approval, so nothing is faked on a server without it.
 */
export const SAVE_DRAFT_OPTION_ID = 'save_draft';

export function isNewRecipientCard(card: SentinelApprovalCard): boolean {
  return (card.mail_new_recipients ?? []).length > 0;
}

/**
 * The option id that asks the runtime for a standing grant: the patched runtime maps it to scope
 * "always" (patches/@truefoundry__assistant-ui-runtime). Keep the two in step.
 */
export const ALWAYS_ALLOW_TOOL_OPTION_ID = 'allow-standing';

/**
 * Cards with content a person may want to edit: a mail, a calendar event, a new schedule, a new persona, or a
 * held web search, whose words they may want to change before it is sent.
 */
export function offersChangeIt(card: SentinelApprovalCard): boolean {
  return (
    isSearchHoldCardText(card.plain_what) ||
    card.email !== null ||
    card.calendar_event !== null ||
    (card.schedule !== null && card.schedule.action === 'create') ||
    card.persona !== null
  );
}
