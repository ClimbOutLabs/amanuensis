/**
 * The "Needs your OK" half of the right rail's Home view: actions a run held for the person,
 * still unanswered and still inside their day to answer. Read from the same stored session
 * events the chat's own held-action cards are rebuilt from, so the rail and the chat can never
 * disagree about what is waiting. Nothing here calls a model.
 */
import {
  EventType,
  withoutClearedApprovalEvent,
  type ISessionStore,
  type SessionRecord,
  type Sessions,
} from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IScheduleStore } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { TodayNeedsOkItem } from '../schemas/today';

/** Held actions stop being answerable a day after they are held, so older chats cannot hold one. */
const HELD_SCAN_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Most chats looked at for waiting actions, newest first. */
const SESSION_SCAN_CAP = 50;
/** Most events of the two kinds that matter read from one chat. */
const EVENT_SCAN_LIMIT = 200;
/** Most waiting actions the rail lists. */
const ITEM_CAP = 20;

export interface TodayHeldActionsDeps {
  sessions: Pick<Sessions<SessionCustom, TurnCustom>, 'get'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions'>;
  scheduleStore: Pick<IScheduleStore, 'getSchedule'>;
  logger: Logger;
}

async function originOf(
  deps: TodayHeldActionsDeps,
  input: { tenant_id: string; session: SessionRecord<SessionCustom> },
): Promise<string> {
  const { session } = input;
  if (session.source !== null) {
    const schedule = await deps.scheduleStore
      .getSchedule({ tenant_id: input.tenant_id, id: session.source.id })
      .catch(() => undefined);
    if (schedule !== undefined) {
      return schedule.name;
    }
    return session.title ?? 'A schedule';
  }
  return session.title ?? 'A chat';
}

/** Every held action still waiting for the person, oldest first, across their recent chats. */
export async function listWaitingHeldActions(
  deps: TodayHeldActionsDeps,
  input: { tenant_id: string; created_by: string; now: Date },
): Promise<TodayNeedsOkItem[]> {
  const cutoffMs = input.now.getTime() - HELD_SCAN_WINDOW_MS;
  const { data: sessions } = await deps.sessionStore.listSessions({
    tenant_id: input.tenant_id,
    limit: SESSION_SCAN_CAP,
    page_token: undefined,
    order: 'desc',
    start_timestamp: undefined,
    end_timestamp: undefined,
    agent_id: undefined,
    folder_id: undefined,
    no_folder: false,
    created_by_or_agent_ids: { created_by_subject_id: input.created_by, agent_ids: [] },
    metadata: undefined,
    source_type: undefined,
    source_id: undefined,
  });
  const waiting: { item: TodayNeedsOkItem; held_at: string }[] = [];
  for (const session of sessions) {
    if (session.updated_at.getTime() < cutoffMs) {
      break;
    }
    try {
      const items = await waitingInSession(deps, { tenant_id: input.tenant_id, session, now: input.now });
      waiting.push(...items);
    } catch (error) {
      // One chat that cannot be read leaves the others listed; the failure is logged, never hidden.
      deps.logger.warn('A chat could not be read for held actions', extractErrorLogFields(error));
    }
  }
  waiting.sort((left, right) => left.held_at.localeCompare(right.held_at));
  return waiting.slice(0, ITEM_CAP).map(entry => entry.item);
}

async function waitingInSession(
  deps: TodayHeldActionsDeps,
  input: { tenant_id: string; session: SessionRecord<SessionCustom>; now: Date },
): Promise<{ item: TodayNeedsOkItem; held_at: string }[]> {
  const handle = await deps.sessions.get({ tenant_id: input.tenant_id, session_id: input.session.session_id });
  if (handle === undefined) {
    return [];
  }
  const cleared = await handle.clearedApprovalKeys();
  const { data } = await handle.listEvents({
    limit: EVENT_SCAN_LIMIT,
    types: [EventType.TOOL_APPROVAL_REQUIRED, EventType.TURN_CREATED],
  });
  const answered = new Set<string>();
  for (const { event } of data) {
    if (event.type !== EventType.TURN_CREATED || event.input === undefined) {
      continue;
    }
    for (const item of event.input) {
      if (item.type === EventType.USER_TOOL_APPROVAL) {
        answered.add(item.tool_call_id);
      }
    }
  }
  const found: { item: TodayNeedsOkItem; held_at: string }[] = [];
  for (const { event } of data) {
    const visible = withoutClearedApprovalEvent(event, cleared);
    if (visible?.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      continue;
    }
    for (const ref of visible.tool_calls) {
      if (ref.held !== true || answered.has(ref.id)) {
        continue;
      }
      if (ref.expires_at !== undefined && Date.parse(ref.expires_at) <= input.now.getTime()) {
        continue;
      }
      found.push({
        held_at: visible.created_at,
        item: {
          held_action_id: ref.id,
          title: ref.tier3_card?.plain_what ?? 'An action',
          origin: '',
          session_id: input.session.session_id,
        },
      });
    }
  }
  if (found.length === 0) {
    return [];
  }
  const origin = await originOf(deps, { tenant_id: input.tenant_id, session: input.session });
  return found.map(entry => ({ ...entry, item: { ...entry.item, origin } }));
}
