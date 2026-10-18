/**
 * Restores exported sessions into a session store at full fidelity.
 *
 * The store contract builds a turn's snapshot incrementally (createTurn
 * carries the previous turn's threads forward and applies appends), so an
 * exported snapshot is decomposed per turn: threads new to the turn start
 * with their full context, retained threads contribute only the suffix past
 * the longest common prefix with the exported snapshot of the turn it
 * continues (its previous_turn_id, so a chat whose first message was edited
 * starts its second root from nothing), and
 * a retained thread whose context was rewritten (compaction) is repaired
 * with an overwrite after creation. Turns are terminated immediately after
 * creation, in export order, so the next turn's predecessor is never still
 * running. A turn that was still running at export time cannot resume, so it
 * is imported as cancelled with the `abandoned` reason, and so is a turn left
 * waiting on an approval or answer that no later turn gave. Approval grants never travel. The store stamps "now"
 * on everything it creates, so each session ends with an import-only write
 * that puts the archived dates and totals back.
 */
import {
  CancellationReason,
  EventType,
  InMemorySessionStore,
  MAIN_THREAD_ID,
  abnormalHandoffCauseForCancellation,
  type CreatedBySubject,
  type ISessionStore,
  type SessionAgent,
  type TerminalTurnState,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { mechanicalAbnormalHandoff, newEventId } from '@truefoundry/trueforge-core/core';
import { ActionRequiredEventSchema } from '@truefoundry/trueforge-core/core/events/schema';
import { getHeapStatistics } from 'node:v8';

import { formatArchiveBytes } from '../dataExport/archiveLimits';

import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { detachConnectors } from './connectorImport';
import { DataImportError } from './importError';
import type { ImportEvent, ImportSessionEntry, ImportTurnRecord } from './importSchemas';

/** Shown in the chat for a request that was waiting on the owner when the archive was made. */
export const EXPIRED_APPROVAL_NOTICE =
  'This chat was waiting for an answer when it was exported. That request expired during the move and nothing was run.';

type ThreadSnapshot = ImportTurnRecord['snapshot']['threads'][string];
type ContextMessage = ThreadSnapshot['context'][number];

export interface SessionRestoreContext {
  tenantId: string;
  /** The importing user; every restored session is created by this subject. */
  subject: CreatedBySubject;
  /** Resolves an exported agent reference to the agent in the target instance, or undefined when there is none. */
  resolveAgent: (reference: { id: string; name: string | null }) => { id: string; name: string } | undefined;
  /** Imported connectors start unused, so a chat's own agent loses any attachment to them. */
  connectorNames: ReadonlySet<string>;
  /** Called right after a session is created, so the caller can undo exactly what it created. */
  onSessionCreated?: (sessionId: string) => void;
}

function resolveAgentBinding(
  agent: SessionAgent,
  { resolveAgent, connectorNames }: Pick<SessionRestoreContext, 'resolveAgent' | 'connectorNames'>,
): SessionAgent {
  if (agent.type === 'inline') {
    return { ...agent, spec: detachConnectors({ spec: agent.spec, names: connectorNames }) };
  }
  const resolved = resolveAgent({ id: agent.id, name: agent.name });
  return resolved === undefined ? agent : { type: 'reference', id: resolved.id, name: resolved.name };
}

/** A sessions/ archive shares unchanged messages between turns, so most compare by identity. */
function sameMessage(left: ContextMessage, right: ContextMessage): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Length of the longest common prefix of two contexts, compared message by message. */
function commonPrefixLength(previous: readonly ContextMessage[], next: readonly ContextMessage[]): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit) {
    const left = previous[index];
    const right = next[index];
    if (left === undefined || right === undefined || !sameMessage(left, right)) {
      break;
    }
    index += 1;
  }
  return index;
}

function findTurnDoneEvent(events: readonly ImportEvent[]): TurnDoneEvent | undefined {
  for (const event of events) {
    if (event.type === 'turn.done') {
      return event;
    }
  }
  return undefined;
}

function synthesizedTurnDoneEvent(state: TerminalTurnState): TurnDoneEvent {
  return {
    type: 'turn.done',
    id: newEventId(),
    created_at: state.completed_at,
    state,
    thread_id: null,
  };
}

async function restoreTurn(
  store: ISessionStore<SessionCustom, TurnCustom>,
  session: ImportSessionEntry['session'],
  entry: ImportSessionEntry['turns'][number],
  previous: { threads: ReadonlyMap<string, ThreadSnapshot>; isFirstTurn: boolean; answered: boolean },
): Promise<void> {
  const { threads: previousThreads, isFirstTurn, answered } = previous;
  const turn: ImportTurnRecord = entry.turn;
  const sessionId = session.session_id;
  const exportedThreads = new Map(Object.entries(turn.snapshot.threads));

  const newThreads: ThreadSnapshot[] = [];
  const retainedThreadIds: string[] = [];
  const appends: {
    thread_id: string;
    context: ContextMessage[];
    current_context_usage: ThreadSnapshot['current_context_usage'] | null;
  }[] = [];
  const divergentThreadIds: string[] = [];

  for (const [threadId, thread] of exportedThreads) {
    const previous = previousThreads.get(threadId);
    if (previous === undefined) {
      newThreads.push(thread);
      appends.push({
        thread_id: threadId,
        context: [...thread.context],
        current_context_usage: thread.current_context_usage,
      });
      continue;
    }
    retainedThreadIds.push(threadId);
    const prefix = commonPrefixLength(previous.context, thread.context);
    if (prefix === previous.context.length) {
      appends.push({
        thread_id: threadId,
        context: thread.context.slice(prefix),
        current_context_usage: thread.current_context_usage,
      });
    } else {
      // The context was rewritten between turns (compaction): createTurn can
      // only append, so the thread is repaired with an overwrite below.
      divergentThreadIds.push(threadId);
      appends.push({ thread_id: threadId, context: [], current_context_usage: null });
    }
  }

  await store.createTurn({
    turn: {
      turn_id: turn.turn_id,
      session_id: sessionId,
      first_turn_id: turn.first_turn_id,
      ancestor_ids: turn.ancestor_ids,
      previous_turn_id: turn.previous_turn_id,
      state: { status: 'running' },
      input: turn.input,
      custom: turn.custom,
      created_at: new Date(turn.created_at),
      updated_at: new Date(turn.updated_at),
    },
    sandbox_info: null,
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: retainedThreadIds,
    new_threads: newThreads.map(thread => ({
      thread_id: thread.thread_id,
      parent: thread.parent ?? null,
      agent_info: thread.agent_info ?? null,
      tool_call_memo: undefined,
      task_state: thread.task_state,
    })),
    new_context_appends: appends,
    capability_states: [...exportedThreads.values()].map(thread => ({
      thread_id: thread.thread_id,
      capability_state: null,
    })),
    tool_call_memos: [...exportedThreads.values()].map(thread => ({
      thread_id: thread.thread_id,
      tool_call_memo: undefined,
    })),
    task_states: [...exportedThreads.values()].map(thread => ({
      thread_id: thread.thread_id,
      task_state: thread.task_state,
    })),
    update_session_title_if_not_exist: isFirstTurn ? session.title : null,
  });

  for (const threadId of divergentThreadIds) {
    const thread = exportedThreads.get(threadId);
    if (thread === undefined) {
      continue;
    }
    await store.overwriteThreadContext({
      session_id: sessionId,
      turn_id: turn.turn_id,
      event: {
        type: EventType.AGENT_CONTEXT_OVERWRITE,
        id: newEventId(),
        created_at: turn.updated_at,
        thread_id: threadId,
        reason: 'compaction',
        context: [...thread.context],
        current_context_usage: thread.current_context_usage,
        // The store applies only the context and its usage; the event is a
        // vehicle for the write and is not itself added to the event log.
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  }

  // Threads created by this turn start with no completion marker; restore one
  // the export recorded (a subagent that finished within its first turn).
  for (const thread of newThreads) {
    if (thread.completion !== null && thread.completion !== undefined) {
      await store.appendToThreadContext({
        session_id: sessionId,
        turn_id: turn.turn_id,
        thread_id: thread.thread_id,
        context: [],
        current_context_usage: null,
        completion: thread.completion,
        tool_call_memo: undefined,
        task_state: undefined,
      });
    }
  }

  const events = entry.events;
  const streamDone = findTurnDoneEvent(events);
  // A later turn that continues this one answered its actions; only an unanswered one expired in the move.
  const expiredActions = turn.state.status === 'done' && !answered ? turn.state.required_actions : [];
  const holdsOutstandingAction = expiredActions.length > 0;
  // Action cards and held marks are archive-written, so none is replayed whatever the turn's state.
  const replayEvents = events.filter(
    event => event.type !== 'turn.done' && !ActionRequiredEventSchema.safeParse(event).success,
  );
  if (holdsOutstandingAction) {
    replayEvents.push({
      type: EventType.MODEL_MESSAGE,
      id: newEventId(),
      created_at: turn.updated_at,
      thread_id: expiredActions[0]?.thread_id ?? MAIN_THREAD_ID,
      content: EXPIRED_APPROVAL_NOTICE,
    });
  }
  if (replayEvents.length > 0) {
    await store.appendToEvents({ session_id: sessionId, turn_id: turn.turn_id, events: replayEvents });
  }

  if (turn.state.status === 'running' || holdsOutstandingAction) {
    const completedAt = turn.updated_at;
    const state: TerminalTurnState = {
      status: 'cancelled',
      reason: CancellationReason.Abandoned,
      completed_at: completedAt,
      handoff: mechanicalAbnormalHandoff({
        cause: abnormalHandoffCauseForCancellation(CancellationReason.Abandoned),
        repository: undefined,
      }),
    };
    await store.freezeAndGetTurn({
      session_id: sessionId,
      turn_id: turn.turn_id,
      reason: CancellationReason.Abandoned,
      turn_done_event: { ...synthesizedTurnDoneEvent(state), created_at: completedAt },
    });
    return;
  }

  const state: TerminalTurnState = turn.state;
  const doneEvent = streamDone?.state.status === state.status ? streamDone : synthesizedTurnDoneEvent(state);
  await store.updateTurnState({ session_id: sessionId, turn_id: turn.turn_id, state, turn_done_event: doneEvent });
}

type TurnEntry = ImportSessionEntry['turns'][number];

/**
 * The earlier turn of the chat that a turn continues, which the store builds it on. A turn without
 * one is a root: the chat's first turn, or the new first turn after its first message was edited.
 */
function baseTurn(
  turns: readonly TurnEntry[],
  { index, indexById }: { index: number; indexById: ReadonlyMap<string, number> },
): TurnEntry | undefined {
  const baseId = turns[index]?.turn.previous_turn_id ?? null;
  const baseIndex = baseId === null ? undefined : indexById.get(baseId);
  return baseIndex !== undefined && baseIndex < index ? turns[baseIndex] : undefined;
}

function threadsOf(turn: TurnEntry | undefined): Map<string, ThreadSnapshot> {
  return new Map(turn === undefined ? [] : Object.entries(turn.turn.snapshot.threads));
}

function turnIndexById(turns: readonly TurnEntry[]): Map<string, number> {
  return new Map(turns.map(({ turn }, index) => [turn.turn_id, index]));
}

async function createRestoredSession(
  store: ISessionStore<SessionCustom, TurnCustom>,
  context: SessionRestoreContext,
  session: ImportSessionEntry['session'],
): Promise<void> {
  await store.createSession({
    tenant_id: context.tenantId,
    session_id: session.session_id,
    created_by_subject: context.subject,
    agent: resolveAgentBinding(session.agent, context),
    external_id: session.external_id,
    metadata: session.metadata,
    source: session.source,
    custom: null,
  });
  context.onSessionCreated?.(session.session_id);
  if (session.folder_id !== null) {
    await store.setSessionFolder({
      tenant_id: context.tenantId,
      session_id: session.session_id,
      created_by: context.subject.subject_id,
      folder_id: session.folder_id,
    });
  }
}

/** The title of a chat without turns, its checklist, and the archived dates and totals of the chat and `turns`. */
async function finishRestoredSession(
  store: ISessionStore<SessionCustom, TurnCustom>,
  context: SessionRestoreContext,
  { entry, turns }: { entry: ImportSessionEntry; turns: readonly TurnEntry[] },
): Promise<void> {
  const session = entry.session;
  if (entry.turns.length === 0 && session.title !== null) {
    await store.updateSession({
      tenant_id: context.tenantId,
      session_id: session.session_id,
      agent: undefined,
      title: session.title,
      metadata: undefined,
    });
  }

  const checklist = session.task_checklist;
  if (checklist.items.length > 0 || checklist.revision > 0) {
    const current = await store.getTaskChecklist({ tenant_id: context.tenantId, session_id: session.session_id });
    await store.replaceTaskChecklist({
      tenant_id: context.tenantId,
      session_id: session.session_id,
      expected_revision: current.revision,
      items: checklist.items,
    });
  }

  await store.stampImportedSession({
    tenant_id: context.tenantId,
    session_id: session.session_id,
    created_at: new Date(session.created_at),
    updated_at: new Date(session.updated_at),
    last_activity_timestamp_ms: session.last_activity_timestamp_ms,
    metrics: session.metrics,
    turns: turns.map(({ turn }) => ({
      turn_id: turn.turn_id,
      created_at: new Date(turn.created_at),
      updated_at: new Date(turn.updated_at),
    })),
  });
}

/**
 * Restores every exported session, in export order. Folders must already
 * exist in the store; artifacts are restored separately by the caller.
 */
export async function restoreSessions(
  store: ISessionStore<SessionCustom, TurnCustom>,
  context: SessionRestoreContext,
  sessions: Iterable<ImportSessionEntry>,
): Promise<void> {
  for (const entry of sessions) {
    const session = entry.session;
    await createRestoredSession(store, context, session);
    const continuedTurnIds = new Set(entry.turns.map(({ turn }) => turn.previous_turn_id));
    const indexById = turnIndexById(entry.turns);
    for (const [index, turnEntry] of entry.turns.entries()) {
      await restoreTurn(store, session, turnEntry, {
        threads: threadsOf(baseTurn(entry.turns, { index, indexById })),
        isFirstTurn: index === 0,
        answered: continuedTurnIds.has(turnEntry.turn.turn_id),
      });
    }
    await finishRestoredSession(store, context, { entry, turns: entry.turns });
  }
}

/** Below V8's own heap limit, which would end the process without saying which chat was too large. */
const REPLAY_HEAP_STOP_FRACTION = 0.9;

function assertHeapRoom(sessionId: string): void {
  const { used_heap_size: used, heap_size_limit: limit } = getHeapStatistics();
  if (used > REPLAY_HEAP_STOP_FRACTION * limit) {
    throw new DataImportError(
      `Chat ${sessionId} is too large to import with the memory Aman has here (${formatArchiveBytes(used)} of ${formatArchiveBytes(limit)} in use), so nothing was imported. Give Docker more memory, then run the import again.`,
      500,
    );
  }
}

/**
 * The dry run of restoreSessions, which proves every chat lands before anything is written. An
 * in-memory store keeps a full copy of every turn's snapshot, so a long chat replayed in one
 * store grows with the square of its turns. Each turn lands instead in a fresh store that holds
 * only the chat, the turn it continues (rebuilt alone first) and itself.
 */
export async function replaySessions(
  context: SessionRestoreContext,
  { sessions, folderNames }: { sessions: Iterable<ImportSessionEntry>; folderNames: ReadonlyMap<string, string> },
): Promise<void> {
  const openChat = async (session: ImportSessionEntry['session']) => {
    const store = new InMemorySessionStore<SessionCustom, TurnCustom>();
    const folderName = session.folder_id === null ? undefined : folderNames.get(session.folder_id);
    if (session.folder_id !== null && folderName !== undefined) {
      await store.createSessionFolder({
        tenant_id: context.tenantId,
        folder_id: session.folder_id,
        created_by: context.subject.subject_id,
        name: folderName,
      });
    }
    await createRestoredSession(store, context, session);
    return store;
  };

  for (const entry of sessions) {
    const session = entry.session;
    try {
      const indexById = turnIndexById(entry.turns);
      const continuedTurnIds = new Set(entry.turns.map(({ turn }) => turn.previous_turn_id));
      let store: ISessionStore<SessionCustom, TurnCustom> | undefined;
      let landed: TurnEntry[] = [];
      for (const [index, turnEntry] of entry.turns.entries()) {
        assertHeapRoom(session.session_id);
        store = await openChat(session);
        landed = [];
        const base = baseTurn(entry.turns, { index, indexById });
        if (base !== undefined) {
          // Every thread of the base is new to this store, so it lands with its whole context.
          await restoreTurn(store, session, base, { threads: new Map(), isFirstTurn: false, answered: true });
          landed.push(base);
        }
        await restoreTurn(store, session, turnEntry, {
          threads: threadsOf(base),
          isFirstTurn: index === 0,
          answered: continuedTurnIds.has(turnEntry.turn.turn_id),
        });
        landed.push(turnEntry);
      }
      await finishRestoredSession(store ?? (await openChat(session)), context, { entry, turns: landed });
    } catch (cause) {
      if (cause instanceof DataImportError) {
        throw cause;
      }
      const message = cause instanceof Error ? cause.message.trim() : '';
      const reason = message === '' ? 'An unexpected error.' : /[.!?]$/.test(message) ? message : `${message}.`;
      throw new DataImportError(
        `Chat ${session.session_id} in this export could not be read back: ${reason} Nothing was imported.`,
        400,
        { cause },
      );
    }
  }
}
