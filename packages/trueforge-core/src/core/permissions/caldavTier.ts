import { formatCaldavWhen, type CaldavEventReview } from '../calendar/caldav/eventReview';
import {
  CALDAV_SERVER_NAME,
  CALDAV_WRITE_FIELDS,
  isCaldavToolName,
  type CaldavToolName,
} from '../calendar/caldav/toolContract';
import { calendarCardCopy } from './cardCopy';
import type { SentinelAction } from './classifier';
import { CALDAV_PRIVATE_READ_REASON } from './connectorTrust';
import { escapeDisplayText } from './displayText';
import { renderOutboundArguments, SEND_VALUE_MAX_CHARS } from './extractorRegistry';
import {
  autoDenyDecision,
  tier1Decision,
  tier3Decision,
  type ApprovalCardCopy,
  type Tier3Card,
  type TierDecision,
} from './tier';

/**
 * Tier rules for the CalDAV connector. Only the mounted connector, marked first-party, gets them.
 * Any other server with the same name, and any tool not listed here, returns undefined so the
 * generic path asks (fail closed).
 *
 * `respond_to_event` without a confirm token changes nothing: the server answers with a token and
 * stops. So that first call is a silent read, and the card shows once, on the call with the token.
 */
export async function classifyCaldavTool({
  action,
  review,
  mintToken,
  assistant,
}: {
  action: Pick<SentinelAction, 'tool_name' | 'canonical_params' | 'tool_type' | 'mcp_server_name' | 'mcp_first_party'>;
  review: CaldavEventReview | null;
  mintToken: () => Promise<string>;
  /** The assistant's display name, for the sentence that says who always asks. */
  assistant: string;
}): Promise<TierDecision | undefined> {
  if (action.tool_type !== 'mcp' || action.mcp_server_name !== CALDAV_SERVER_NAME || action.mcp_first_party !== true) {
    return undefined;
  }
  if (!isCaldavToolName(action.tool_name)) {
    return undefined;
  }
  const tool: CaldavToolName = action.tool_name;
  const params = action.canonical_params;

  if (tool === 'respond_to_event' && !hasToken(params)) {
    return tier1Decision({
      reason: 'caldav_invitation_check',
      reason_detail: 'Checks an invitation before you answer it. Nothing changes.',
      sensitive_read: true,
    });
  }
  if (tool === 'list_calendars' || tool === 'list_events' || tool === 'get_event' || tool === 'search_events') {
    return tier1Decision({
      reason: CALDAV_PRIVATE_READ_REASON,
      reason_detail: 'Read your calendar.',
      sensitive_read: true,
    });
  }

  // A change to an existing event the card cannot name is refused, never carded: without the title
  // the person cannot tell which event they are approving, and the event id is not a name.
  if (tool !== 'create_event' && review?.title == null) {
    return autoDenyDecision({
      reason: 'cannot_describe',
      reason_detail: 'The event could not be read, so the change was refused instead of carded.',
      owner_message: undescribableEventMessage(tool),
      sensitive_read: true,
    });
  }
  // A change or cancellation reaches the event's guests, so a guest list that cannot be read is
  // refused the same way: Aman cannot say who the change reaches, and a card may not guess.
  if ((tool === 'delete_event' || tool === 'update_event') && review?.attendees == null) {
    return autoDenyDecision({
      reason: 'cannot_describe',
      reason_detail: 'The guest list could not be read, so the change was refused instead of carded.',
      owner_message: unknownGuestsMessage(tool),
      sensitive_read: true,
    });
  }
  // A reply goes to the organizer, so an organizer that cannot be read refuses the same way.
  if (tool === 'respond_to_event' && review?.organizer == null) {
    return autoDenyDecision({
      reason: 'cannot_describe',
      reason_detail: 'The organizer could not be read, so the reply was refused instead of carded.',
      owner_message: unknownGuestsMessage(tool),
      sensitive_read: true,
    });
  }
  const reach = reachFor({ tool, assistant });
  const card = cardFor({ tool, params, review, reason: reach.reason_text });
  // A call that writes a field the card cannot show gets the generic card, which shows the raw call.
  if (card === null) {
    return undefined;
  }
  return tier3Decision({
    card,
    reason: reach.reason,
    reason_detail: reach.reason_detail,
    sensitive_read: true,
    standing_grant_barred: reach.standing_grant_barred,
    own_calendar_change: reach.own_calendar_change,
    approval_token_id: await mintToken(),
  });
}

/**
 * What the person is told when a change names an event Aman cannot read. The refusal is the whole
 * answer: which event it is stays unknown, so no card is raised and nothing runs.
 */
function undescribableEventMessage(tool: CaldavToolName): string {
  if (tool === 'delete_event') {
    return "I can't see which event this is or who's on it, so I won't delete it. Open it in your calendar and tell me the title.";
  }
  if (tool === 'update_event') {
    return "I can't see which event this is or who's on it, so I won't change it. Open it in your calendar and tell me the title.";
  }
  return "I can't see which event this is, so I won't answer it. Open it in your calendar and tell me the title.";
}

/**
 * What the person is told when the event is named but the people the action reaches cannot be
 * read: the guests of a change or cancellation, or the organizer a reply goes to. The refusal is
 * the whole answer, with the one thing to do next.
 */
function unknownGuestsMessage(tool: CaldavToolName): string {
  if (tool === 'delete_event') {
    return "I can't see who's on this event, so I won't delete it. Open it in your calendar and tell me who's on it.";
  }
  if (tool === 'update_event') {
    return "I can't see who's on this event, so I won't change it. Open it in your calendar and tell me who's on it.";
  }
  return "I can't see who this reply goes to, so I won't answer it. Open it in your calendar and tell me who sent the invitation.";
}

/**
 * Whether a change touches only the person's own calendar. Only a new event can be judged from its own
 * arguments. Aman cannot see every entry in a CalDAV calendar file, so a change or cancellation of an
 * existing event never counts as guest-free, whatever its fetched guest list says.
 */
function reachFor({ tool, assistant }: { tool: CaldavToolName; assistant: string }): {
  reason: string;
  reason_detail: string;
  /** The tier reason the card shows on its own line under the question, or null when the ask needs no reason. */
  reason_text: string | null;
  standing_grant_barred: boolean;
  own_calendar_change: boolean;
} {
  if (tool === 'respond_to_event') {
    return {
      reason: 'caldav_invitation_reply',
      reason_detail: 'Calendar change that reaches guests always asks.',
      reason_text: `This reply goes to the event organizer, so ${assistant} always asks.`,
      standing_grant_barred: true,
      own_calendar_change: false,
    };
  }
  if (tool === 'create_event') {
    return {
      reason: 'caldav_calendar_change',
      reason_detail: 'Calendar change on your own calendar asks.',
      reason_text: null,
      standing_grant_barred: false,
      own_calendar_change: true,
    };
  }
  const verb = tool === 'delete_event' ? 'deleting' : 'changing';
  return {
    reason: 'caldav_calendar_guests',
    reason_detail: 'Change to an existing calendar event always asks.',
    reason_text: `${assistant} always asks before ${verb} an event in this calendar, because it cannot check who else is on it.`,
    standing_grant_barred: true,
    own_calendar_change: false,
  };
}

function hasToken(params: Record<string, unknown>): boolean {
  const token = params['confirm_token'];
  return typeof token === 'string' && token !== '';
}

/**
 * The card for a change, or null when the call sends an argument the card does not list, or when
 * the exact arguments would be cut short. A shorter card never stands in for a longer call.
 */
function cardFor({
  tool,
  params,
  review,
  reason,
}: {
  tool: CaldavToolName;
  params: Record<string, unknown>;
  review: CaldavEventReview | null;
  reason: string | null;
}): Tier3Card | null {
  const written = CALDAV_WRITE_FIELDS[tool];
  if (written === undefined) {
    return null;
  }
  // A change or cancellation names every guest it may email, so a list too long to name gives the generic card.
  if ((tool === 'update_event' || tool === 'delete_event') && guestListTooLong(review)) {
    return null;
  }
  // The confirm token is the approval itself, not something the call writes, so it is not listed.
  const args = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'confirm_token'));
  if (Object.keys(args).some(key => !written.includes(key))) {
    return null;
  }
  const outbound = renderOutboundArguments(args, { valueMaxChars: SEND_VALUE_MAX_CHARS });
  if (outbound.truncated) {
    return null;
  }
  const existing = eventSubject({ review });
  const parts = cardPartsFor({ tool, params, existing, review });
  return cardWith({
    plain_what: parts.emailed === null ? parts.headline : `${parts.headline} ${parts.emailed}`,
    copy: calendarCardCopy({
      headline: parts.headline,
      emailed: parts.emailed,
      undo: parts.undo,
      reason,
    }),
    cannot_be_undone: parts.undo,
    outbound_text: outbound.text,
    safe_choice: tool !== 'create_event',
    destructive: tool === 'delete_event',
  });
}

/**
 * The card's parts before the copy owner assembles them: the headline question on its own, the
 * sentence naming who gets emailed, and what cannot be undone. The tier reason is added by the caller.
 */
function cardPartsFor({
  tool,
  params,
  existing,
  review,
}: {
  tool: CaldavToolName;
  params: Record<string, unknown>;
  existing: { text: string };
  review: CaldavEventReview | null;
}): { headline: string; emailed: string | null; undo: string | null } {
  if (tool === 'create_event') {
    const calendar = stringParam(params, 'calendar_id');
    const calendarText = calendar === null ? 'your calendar' : `"${shown(calendar)}"`;
    const title = stringParam(params, 'summary');
    const when = formatCaldavWhen({ value: stringParam(params, 'start') ?? '', all_day: false });
    return {
      headline: `Add ${title === null ? 'an event with no title' : `"${shown(title)}"`}${whenText(when)} to ${calendarText}?`,
      emailed: null,
      undo: null,
    };
  }
  if (tool === 'update_event') {
    return {
      headline: `Change ${existing.text}?`,
      emailed: emailedGuestsText({ review, lead: 'Changing this' }),
      undo: null,
    };
  }
  if (tool === 'delete_event') {
    // A cancellation is sent to every guest. The classifier refuses a delete whose guest list
    // cannot be read before a card is built, so the list here is the whole list or an empty one.
    const guests = review?.attendees ?? [];
    return {
      headline: `Delete ${existing.text}?`,
      emailed: emailedGuestsText({ review, lead: 'Deleting this' }),
      undo:
        guests.length > 0
          ? "This removes the event from the calendar. It can't be restored from here. A cancellation sent to the guests can't be unsent."
          : "This removes the event from the calendar. It can't be restored from here.",
    };
  }
  // respond_to_event: only the organizer is sent the reply, so only the organizer is named. The
  // classifier refuses a reply whose organizer cannot be read, so a card always has the name.
  const verb = answerVerb(stringParam(params, 'response'));
  const organizer = review?.organizer ?? null;
  const organizerText =
    organizer === null ? 'The organizer will be told.' : `The organizer, ${shown(organizer)}, will be told.`;
  return {
    headline: `${verb} ${existing.text}?`,
    emailed: organizerText,
    undo: "The reply to the organizer can't be unsent.",
  };
}

/** Longest guest list the card names in full. A longer one gives the generic card. */
const MAX_NAMED_GUESTS = 20;

/**
 * The sentence that names the guests a change would email. Null when the event has no guests.
 * A change whose guest list cannot be read is refused before a card is built, so the list a card
 * sees is always the whole list.
 */
function emailedGuestsText({ review, lead }: { review: CaldavEventReview | null; lead: string }): string | null {
  const guests = review?.attendees ?? null;
  if (guests === null || guests.length === 0) {
    return null;
  }
  return `${lead} will email: ${guests.map(shown).join(', ')}.`;
}

/** True when the guest list is too long to name in full on the card. */
function guestListTooLong(review: CaldavEventReview | null): boolean {
  const guests = review?.attendees ?? [];
  return guests.length > MAX_NAMED_GUESTS || guests.join(', ').length > SEND_VALUE_MAX_CHARS;
}

/**
 * The title and time the card names. An event whose title cannot be read never reaches this code:
 * the classifier refuses it first, because a card cannot name an event by its id.
 */
function eventSubject({ review }: { review: CaldavEventReview | null }): { text: string } {
  if (review?.title == null) {
    return { text: 'an event' };
  }
  const when = whenText(review.when);
  return { text: `"${shown(review.title)}"${when}` };
}

function answerVerb(response: string | null): string {
  if (response === 'DECLINED') {
    return 'Decline';
  }
  if (response === 'TENTATIVE') {
    return 'Tentatively accept';
  }
  return 'Accept';
}

function whenText(when: string | null): string {
  return when === null ? '' : `, ${when}`;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function shown(text: string): string {
  return escapeDisplayText(text).replace(/"/g, '\\"');
}

function cardWith({
  plain_what,
  copy,
  cannot_be_undone,
  outbound_text,
  safe_choice,
  destructive,
}: {
  plain_what: string;
  copy: ApprovalCardCopy;
  cannot_be_undone: string | null;
  outbound_text: string | null;
  safe_choice: boolean;
  destructive: boolean;
}): Tier3Card {
  return {
    plain_what,
    copy,
    safe_choice,
    destructive,
    plain_why: null,
    cannot_be_undone,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text,
    destination_host: null,
    outbound_truncated: false,
  };
}

/**
 * What the person is told after a reply goes through. The server says whether the calendar sent
 * the reply itself. When it does not, the organizer was not told, and the result must say so.
 */
export function caldavResultNote({
  tool_name,
  structured,
}: {
  tool_name: string;
  structured: unknown;
}): string | undefined {
  if (tool_name !== 'respond_to_event' || typeof structured !== 'object' || structured === null) {
    return undefined;
  }
  if (!('scheduling' in structured) || structured.scheduling !== false) {
    return undefined;
  }
  return 'Your answer is saved in the calendar. Your calendar does not send replies itself, so the organizer was not told.';
}
