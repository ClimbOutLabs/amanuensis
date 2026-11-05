/**
 * Answering an approval card by voice.
 *
 * The card is read back in plain words and only an exact phrase for the card's verb approves it.
 * What the card shows is the server's own text: this file only chooses the words around it, so the
 * same approval token the card uses is what finally runs, with the usual replay and `changed` checks.
 * Cards that hold more than a person can safely check by ear stay on the screen.
 */
import type { Tier3Card } from '@truefoundry/trueforge-core/core';

import { wordsOf } from './echoGuard';

export type ApprovalVerb = 'send' | 'approve' | 'cancel';

const CONFIRM_PHRASES: Record<ApprovalVerb, { spoken: string; heard: string }> = {
  send: { spoken: 'yes, send it', heard: 'yes send it' },
  approve: { spoken: 'yes, approve', heard: 'yes approve' },
  cancel: { spoken: 'yes, cancel it', heard: 'yes cancel it' },
};

const VERB_WORD: Record<ApprovalVerb, string> = { send: 'send', approve: 'go ahead', cancel: 'cancel it' };

/** Longest message read aloud. A longer one cannot be checked by ear, so it is left for the screen. */
const MAX_SPOKEN_BODY_CHARS = 1200;

export type VoiceApprovalPlan =
  | {
      kind: 'ask';
      verb: ApprovalVerb;
      /** What the person is told, in order. `body` is the card's own text; `instruction` tells how to answer. */
      segments: { text: string; role: 'body' | 'instruction' }[];
    }
  | { kind: 'typed_only' };

export interface PendingCard {
  card: Tier3Card | null | undefined;
  tier: 1 | 2 | 3 | undefined;
}

function recipientNames(mailboxes: { name: string; address: string }[]): string {
  const names = mailboxes.map(mailbox => (mailbox.name.trim() === '' ? mailbox.address : mailbox.name.trim()));
  if (names.length <= 1) {
    return names[0] ?? 'the recipient';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

function verbFor(card: Tier3Card): ApprovalVerb {
  if (card.email?.action === 'send') {
    return 'send';
  }
  if (card.schedule?.action === 'delete') {
    return 'cancel';
  }
  return 'approve';
}

/** True when the card holds something a person could not safely settle by voice. */
function needsTheScreen({ card, tier }: { card: Tier3Card; tier: 1 | 2 | 3 | undefined }): boolean {
  const newRecipients = (card.mail_new_recipients ?? []).length > 0;
  const hiddenCopy = (card.email?.bcc ?? []).length > 0;
  const tooLong = (card.email?.body.length ?? 0) > MAX_SPOKEN_BODY_CHARS || card.outbound_truncated;
  const shell = card.parsed_command !== null;
  const money = card.amount !== null;
  return (
    tier === undefined ||
    (tier === 3 && (shell || money)) ||
    newRecipients ||
    hiddenCopy ||
    tooLong ||
    (card.persona !== null && card.persona !== undefined)
  );
}

/**
 * What to say for one waiting card, or `typed_only` when voice may not answer it. Voice answers
 * are also off for a whole transport (a phone line) through `voiceApprovalsAllowed`.
 */
export function planVoiceApproval({
  pending,
  voiceApprovalsAllowed,
}: {
  pending: readonly PendingCard[];
  voiceApprovalsAllowed: boolean;
}): VoiceApprovalPlan {
  const only = pending.length === 1 ? pending[0] : undefined;
  const card = only?.card;
  if (!voiceApprovalsAllowed || only === undefined || card === null || card === undefined) {
    return { kind: 'typed_only' };
  }
  if (needsTheScreen({ card, tier: only.tier })) {
    return { kind: 'typed_only' };
  }
  const verb = verbFor(card);
  const instruction = {
    text: `Say '${CONFIRM_PHRASES[verb].spoken}' to ${VERB_WORD[verb]}, or 'no'.`,
    role: 'instruction' as const,
  };
  const email = card.email;
  if (email !== null && email !== undefined) {
    const to = recipientNames(email.to);
    const cc = email.cc.length > 0 ? [{ text: `Copying ${recipientNames(email.cc)}.`, role: 'body' as const }] : [];
    const opening =
      email.action === 'send'
        ? `I'll send this ${email.reply_in_thread === null ? 'email' : 'reply'} to ${to}.`
        : `I'll save this email to ${to} as a draft. It will not be sent.`;
    return {
      kind: 'ask',
      verb,
      segments: [{ text: opening, role: 'body' }, ...cc, { text: `It says: ${email.body}`, role: 'body' }, instruction],
    };
  }
  const where = card.recipient ?? card.destination;
  const segments: { text: string; role: 'body' | 'instruction' }[] = [
    { text: card.plain_what, role: 'body' },
    ...(where === null ? [] : [{ text: `It goes to ${where}.`, role: 'body' as const }]),
    ...(card.cannot_be_undone === null ? [] : [{ text: card.cannot_be_undone, role: 'body' as const }]),
    instruction,
  ];
  return { kind: 'ask', verb, segments };
}

export type SpokenAnswer = 'confirm' | 'deny' | 'other';

/** Only the exact phrase for the card's verb confirms, and only a plain "no" turns it down. */
export function classifyAnswer({ heard, verb }: { heard: string; verb: ApprovalVerb }): SpokenAnswer {
  const words = wordsOf(heard).join(' ');
  if (words === CONFIRM_PHRASES[verb].heard) {
    return 'confirm';
  }
  return words === 'no' ? 'deny' : 'other';
}

export const APPROVAL_LINES = {
  waiting: (verb: ApprovalVerb): string =>
    `That is still waiting for your answer. Say '${CONFIRM_PHRASES[verb].spoken}', or 'no', or answer it on the screen.`,
  leftForTheApp: "I've left it in the app for you to approve.",
  turnedDown: 'Okay. I did not do it.',
  done: (verb: ApprovalVerb): string =>
    verb === 'send' ? 'Done. I sent it.' : verb === 'cancel' ? 'Done. It is cancelled.' : 'Done.',
  changed: 'What was waiting no longer matches what I read to you, so I did nothing. Open the chat to look at it.',
  notAllowed: 'That is not allowed any more, so I did nothing. Open the chat to look at it.',
  expired: 'That ran out of time, so I did nothing. Ask me again.',
  couldNot: 'I could not finish that. Open the chat to see where it stands.',
} as const;
