import type { CalendarWriteReview } from '../calendar/eventWrite';
import { isCalendarReadToolName, isCalendarWriteToolName } from '../calendar/toolContract';
import { calendarCardCopy } from './cardCopy';
import { cardSubject, displayList, plainWhy } from './cardText';
import { escapeDisplayText } from './displayText';
import { checkOutboundStrings, describeOutboundRule } from './outboundGuard';
import { DEMO_SEND_REFUSAL, recipientsAllowed } from './sendAllowlist';
import {
  autoDenyDecision,
  failClosedDecision,
  tier1Decision,
  tier3Decision,
  type Tier3Card,
  type TierDecision,
} from './tier';
import { demoRefusal, mintPlainToken } from './tierShared';
import type { ClassifyContext, SentinelAction } from './tierTypes';

/**
 * The approval card for a Calendar write, built from the request the host will send, never from model prose.
 * Every guest is listed, and whether Google emails them is said in words.
 */
function calendarWriteCard(input: {
  review: CalendarWriteReview;
  agent_intent: string | null;
  assistant: string;
}): Tier3Card {
  const { review, assistant } = input;
  const show = (text: string) => escapeDisplayText(text);
  const title = cardSubject(review.title);
  const guests = displayList(review.attendees);
  const guestLine =
    review.attendees.length === 0
      ? ''
      : review.guests_emailed
        ? ` Google emails ${guests} about it.`
        : ` Guests: ${guests}. Google does not email them.`;
  // An event that runs over more than one day is often a broken end date, so the card asks.
  const spanWarning =
    review.span_days > 1 ? ` This event runs over ${String(review.span_days)} days. Is that right?` : '';
  // The same event was already created in this chat in the last few minutes: the card says so.
  const duplicateLead = review.action === 'create' && review.already_created ? 'You already have this event.' : '';
  const headline =
    review.action === 'create'
      ? `Add ${title} to your Google Calendar on ${show(review.short_when)} (${show(review.time_zone)})?`
      : `Change ${review.before === null ? 'an event' : cardSubject(review.before.title)}${review.one_of_repeating ? ' (this one event of a repeating series)' : ''} in your Google Calendar to ${title} on ${show(review.short_when)} (${show(review.time_zone)})?`;
  // The facts that follow from approving, in order: a duplicate warning, who gets emailed, a span warning.
  const emailed =
    [duplicateLead.trim(), guestLine.trim(), spanWarning.trim()].filter(part => part !== '').join(' ') || null;
  // Says why a guest change asks every time: neither a standing nor a chat-wide answer covers it.
  const alwaysAsks =
    review.attendees.length === 0
      ? null
      : review.action === 'create'
        ? `This change sends an invitation to other people, so ${assistant} always asks.`
        : `This change reaches the other people invited to this event, so ${assistant} always asks.`;
  const undo = review.guests_emailed ? "Google emails the guests right away. That email can't be unsent." : null;
  return {
    plain_what: emailed === null ? headline : `${headline} ${emailed}`,
    copy: calendarCardCopy({ headline, emailed, undo, reason: alwaysAsks }),
    // A change that reaches guests puts the safe choice first; one on the person's own calendar does not.
    safe_choice: review.attendees.length > 0,
    destructive: false,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: undo,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    calendar_event: {
      action: review.action,
      calendar: show(review.calendar),
      title: show(review.title),
      when: show(review.short_when),
      time_zone: show(review.time_zone),
      duration: show(review.duration),
      location: show(review.location),
      description: escapeDisplayText(review.description, { keepNewlines: true }),
      attendees: review.attendees.map(show),
      guests_line: show(review.guests_line),
      one_of_repeating: review.one_of_repeating,
      already_created: review.action === 'create' && review.already_created,
      span_days: review.span_days,
      before:
        review.before === null
          ? null
          : {
              title: show(review.before.title),
              when: show(review.before.short_when),
              duration: show(review.before.duration),
              location: show(review.before.location),
            },
    },
  };
}

/**
 * Calendar tools are the host's own, named by server. A read is silent but flagged as sensitive (so a session that
 * read the calendar can no longer search silently). A write always asks with the event in full; in a scheduled run
 * that ask is held for the owner's OK instead of running. Any other name fails closed.
 */
export async function classifyCalendarTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Google Calendar needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  if (isCalendarWriteToolName(action.tool_name)) {
    if (action.calendar_write === undefined) {
      return autoDenyDecision({
        reason: 'destination_unverifiable',
        reason_detail: 'The event could not be loaded to show you, so it was not offered.',
        sensitive_read: false,
      });
    }
    const review = action.calendar_write;
    // A guest is reached even without an email (Google adds invites to their calendar), so on a demo every guest
    // must be on the send list. An event with no guests reaches no one.
    if (
      review.attendees.length > 0 &&
      !recipientsAllowed({ allowlist: ctx.services.demoSendAllowlist, recipients: review.attendees })
    ) {
      return demoRefusal(DEMO_SEND_REFUSAL);
    }
    if (review.incomplete_reason !== null) {
      return autoDenyDecision({
        reason: 'incomplete_send_card',
        reason_detail: review.incomplete_reason,
        owner_message: 'Nothing was saved: the guests would get something the card could not show you.',
        sensitive_read: false,
      });
    }
    // Guests who are emailed get the event text, so it is a send and passes the same secret guard.
    if (review.guests_emailed) {
      const verdict = checkOutboundStrings({
        strings: { values: [review.title, review.description, review.location], scalars: [], keys: [], plumbing: [] },
        secrets: await ctx.services.outboundSecrets({ tenant_id: ctx.tenant_id, created_by: ctx.created_by }),
      });
      if (!verdict.ok) {
        return autoDenyDecision({
          reason: 'outbound_guard',
          reason_detail: `The event would be emailed to its guests, and ${describeOutboundRule(verdict.rule)}.`,
          sensitive_read: false,
        });
      }
    }
    const reachesGuests = review.attendees.length > 0;
    return tier3Decision({
      card: calendarWriteCard({ review, agent_intent: ctx.agent_intent, assistant: ctx.web_search.assistantName }),
      reason: reachesGuests ? 'calendar_write_guests' : 'calendar_write',
      reason_detail: reachesGuests
        ? 'A calendar change that reaches guests always asks.'
        : 'Adding or changing an event on your own calendar asks.',
      sensitive_read: false,
      standing_grant_barred: reachesGuests,
      own_calendar_change: !reachesGuests,
      approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }
  if (!isCalendarReadToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown calendar tool.' });
  }
  return tier1Decision({
    reason: 'calendar_read',
    reason_detail: 'Read your calendar.',
    sensitive_read: true,
  });
}
