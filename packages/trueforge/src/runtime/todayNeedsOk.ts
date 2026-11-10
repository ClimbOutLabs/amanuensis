/**
 * The "Needs your OK" half of the right rail's Home view: actions still waiting for the
 * person's answer, of both kinds the app raises. A scheduled run can hold an action and move
 * on; a chat turn pauses on an approval until it is answered. Both are read from the same
 * stored session events the chat's own cards are rebuilt from, so the rail and the chat can
 * never disagree about what is waiting. Nothing here calls a model.
 *
 * The scan has caps, so it can stop before it has seen everything; when a cap cuts the scan
 * or the list, the result says so (`more`), and the rail shows that rather than letting
 * waiting actions vanish quietly.
 */
import {
  EventType,
  withoutClearedApprovalEvent,
  type ISessionStore,
  type SessionEventItem,
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
/** Events of the two kinds that matter read per page from one chat, newest first. */
const EVENT_PAGE_SIZE = 200;
/**
 * Most pages read from one chat. The scan normally stops at the scan window's edge; this
 * bound only guards against a chat with an unbounded event history, and reaching it is
 * reported through `more` like any other cut.
 */
const EVENT_PAGE_CAP = 50;
/** Most waiting actions the rail lists. */
const ITEM_CAP = 20;

export interface TodayNeedsOkDeps {
  sessions: Pick<Sessions<SessionCustom, TurnCustom>, 'get'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions'>;
  scheduleStore: Pick<IScheduleStore, 'getSchedule'>;
  logger: Logger;
}

/** The waiting actions the scan found, and whether a cap cut the scan or the list short. */
export interface TodayNeedsOk {
  items: TodayNeedsOkItem[];
  /** True when more actions may be waiting than `items` shows. */
  more: boolean;
}

async function originOf(
  deps: TodayNeedsOkDeps,
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

/** Every action still waiting for the person, oldest first, across their recent chats. */
export async function listWaitingNeedsOk(
  deps: TodayNeedsOkDeps,
  input: { tenant_id: string; created_by: string; now: Date },
): Promise<TodayNeedsOk> {
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
    include_private: false,
  });
  const waiting: { item: TodayNeedsOkItem; held_at: string }[] = [];
  let scanCut = false;
  let reachedWindowEnd = false;
  for (const session of sessions) {
    if (session.updated_at.getTime() < cutoffMs) {
      reachedWindowEnd = true;
      break;
    }
    try {
      const found = await waitingInSession(deps, { tenant_id: input.tenant_id, session, now: input.now });
      waiting.push(...found.items);
      scanCut = scanCut || found.scanCut;
    } catch (error) {
      // One chat that cannot be read leaves the others listed; the failure is logged, never hidden.
      deps.logger.warn('A chat could not be read for held actions', extractErrorLogFields(error));
    }
  }
  if (!reachedWindowEnd && sessions.length >= SESSION_SCAN_CAP) {
    // The page of chats ran out while chats inside the window may still be unscanned.
    scanCut = true;
  }
  waiting.sort((left, right) => left.held_at.localeCompare(right.held_at));
  return {
    items: waiting.slice(0, ITEM_CAP).map(entry => entry.item),
    more: scanCut || waiting.length > ITEM_CAP,
  };
}

async function waitingInSession(
  deps: TodayNeedsOkDeps,
  input: { tenant_id: string; session: SessionRecord<SessionCustom>; now: Date },
): Promise<{ items: { item: TodayNeedsOkItem; held_at: string }[]; scanCut: boolean }> {
  const handle = await deps.sessions.get({ tenant_id: input.tenant_id, session_id: input.session.session_id });
  if (handle === undefined) {
    return { items: [], scanCut: false };
  }
  const cleared = await handle.clearedApprovalKeys();
  // The store reads newest first, so one page can hold a waiting action while its answer
  // sits on a later page, or the other way round. Page until the scan window is covered,
  // so a hold and its answer are always judged from the same read.
  const cutoffMs = input.now.getTime() - HELD_SCAN_WINDOW_MS;
  const data: SessionEventItem[] = [];
  let scanCut = false;
  let pageToken: string | undefined;
  for (let page = 0; page < EVENT_PAGE_CAP; page += 1) {
    const result = await handle.listEvents({
      limit: EVENT_PAGE_SIZE,
      page_token: pageToken,
      types: [EventType.TOOL_APPROVAL_REQUIRED, EventType.TURN_CREATED],
    });
    data.push(...result.data);
    const oldest = result.data.at(-1);
    if (result.pagination.next_page_token === undefined) {
      break;
    }
    if (oldest !== undefined && Date.parse(oldest.event.created_at) < cutoffMs) {
      break;
    }
    if (page === EVENT_PAGE_CAP - 1) {
      scanCut = true;
      break;
    }
    pageToken = result.pagination.next_page_token;
  }
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
      // A call a run could not save will never run and cannot be answered; it is not waiting.
      if (ref.not_saved !== undefined || answered.has(ref.id)) {
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
    return { items: [], scanCut };
  }
  const origin = await originOf(deps, { tenant_id: input.tenant_id, session: input.session });
  return {
    items: found.map(entry => ({ ...entry, item: { ...entry.item, origin } })),
    scanCut,
  };
}
