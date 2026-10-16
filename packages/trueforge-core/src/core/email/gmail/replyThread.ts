/**
 * Decides whether the reply headers of a draft are ones Aman can stand behind. Only ids the server read from
 * Gmail count: In-Reply-To must be the Message-ID of a message in the draft's own thread, and every id in
 * References must come from that thread. Text the model or an edit supplied is never trusted on its own.
 */
import type { ReviewableDraft } from './draftReview';
import type { GmailThread } from './gmailWire';
import { headerOf, rawHeaderOf } from './message';
import { idsIn, MAX_REFERENCES, parseIdList } from './messageId';

/** The message a reply answers, as shown on the approval card. */
export interface AnsweredMessage {
  subject: string;
  from: string;
}

type ReplyCheck = { ok: true; answered: AnsweredMessage | null } | { ok: false; reason: string };

const MISMATCH =
  'This reply is not tied to a message in its own Gmail thread, so Aman cannot show or send it as a reply. Ask me to write the reply again.';

/** True when the draft carries any threading header, so its thread must be read before it is shown or sent. */
export function isReply(draft: Pick<ReviewableDraft, 'inReplyTo' | 'references'>): boolean {
  return draft.inReplyTo !== '' || draft.references !== '';
}

/** A real, sent or received message of the thread: the draft being checked and other drafts never vouch for ids. */
function vouchingMessages(input: { thread: GmailThread; draftMessageId: string }) {
  return (input.thread.messages ?? []).filter(
    message => message.id !== input.draftMessageId && !(message.labelIds ?? []).includes('DRAFT'),
  );
}

/**
 * Checks a draft's reply headers against the thread Gmail holds for it. A draft with no reply headers is not a
 * reply and passes. A reply passes when its In-Reply-To is one message of the thread and its References are
 * ids of that thread, ending in the message it answers.
 */
export function checkReplyThreading(input: {
  draft: ReviewableDraft;
  draftMessageId: string;
  thread: GmailThread | undefined;
}): ReplyCheck {
  const { draft, thread } = input;
  if (!isReply(draft)) {
    return { ok: true, answered: null };
  }
  const answeredIds = parseIdList({ value: draft.inReplyTo, max: 1 });
  const chain = parseIdList({ value: draft.references, max: MAX_REFERENCES });
  const answeredId = answeredIds?.[0];
  if (answeredId === undefined || chain?.includes(answeredId) !== true) {
    return { ok: false, reason: MISMATCH };
  }
  if (thread === undefined) {
    return { ok: false, reason: MISMATCH };
  }
  if (thread.id !== draft.threadId) {
    return { ok: false, reason: MISMATCH };
  }
  const messages = vouchingMessages({ thread, draftMessageId: input.draftMessageId });
  const answered = messages.find(message => {
    const part = message.payload;
    return part === undefined ? false : idsIn(rawHeaderOf({ part, name: 'message-id' })).includes(answeredId);
  });
  if (answered === undefined) {
    return { ok: false, reason: MISMATCH };
  }
  const known = new Set(
    messages.flatMap(message => {
      const part = message.payload;
      return part === undefined
        ? []
        : [...idsIn(rawHeaderOf({ part, name: 'message-id' })), ...idsIn(rawHeaderOf({ part, name: 'references' }))];
    }),
  );
  if (!chain.every(id => known.has(id))) {
    return { ok: false, reason: MISMATCH };
  }
  return {
    ok: true,
    answered: {
      subject: headerOf({ message: answered, name: 'Subject' }),
      from: headerOf({ message: answered, name: 'From' }),
    },
  };
}
