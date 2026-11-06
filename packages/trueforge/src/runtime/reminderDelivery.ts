import type { ISessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { REMINDERS_CHAT_TITLE, REMINDERS_METADATA_KEY } from '@truefoundry/trueforge-core/core/schedules/toolContract';
import type { IAgentStore } from '../db/agentStore';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { appendAssistantLine } from './assistantLine';
import type { DeliveryService } from './delivery/deliveryService';
import { joinReasons } from './noticing/reachRules';
import type { ReminderReach } from './noticing/reminderReach';
import { formatRunTime } from './scheduleCapability';

function remindersExternalId(subjectId: string): string {
  return `reminders:${subjectId}`;
}

/** The line the person reads in the Reminders chat. */
export function reminderLineText(input: { what: string; due: Date; timezone: string }): string {
  return `Reminder: ${input.what}\n\nDue ${formatRunTime({ at: input.due, timezone: input.timezone })}.`;
}

/** The most a feed item holds. A longer reminder keeps every word in its chat line and is cut short in the feed. */
export const REMINDER_FEED_TEXT_MAX = 2000;

function feedText(what: string): string {
  return what.length <= REMINDER_FEED_TEXT_MAX ? what : `${what.slice(0, REMINDER_FEED_TEXT_MAX - 1).trimEnd()}…`;
}

export class ReminderAgentNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('The assistant that set this reminder was deleted. Set the reminder again in a chat.', options);
    this.name = 'ReminderAgentNotFoundError';
  }
}

/**
 * Writes one due reminder into the owner's Reminders chat as a finished assistant line, then puts it in the
 * owner's feed, which also pushes it to their devices and records it in the activity log. The host writes it
 * itself: no model is called, so it lands at once and costs nothing. The chat is made on the first reminder
 * and reused after. Returns the chat and the turn it wrote.
 */
export async function deliverReminder(params: {
  item: ScheduleDispatchItem;
  sessions: Pick<Sessions<SessionCustom, TurnCustom>, 'getOrCreateByExternalId'>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  now: Date;
  /** The feed the reminder is also delivered through; it writes the reason to Activity. */
  deliveries: Pick<DeliveryService, 'deliver'>;
  /** Settles how loud the reminder is, by the person's own rules for the channels. */
  reach: ReminderReach;
}): Promise<{ session_id: string; turn_id: string }> {
  const { item, sessions, sessionStore, agentStore, now } = params;
  const { schedule, run } = item;
  const owner = schedule.created_by_subject;
  const agent = await agentStore.getAgent({ tenant_id: schedule.tenant_id, name: schedule.agent_name });
  if (agent === undefined) {
    throw new ReminderAgentNotFoundError();
  }
  const { session: handle } = await sessions.getOrCreateByExternalId({
    tenant_id: schedule.tenant_id,
    external_id: remindersExternalId(owner.subject_id),
    created_by_subject: owner,
    agent: { type: 'reference', id: agent.id, name: agent.name },
    metadata: { [REMINDERS_METADATA_KEY]: 'true' },
  });
  const sessionId = handle.session_id;
  const record = await sessionStore.getSession({ tenant_id: schedule.tenant_id, session_id: sessionId });
  if (record === undefined) {
    throw new Error(`The Reminders chat could not be read: ${sessionId}`);
  }
  const what = schedule.manifest.task;
  const text = reminderLineText({
    what,
    due: new Date(run.scheduled_for),
    timezone: schedule.manifest.timezone,
  });
  const turnId = await appendAssistantLine({
    sessionStore,
    tenant_id: schedule.tenant_id,
    session_id: sessionId,
    text,
    title: REMINDERS_CHAT_TITLE,
    now,
  });

  // The chat list learns of a new reminder from the chat's marker; the feed carries what is unread.
  await sessionStore.updateSession({
    tenant_id: schedule.tenant_id,
    session_id: sessionId,
    agent: undefined,
    title: undefined,
    metadata: { ...record.metadata, [REMINDERS_METADATA_KEY]: 'true' },
  });

  const person = { tenant_id: schedule.tenant_id, created_by: owner.subject_id };
  await params.reach.deliver({
    owner: person,
    urgent: schedule.manifest.urgent,
    timezone: schedule.manifest.timezone,
    at: params.now,
    send: decision =>
      params.deliveries.deliver({
        ...person,
        kind: 'reminder',
        level: decision.delivered,
        text: feedText(what),
        reason: joinReasons([
          `You asked to be reminded on ${formatRunTime({ at: new Date(run.scheduled_for), timezone: schedule.manifest.timezone })}.`,
          ...decision.steps,
        ]),
        link: { type: 'chat', session_id: sessionId },
        created_at: params.now,
      }),
  });
  return { session_id: sessionId, turn_id: turnId };
}
