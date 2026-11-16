import { checkCodeOf, hashDraft } from '../email/gmail/draftReview';
import {
  isGmailReadToolName,
  isGmailWriteToolName,
  SEND_DRAFT_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
} from '../email/gmail/toolContract';
import { emailCardCopy } from './cardCopy';
import { cardSubject, cardText, escapedMailbox, messageForDisplay, plainWhy, recipientList } from './cardText';
import { escapeDisplayText } from './displayText';
import { DEMO_SEND_REFUSAL, recipientsAllowed } from './sendAllowlist';
import {
  autoDenyDecision,
  failClosedDecision,
  tier1Decision,
  tier3Decision,
  type Tier3Card,
  type Tier3Email,
  type TierDecision,
} from './tier';
import { demoRefusal, mintPlainToken } from './tierShared';
import type { ClassifyContext, SentinelAction } from './tierTypes';

/** Said on a card when a recipient's name was left off because it looked like an address. */
const NAME_LEFT_OFF_LINE = ' The name was left off this address because it looked like an address.';

/**
 * The approval card for a Gmail write, built from the message as the host holds it (the draft Gmail stores
 * for a send, the content the call will write for a draft), never from model prose. The whole message is on
 * the card, uncut, so what is approved is everything that is sent. Null when the message was not supplied.
 */
function gmailWriteCard(input: { action: SentinelAction; agent_intent: string | null }): Tier3Card | null {
  const { action } = input;
  const content = action.mail_draft;
  if (content === undefined) {
    return null;
  }
  const kind =
    action.tool_name === SEND_DRAFT_TOOL_NAME
      ? 'send'
      : action.tool_name === UPDATE_DRAFT_TOOL_NAME
        ? 'change'
        : 'save';
  const parts = [
    `to ${recipientList(content.to) === '' ? 'no one' : recipientList(content.to)}`,
    ...(content.cc.length > 0 ? [`Copy: ${recipientList(content.cc)}`] : []),
    ...(content.bcc.length > 0 ? [`Hidden copy: ${recipientList(content.bcc)}`] : []),
    ...(content.replyTo === null ? [] : [`Replies go to: ${escapeDisplayText(content.replyTo)}`]),
  ];
  const subject = cardSubject(content.subject);
  const replaces = action.mail_replaces;
  const recipientsLine = [
    ...parts,
    ...(content.fromName === ''
      ? []
      : [`Sent as "${escapeDisplayText(content.fromName).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]),
  ].join('. ');
  const answered = action.mail_reply_in_thread;
  const threadLine =
    answered === undefined
      ? ''
      : ` Reply in the thread: ${cardSubject(answered.subject)}, from ${cardText(answered.from)}.`;
  const plainWhat =
    (kind === 'send'
      ? `Send ${subject} from your Gmail ${recipientsLine}?`
      : kind === 'change'
        ? `Change a saved draft in your Gmail? It replaces ${replaces === undefined ? 'the saved draft' : `${cardSubject(replaces.subject)} to ${recipientList(replaces.to) === '' ? 'no one' : recipientList(replaces.to)}`} with ${subject} ${recipientsLine}. It is not sent.`
        : `Save a draft ${subject} in your Gmail ${recipientsLine}? It is not sent.`) +
    threadLine +
    (content.nameLeftOff || replaces?.nameLeftOff === true ? NAME_LEFT_OFF_LINE : '');
  const email: Tier3Email = {
    action: kind,
    ...messageForDisplay(content),
    from_name: content.fromName === '' ? null : escapeDisplayText(content.fromName),
    name_left_off: content.nameLeftOff || replaces?.nameLeftOff === true,
    check_code: kind === 'send' ? checkCodeOf(hashDraft(content)) : null,
    replaces:
      replaces === undefined
        ? null
        : {
            subject: escapeDisplayText(replaces.subject),
            to: replaces.to.map(escapedMailbox),
          },
    reply_in_thread:
      answered === undefined
        ? null
        : { subject: escapeDisplayText(answered.subject), from: escapeDisplayText(answered.from) },
  };
  return {
    plain_what: plainWhat,
    copy: emailCardCopy(email),
    // A send reaches other people and cannot be unsent, so its safe choice comes first; a draft does not.
    safe_choice: kind === 'send',
    destructive: kind === 'send',
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: kind === 'send' ? "Once this is sent, it can't be unsent." : null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    email,
    // The draft was checked to send from the connected account, so the card names that account.
    mail_from: escapeDisplayText(content.fromAddress),
  };
}

/**
 * Gmail tools are the host's own, named by server so a connector's tool of the same name never takes this
 * path. Reads are silent but flagged as sensitive, and a session that read mail can no longer search silently.
 */
export async function classifyGmailTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Gmail needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  if (isGmailReadToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'gmail_read',
      reason_detail: 'Read your email.',
      sensitive_read: true,
    });
  }
  if (!isGmailWriteToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown Gmail tool.' });
  }
  if (ctx.services.unattended) {
    return autoDenyDecision({
      reason: 'unattended_run',
      reason_detail: 'Scheduled runs can read your email but never draft or send it.',
      sensitive_read: false,
    });
  }
  const draft = action.mail_draft;
  if (
    action.tool_name === SEND_DRAFT_TOOL_NAME &&
    ctx.services.demoSendAllowlist !== null &&
    (draft === undefined ||
      !recipientsAllowed({
        allowlist: ctx.services.demoSendAllowlist,
        recipients: [...draft.to, ...draft.cc, ...draft.bcc].map(mailbox => mailbox.address),
      }))
  ) {
    return demoRefusal(DEMO_SEND_REFUSAL);
  }
  const card = gmailWriteCard({ action, agent_intent: ctx.agent_intent });
  if (card === null) {
    return autoDenyDecision({
      reason: 'destination_unverifiable',
      reason_detail: 'The message could not be loaded to show you, so it was not offered.',
      sensitive_read: false,
    });
  }
  const isSend = action.tool_name === SEND_DRAFT_TOOL_NAME;
  return tier3Decision({
    card,
    reason: isSend ? 'gmail_send' : 'gmail_draft',
    reason_detail: isSend ? 'Sending email always asks.' : 'Saving a draft always asks.',
    sensitive_read: false,
    standing_grant_barred: true,
    approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
  });
}
