import { isSearchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import type { SentinelApprovalCard } from './types.js';

/** The approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Always allow in this chat', hint: "Don't ask again for this kind of action in this chat." },
  alwaysAllow: { label: 'Always allow everywhere', hint: 'Remember this for every chat.' },
  alwaysAllowTool: {
    label: 'Always allow everywhere',
    hint: 'Run this tool on this connector without asking, in every chat, until you remove it in settings.',
  },
  changeIt: { label: 'Change it', hint: 'Ask the persona to change this first. Nothing runs now.' },
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

/** The choices on the same card when it approves saving a draft: approving adds the addresses and saves, and nothing is sent. */
export const NEW_RECIPIENT_DRAFT_CHOICES = {
  approve: { label: 'Add and save draft', hint: 'Add the addresses shown to your send list, then save this draft.' },
  cancel: { label: "Don't save", hint: 'Do not save this draft. Nothing is added to your send list.' },
} as const;

/** The buttons on a mail card. Edit is the same path as Change it: the persona revises the mail first. */
export const EMAIL_CHOICES = {
  edit: { label: 'Edit', hint: 'Ask the persona to change this first. Nothing is sent now.' },
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

/** A new-recipient card whose approval saves a draft instead of sending. */
export function isNewRecipientDraftCard(card: SentinelApprovalCard): boolean {
  return isNewRecipientCard(card) && card.mail_draft === true;
}

/**
 * The option id that asks the runtime for a standing grant: the patched runtime maps it to scope
 * "always" (patches/@truefoundry__assistant-ui-runtime). Keep the two in step.
 */
export const ALWAYS_ALLOW_TOOL_OPTION_ID = 'allow-standing';

/**
 * Cards with content a person may want to edit: a mail, a calendar event, a new schedule, a new persona, a
 * held web search, or a mail send or draft to a new recipient, whose words they may want to change first.
 */
export function offersChangeIt(card: SentinelApprovalCard): boolean {
  return (
    isSearchHoldCardText(card.plain_what) ||
    card.email !== null ||
    card.calendar_event !== null ||
    (card.schedule !== null && card.schedule.action === 'create') ||
    card.persona !== null ||
    isNewRecipientCard(card)
  );
}

/** The words of the every-chat button and its confirm step: what the answer covers and where to undo it. */
export type AlwaysAllowConfirm = { hint: string; description: string; undo: string };

/**
 * The every-chat answer on a maps card turns on the Maps switch, so its confirm step names maps and that switch.
 * On any other card it allows one tool of a connector, and `toolSay` says so in that card's own words.
 */
export function alwaysAllowConfirm(input: { covers: 'maps' | undefined; toolSay: string }): AlwaysAllowConfirm {
  if (input.covers === 'maps') {
    return {
      hint: 'Show maps without asking, in every chat, until you turn it off in Settings.',
      description:
        'Maps will show without asking, in every chat and in scheduled runs. A map still asks if it would send something that looks like a password or key.',
      undo: 'You can turn this off later with the Maps switch in Settings.',
    };
  }
  return {
    hint: APPROVAL_CHOICES.alwaysAllowTool.hint,
    description: input.toolSay,
    undo: 'You can remove this later in connector settings.',
  };
}
