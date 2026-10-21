import { formatCaldavWhen, type CaldavEventReview } from '../calendar/caldav/eventReview';
import {
  CALDAV_SERVER_NAME,
  CALDAV_WRITE_FIELDS,
  isCaldavToolName,
  type CaldavToolName,
} from '../calendar/caldav/toolContract';
import type { SentinelAction } from './classifier';
import { escapeDisplayText, renderOutboundArguments, SEND_VALUE_MAX_CHARS } from './extractorRegistry';
import { tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';

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
}: {
  action: Pick<SentinelAction, 'tool_name' | 'canonical_params' | 'tool_type' | 'mcp_server_name' | 'mcp_first_party'>;
  review: CaldavEventReview | null;
  mintToken: () => Promise<string>;
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
      reason: 'caldav_private_read',
      reason_detail: 'Read your calendar.',
      sensitive_read: true,
    });
  }

  const card = cardFor({ tool, params, review });
  // A call that writes a field the card cannot show gets the generic card, which shows the raw call.
  if (card === null) {
    return undefined;
  }
  return tier3Decision({
    card,
    reason: tool === 'respond_to_event' ? 'caldav_invitation_reply' : 'caldav_calendar_change',
    reason_detail: 'Calendar change from your connected calendar; always asks.',
    sensitive_read: true,
    approval_token_id: await mintToken(),
  });
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
}: {
  tool: CaldavToolName;
  params: Record<string, unknown>;
  review: CaldavEventReview | null;
}): Tier3Card | null {
  const written = CALDAV_WRITE_FIELDS[tool];
  if (written === undefined) {
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
  const existing = eventSubject({ params, review });
  const plainWhat = plainWhatFor({ tool, params, existing, review });
  return cardWith({
    plain_what: plainWhat.text,
    cannot_be_undone: plainWhat.cannot_be_undone,
    outbound_text: outbound.text,
  });
}

function plainWhatFor({
  tool,
  params,
  existing,
  review,
}: {
  tool: CaldavToolName;
  params: Record<string, unknown>;
  existing: { text: string };
  review: CaldavEventReview | null;
}): { text: string; cannot_be_undone: string | null } {
  if (tool === 'create_event') {
    const calendar = stringParam(params, 'calendar_id');
    const calendarText = calendar === null ? 'your calendar' : `"${shown(calendar)}"`;
    const title = stringParam(params, 'summary');
    const when = formatCaldavWhen({ value: stringParam(params, 'start') ?? '', all_day: false });
    return {
      text: `Add ${title === null ? 'an event with no title' : `"${shown(title)}"`}${whenText(when)} to ${calendarText}.`,
      cannot_be_undone: null,
    };
  }
  if (tool === 'update_event') {
    return { text: `Change ${existing.text}.`, cannot_be_undone: null };
  }
  if (tool === 'delete_event') {
    return {
      text: `Delete ${existing.text}.`,
      cannot_be_undone: "This removes the event from the calendar. It can't be restored from here.",
    };
  }
  // respond_to_event: only the organizer is sent the reply, so only the organizer is named.
  const verb = answerVerb(stringParam(params, 'response'));
  const organizer = review?.organizer ?? null;
  const organizerText =
    organizer === null
      ? 'The organizer will be told. Their name could not be read.'
      : `The organizer, ${shown(organizer)}, will be told.`;
  return {
    text: `${verb} ${existing.text}. ${organizerText}`,
    cannot_be_undone: "The reply to the organizer can't be unsent.",
  };
}

/** The title and time the card names. A failed lookup is said plainly, with the event id. */
function eventSubject({ params, review }: { params: Record<string, unknown>; review: CaldavEventReview | null }): {
  text: string;
} {
  const id = stringParam(params, 'id') ?? review?.id ?? 'unknown';
  if (review?.title == null) {
    return { text: `the event with id ${shown(id)}. Its title could not be read` };
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
  cannot_be_undone,
  outbound_text,
}: {
  plain_what: string;
  cannot_be_undone: string | null;
  outbound_text: string | null;
}): Tier3Card {
  return {
    plain_what,
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
