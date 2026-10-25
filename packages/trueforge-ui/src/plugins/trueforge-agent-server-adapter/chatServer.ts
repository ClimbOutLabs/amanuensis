/**
 * Harness `AgentChatServer` adapter for @truefoundry/trueforge-ui.
 *
 * Runtime contract: opaque mounts (`object`), flat `ListResult` (`data` +
 * `nextPageToken`), and `null` normalized to absent. Harness keys MCP mounts by
 * name and returns `null` for optional fields — the maps below bridge both.
 *
 * Skills are name (+ optional preload) refs on the wire (`Skill`).
 *
 * Session create takes `{ name }` or `{ spec }`; reads carry the
 * `reference`/`inline` discriminator, with reference rows already naming their
 * agent. The UI filters with registry `agentId`.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { readSessionAgentDetails, type AgentDetailsVisibility } from '../../atoms/lib/sessionAgentDetails.js';
import { readSessionIsCreateAgent } from '../../atoms/lib/sessionCreateAgent.js';
import type { MemoryTurnContext } from '../../components/MemoryRecallContext.js';
import type { ModelUsageTurnContext } from '../../components/ModelUsageContext.js';
import { applyHeldPersona, awaitPendingPersonaMutation } from '../../personaMutationGate.js';
import { publishSentinelEvent } from '../../sentinel/sentinelEvents.js';
import { extractSentinelFromEvent } from '../../sentinel/types.js';
import type {
  AgentChatServer,
  CreateSessionRequest,
  ListResult,
  Session,
  SessionEventItem,
  Turn,
  TurnInputItem,
  TurnStreamingEvent,
  UpdateSessionRequest,
  UserMessageContent,
} from '../../server/types.js';
import { publishContextCompaction } from '../../utils/contextCompactionLive.js';
import { LiveConnectionLostError, ReplyStoppedByRestartError } from '../../utils/liveConnection.js';
import type { ModelUsageEvent } from '../../utils/modelUsage.js';
import { createTrueForgeClient, type CreateTrueForgeClientOptions } from './client.js';
import { createSessionResyncExtensions, type HarnessChatServerExtensions } from './sessionResync.js';
import {
  isCompatibleSessionEvent,
  isCompatibleStreamingEvent,
  toUiSessionEvent,
  toUiTurnState,
  toUiStreamingEvent as toUiVendorStreamingEvent,
} from './toUiTurnState.js';
import type { HarnessAgentSpec, HarnessMcpServerMount, HarnessSkillMount } from './types.js';

export type { HarnessAgentSpec, HarnessMcpServerMount, HarnessSkillMount } from './types.js';
export type CreateHarnessChatServerOptions = CreateTrueForgeClientOptions & {
  /** Injected client — skips creating one from options. */
  client?: TrueForge;
};

/**
 * The browser's IANA timezone, read once per call so a clock change or DST transition between
 * turns is picked up. `Intl.DateTimeFormat` is universally available in supported browsers, but
 * `resolvedOptions().timeZone` can still throw in a locked-down or non-browser environment
 * (e.g. some test runners); undefined then lets the server fall back to UTC, same as an
 * omitted field.
 */
function resolveClientTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function causedByAbort(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('name' in current && current.name === 'AbortError') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function rethrowStreamFailure(error: unknown, abortSignal: AbortSignal | undefined): never {
  if (abortSignal?.aborted === true && causedByAbort(error)) {
    const normalized = new Error('Browser stream detached', { cause: error });
    normalized.name = 'AbortError';
    throw normalized;
  }
  throw error;
}

/**
 * A caller-driven cancel (the runtime's own `abortSignal` firing) must abort
 * immediately and never reconnect; a transport drop (tab suspension, a
 * network change, a closed body stream) must not surface as a turn failure.
 * This tells the two apart: only the former has the caller's signal already
 * aborted at the moment the underlying fetch rejected with an abort-shaped
 * error.
 */
function isDeliberateAbort(error: unknown, abortSignal: AbortSignal | undefined): boolean {
  return abortSignal?.aborted === true && causedByAbort(error);
}

/**
 * The server has forgotten the turn (e.g. it expired) — reconnecting cannot help.
 * Note: the SDK's internal reconnect can hide a mid-stream 404, so exhaustion of
 * attempts is the practical end for a gone turn.
 */
function isTurnGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? error.name : undefined;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  return name === 'NotFoundError' || statusCode === 404;
}

/**
 * The turn exists but its live event stream is permanently gone (HTTP 412
 * `STREAM_GONE`): the turn completed past the post-completion TTL, or a server
 * restart wiped the in-memory stream store. Unlike a transport drop, retrying
 * the subscribe can never succeed — the caller must fall back to REST.
 */
function isStreamGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  if (statusCode === 412) return true;
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && message.includes('stream does not exist anymore');
}

/** Bounds how many consecutive transport drops a turn stream will reconnect through. */
const TURN_STREAM_RECONNECT_MAX_ATTEMPTS = 5;
const TURN_STREAM_RECONNECT_BASE_DELAY_MS = 500;
const TURN_STREAM_RECONNECT_MAX_DELAY_MS = 8_000;

function reconnectDelayMs(attempt: number): number {
  const delayMs = TURN_STREAM_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(delayMs, TURN_STREAM_RECONNECT_MAX_DELAY_MS);
}

/** Abortable sleep: resolves early (without rejecting) if `abortSignal` fires. */
function delay(ms: number, abortSignal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (abortSignal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** UI session with create-agent intent for resume chrome and the chat-level agent-details preference. */
export type HarnessUiSession = Session<HarnessAgentSpec> & {
  isCreateAgent: boolean;
  /** "Agent details" preference (session metadata `agent_details`); undefined = unset. */
  agentDetails?: AgentDetailsVisibility;
  /** The session's metadata, so a write that replaces it can keep every key it does not change. */
  metadata: Record<string, string>;
};

export type HarnessCreateSessionRequest = CreateSessionRequest<HarnessAgentSpec> & {
  metadata?: Record<string, string>;
};

function toUiMcpServer(server: TrueForgeApi.McpServer): HarnessMcpServerMount {
  return server;
}

function toUiSkill(skill: TrueForgeApi.Skill): HarnessSkillMount {
  return { name: skill.name, preload: skill.preload === true };
}

function toHarnessSkill(skill: HarnessSkillMount): TrueForgeApi.Skill {
  // Picker `id` is AvailableSkill.name (attach key); `name` is display — see builder getSkills.
  return { name: skill.id ?? skill.name, preload: skill.preload === true };
}

/** Drop UI draft `id` before admission; Harness MCP mounts are name-keyed. */
export function toHarnessAgentSpec(spec: HarnessAgentSpec): TrueForgeApi.AgentSpec {
  const { skills, mcpServers, config, ...rest } = spec;
  // The harness leaves sandbox.enabled optional; the wire schema requires it, so
  // normalize an unset enabled to false (sandbox off) rather than dropping the key.
  const { sandbox, ...restConfig } = config ?? {};
  const wireConfig: TrueForgeApi.RuntimeConfig | undefined =
    config === undefined
      ? undefined
      : {
          ...restConfig,
          ...(sandbox === undefined ? {} : { sandbox: { ...sandbox, enabled: sandbox.enabled ?? false } }),
        };
  return {
    ...rest,
    ...(wireConfig === undefined ? {} : { config: wireConfig }),
    ...(mcpServers === undefined
      ? {}
      : {
          mcpServers: mcpServers.map(server => {
            // Draft picker may round-trip mounts as `{ id, name, ... }`; strip UI-only `id`.
            if ('id' in server) {
              const { id, ...mount } = server;
              void id;
              return mount;
            }
            return server;
          }),
        }),
    ...(skills === undefined ? {} : { skills: skills.map(toHarnessSkill) }),
  };
}

export function toUiAgentSpec(spec: TrueForgeApi.AgentSpec): HarnessAgentSpec {
  const { mcpServers, skills, config, ...rest } = spec;
  return {
    ...rest,
    ...(config === undefined ? {} : { config }),
    ...(mcpServers ? { mcpServers: mcpServers.map(toUiMcpServer) } : {}),
    ...(skills ? { skills: skills.map(toUiSkill) } : {}),
  };
}

function toUiSession(session: TrueForgeApi.Session): HarnessUiSession {
  const agentDetails = readSessionAgentDetails(session.metadata);
  return {
    id: session.id,
    isMutable: session.agent.type === 'inline',
    isCreateAgent: readSessionIsCreateAgent(session.metadata),
    metadata: { ...session.metadata },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title === null ? {} : { title: session.title }),
    // `name` is a create-time snapshot, so references whose agent predates it stay
    // unlabelled; `isMutable` alone keeps them out of the composer.
    ...(session.agent.type === 'reference' && session.agent.name !== null ? { agentName: session.agent.name } : {}),
    ...(session.agent.type === 'inline' ? { agentSpec: toUiAgentSpec(session.agent.spec) } : {}),
    ...(agentDetails === undefined ? {} : { agentDetails }),
  };
}

function createSessionMetadata(request: HarnessCreateSessionRequest): Record<string, string> | undefined {
  if (request.metadata === undefined) return undefined;
  return request.metadata;
}

/** Spread drops the interface identity, which is what makes the SDK's index-signature part type accept it. */
function toUiContent(content: TrueForgeApi.UserMessageContent): UserMessageContent {
  return typeof content === 'string' ? content : content.map(part => ({ ...part }));
}

function toUiInput(input: TrueForgeApi.TurnInputItem[]): TurnInputItem[] {
  return input.map(item => (item.type === 'user.message' ? { ...item, content: toUiContent(item.content) } : item));
}

function toUiTurn(turn: TrueForgeApi.Turn): Turn {
  const { previousTurnId, input, state, ...rest } = turn;
  return {
    ...rest,
    state: toUiTurnState(state),
    ...(previousTurnId === null ? {} : { previousTurnId }),
    ...(input === undefined ? {} : { input: toUiInput(input) }),
  };
}

function toUiEventItem(item: TrueForgeApi.SessionEventItem): SessionEventItem | undefined {
  // Filter vendor-incompatible passthrough events via the type guard. The vendor union omits
  // `aman.skill.used` (host skill-telemetry) even though it arrives at runtime; the guard
  // narrows soundly. See `listMemoryTurnContext` below for the durable read path.
  if (!isCompatibleSessionEvent(item.event)) return undefined;
  return { turnId: item.turnId, event: toUiSessionEvent(item.event) };
}

function toUiStreamingEvent(event: TrueForgeApi.TurnStreamingEvent): TurnStreamingEvent | undefined {
  // Filter vendor-incompatible passthrough events via the type guard — the vendor union omits
  // `aman.skill.used` even though it arrives at runtime. `createTurn`/`subscribeToTurn` below
  // tap `document.ingestion` directly off the raw stream item before this narrows it away.
  if (!isCompatibleStreamingEvent(event)) return undefined;
  return toUiVendorStreamingEvent(event);
}

/**
 * One turn's host-injected memory recall and/or learned-profile write, if either happened.
 * Canonically declared on `MemoryRecallContext` (the public `MemoryRecallApi` contract this
 * function backs); re-exported here — as a type-only import, erased at build time, so this
 * plugin stays free of any runtime dependency on the component tree — so callers of this plugin
 * do not also need to import from the component module directly.
 */
export type { MemoryTurnContext, ModelUsageTurnContext };

/** The event types `listMemoryTurnContext` reads; the server filters to them so a poll stays small. */
const MEMORY_TURN_CONTEXT_EVENT_TYPES = ['aman.memory.recall', 'aman.profile.learned'];

/**
 * Reads every `aman.memory.recall` / `aman.profile.learned` event this session has recorded, one
 * entry per turn that has either, so the UI can render byte-for-byte what the model received
 * (SPEC.md I5) durably — after the turn completes and after a page reload — without threading
 * these types through the vendor chat pipeline (see the comments on `toUiEventItem` /
 * `toUiStreamingEvent` above for why that pipeline cannot carry them).
 *
 * Calls `client.sessions.listEvents` directly: the SDK's own event union already includes both
 * passthrough events with full fidelity (`injected_block`, `stats`, `screen`, `previous`/
 * `current`/`revision`); only the vendor-typed wrapper above narrows them away. The server filters
 * to those two types, and with `afterEventId` to events newer than it, so a steady-state poll
 * returns no rows. The generated client predates both query parameters, so they ride along as
 * request query params.
 *
 * Walks every page (newest turn first, oldest last) rather than stopping early: this is the
 * durable audit read backing SPEC.md I5, so it must not silently drop older turns' recorded
 * context just because a session has grown long — every turn a reloaded transcript can still show
 * must be able to show its recall/profile card too.
 */
export async function listMemoryTurnContext(
  client: TrueForge,
  { sessionId, afterEventId }: { sessionId: string; afterEventId?: string | undefined },
): Promise<MemoryTurnContext[]> {
  const byTurn = new Map<string, MemoryTurnContext>();
  const page = await client.sessions.listEvents(
    sessionId,
    { limit: 100 },
    {
      queryParams: {
        types: MEMORY_TURN_CONTEXT_EVENT_TYPES,
        ...(afterEventId === undefined ? {} : { after_event_id: afterEventId }),
      },
    },
  );
  for await (const item of page) {
    if (item.event.type !== 'aman.memory.recall' && item.event.type !== 'aman.profile.learned') continue;
    const existing = byTurn.get(item.turnId) ?? { turnId: item.turnId };
    byTurn.set(
      item.turnId,
      item.event.type === 'aman.memory.recall'
        ? { ...existing, recall: item.event }
        : { ...existing, profile: item.event },
    );
  }
  return [...byTurn.values()];
}

/**
 * Every `aman.model.usage` event this session has recorded, grouped by turn, so the UI can show
 * which model did the work under each answer and what it cost. Like `listMemoryTurnContext`, a
 * direct `client.sessions.listEvents` read: the vendor chat pipeline cannot carry the event. Walks
 * every page, so an older turn in a long session still shows its usage after a reload.
 */
export async function listModelUsageTurnContext(
  client: TrueForge,
  { sessionId }: { sessionId: string },
): Promise<ModelUsageTurnContext[]> {
  const byTurn = new Map<string, ModelUsageEvent[]>();
  const page = await client.sessions.listEvents(sessionId, { limit: 100 });
  for await (const item of page) {
    if (item.event.type !== 'aman.model.usage') continue;
    byTurn.set(item.turnId, [...(byTurn.get(item.turnId) ?? []), item.event]);
  }
  return [...byTurn.entries()].map(([turnId, events]) => ({ turnId, events }));
}

/**
 * Latest known lifecycle phase for one attached file this turn ingested, by the name the client
 * uploaded (see `toUiEventItem` / `toUiStreamingEvent` above for why `document.ingestion` cannot
 * reach the UI through the vendor-typed event pipeline instead).
 */
export type DocumentIngestionFileStatus = {
  fileName: string;
  phase: TrueForgeApi.DocumentIngestionEventPhase;
};

export type DocumentIngestionTurnContext = {
  turnId: string;
  files: DocumentIngestionFileStatus[];
};

export type DocumentIngestionLiveEvent = {
  turnId: string;
  fileName: string;
  phase: TrueForgeApi.DocumentIngestionEventPhase;
};

type DocumentIngestionListener = (event: DocumentIngestionLiveEvent) => void;

const documentIngestionListeners = new Set<DocumentIngestionListener>();

/**
 * Push-only, in-memory fan-out of `document.ingestion` events as `createTurn`/`subscribeToTurn`
 * below observe them on the live turn SSE stream — tapped before `toUiStreamingEvent` narrows them
 * away (see that function's comment: the vendor-typed `TurnStreamingEvent` union this plugin wraps
 * has no case for this event type, so it cannot be forwarded through the normal chat pipeline).
 * `DocumentIngestionStatusProvider` subscribes to this instead of polling: each `started`/terminal
 * event is pushed to every subscriber the instant it arrives on the stream, so the status line
 * updates live with no interval timer. `listDocumentIngestionTurnContext` above remains the durable
 * read a reloaded session uses to rebuild history; this is the live-only complement to it.
 */
export function subscribeToDocumentIngestion(listener: DocumentIngestionListener): () => void {
  documentIngestionListeners.add(listener);
  return () => {
    documentIngestionListeners.delete(listener);
  };
}

function publishDocumentIngestionEvent(turnId: string, event: TrueForgeApi.DocumentIngestionEvent): void {
  const live: DocumentIngestionLiveEvent = { turnId, fileName: event.fileName, phase: event.phase };
  for (const listener of documentIngestionListeners) {
    listener(live);
  }
}

/**
 * Taps Sentinel approval events off a raw stream or history item before the vendor
 * conversion narrows it away: the vendor event unions have no case for
 * `tool.approval_required`, so it cannot travel the normal chat pipeline. The SDK parser
 * passes unknown event types and fields through, so `extractSentinelFromEvent` parses the
 * raw item defensively. Published per tool call; `SentinelStateProvider` subscribes.
 */
function tapSentinelStreamEvent(data: TrueForgeApi.TurnStreamingEvent | TrueForgeApi.SessionEvent): void {
  for (const info of extractSentinelFromEvent(data)) publishSentinelEvent(info);
}

/**
 * Taps the compaction start and end off a raw stream item, before the vendor conversion narrows
 * them away. The chat stops being "compacting" when compaction ends, the reply starts, or the
 * turn ends, so a cancelled compaction that never sends its end still clears.
 */
function tapContextCompactionStreamEvent(sessionId: string, data: TrueForgeApi.TurnStreamingEvent): void {
  switch (data.type) {
    case 'agent.context.compaction_started':
      publishContextCompaction({ sessionId, active: true });
      return;
    case 'agent.context.compaction':
    case 'model.message.delta':
    case 'model.message':
    case 'turn.created':
    case 'turn.done':
      publishContextCompaction({ sessionId, active: false });
      return;
    default:
      return;
  }
}

/**
 * Every `document.ingestion` event this session has recorded, folded to one entry per file per
 * turn (the later of a file's `started`/`finished`/`failed`/`cancelled` events wins) — so a status
 * line can show which files are still being read ('started' with no later event) without the
 * caller re-deriving that from a raw event list. Mirrors `listMemoryTurnContext` above: a direct
 * `client.sessions.listEvents` read, filtered server-side to this one type, not the vendor chat
 * pipeline.
 */
export async function listDocumentIngestionTurnContext(
  client: TrueForge,
  { sessionId }: { sessionId: string },
): Promise<DocumentIngestionTurnContext[]> {
  const byTurn = new Map<string, Map<string, DocumentIngestionFileStatus>>();
  const page = await client.sessions.listEvents(
    sessionId,
    { limit: 100 },
    { queryParams: { types: ['document.ingestion'] } },
  );
  for await (const item of page) {
    if (item.event.type !== 'document.ingestion') continue;
    const byFile = byTurn.get(item.turnId) ?? new Map<string, DocumentIngestionFileStatus>();
    byFile.set(item.event.fileName, { fileName: item.event.fileName, phase: item.event.phase });
    byTurn.set(item.turnId, byFile);
  }
  return [...byTurn.entries()].map(([turnId, byFile]) => ({ turnId, files: [...byFile.values()] }));
}

export interface HarnessPageSource<T> {
  data: T[];
  response: { pagination: TrueForgeApi.TokenPagination };
}

export function toListResult<TSource, TResult>(
  page: HarnessPageSource<TSource>,
  map: (item: TSource) => TResult,
): ListResult<TResult> {
  const data = page.data.map(map);
  const token = page.response.pagination.nextPageToken;
  return {
    data,
    ...(token === undefined ? {} : { nextPageToken: token }),
  };
}

function sequenceNumber(id: string | undefined, fallback: number): number {
  if (id === undefined) return fallback;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

interface TurnStreamCursor {
  /** Sequence number of the last event this stream has processed (yielded or filtered); `undefined` before the first. */
  sequence: number | undefined;
}

type TurnStreamItem = { sequenceNumber: number; event: TurnStreamingEvent };

/**
 * Streams one connection attempt of a turn's live events via
 * `subscribeToTurn`, advancing `cursor` as it goes so a subsequent reconnect
 * resumes exactly after the last event this attempt saw — no duplicates, no
 * gaps. Ends normally on `turn.done` or when the underlying stream closes.
 * Updates `seenTurnDone.done` to track whether `turn.done` was seen.
 */
async function* subscribeTurnOnce(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  cursor: TurnStreamCursor,
  seenTurnDone: { done: boolean },
  abortSignal: AbortSignal | undefined,
): AsyncGenerator<TurnStreamItem> {
  const stream = await client.sessions.subscribeToTurn(
    sessionId,
    turnId,
    { ...(cursor.sequence === undefined ? {} : { afterSequenceNumber: cursor.sequence }) },
    abortSignal === undefined ? undefined : { abortSignal },
  );
  let fallbackSequence = cursor.sequence === undefined ? 0 : cursor.sequence + 1;
  for await (const item of stream.withMetadata()) {
    const seq = sequenceNumber(item.id, fallbackSequence);
    cursor.sequence = seq;
    fallbackSequence = seq + 1;
    if (item.data.type === 'document.ingestion') {
      publishDocumentIngestionEvent(turnId, item.data);
    }
    tapContextCompactionStreamEvent(sessionId, item.data);
    tapSentinelStreamEvent(item.data);
    if (item.data.type === 'turn.done') {
      seenTurnDone.done = true;
      return;
    }
    const event = toUiStreamingEvent(item.data);
    if (event !== undefined) {
      yield { sequenceNumber: seq, event };
    }
  }
}

/**
 * Completes a turn stream from the turn's REST state after the live stream
 * proved permanently gone (see `isStreamGoneError`). The session and event
 * stores still hold the final state, so the stream ends with a synthesized
 * `turn.done` carrying that state instead of surfacing the raw 412.
 *
 * When the record still says `running`, the turn's executor died with the
 * restart and will never complete on its own. It is cancelled, as the person
 * would, so the chat is free for the next send, and reported as a reply the
 * restart stopped rather than a hung loading state.
 */
async function* fallbackToTurnFinalState(input: {
  client: TrueForge;
  sessionId: string;
  turnId: string;
  streamGoneError: unknown;
  cursor: TurnStreamCursor;
  seenTurnDone: { done: boolean };
}): AsyncGenerator<TurnStreamItem> {
  const { client, sessionId, turnId, streamGoneError, cursor, seenTurnDone } = input;
  const response = await client.sessions.getTurn(sessionId, turnId);
  const state = response.data.state;
  if (state.status === 'running') {
    try {
      await client.sessions.cancel(sessionId);
    } catch (cancelError) {
      // A send that the server still refuses re-attaches here and tries the cancel again.
      throw new ReplyStoppedByRestartError({ cause: cancelError });
    }
    throw new ReplyStoppedByRestartError({ cause: streamGoneError });
  }
  const sequenceNumber = (cursor.sequence ?? 0) + 1;
  cursor.sequence = sequenceNumber;
  seenTurnDone.done = true;
  // A synthesized `turn.done` is vendor-compatible by construction; if the
  // guard ever rejects it the stream cannot complete honestly, so fail loud
  // instead of yielding a completion the client would contradict.
  const doneEvent = toUiStreamingEvent({
    type: 'turn.done',
    id: `synthetic-turn-done-${turnId}`,
    createdAt: new Date().toISOString(),
    threadId: null,
    state,
  });
  if (doneEvent === undefined) {
    throw new Error('The synthesized turn.done event was rejected as vendor-incompatible.', {
      cause: streamGoneError,
    });
  }
  yield { sequenceNumber, event: doneEvent };
}

/**
 * Reconnects to a turn's live stream across transport drops (a suspended
 * tab's aborted fetch, a network change, a closed body stream) so a turn
 * still running server-side never surfaces as a failed turn. Resumes from
 * `cursor` (exclusive), bounded by `TURN_STREAM_RECONNECT_MAX_ATTEMPTS` with
 * capped exponential backoff. Gives up only when the caller cancels
 * (`abortSignal`) or the server reports the turn is gone, rethrowing that
 * error unchanged. Exhausted retries throw `LiveConnectionLostError` so the
 * chat resyncs from the server rather than marking the turn failed.
 */
async function* subscribeWithReconnect(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  cursor: TurnStreamCursor,
  seenTurnDone: { done: boolean },
  abortSignal: AbortSignal | undefined,
): AsyncGenerator<TurnStreamItem> {
  let attempt = 0;
  for (;;) {
    try {
      let yieldedEvent = false;
      for await (const item of subscribeTurnOnce(client, sessionId, turnId, cursor, seenTurnDone, abortSignal)) {
        yieldedEvent = true;
        yield item;
      }
      // Reset attempt counter on progress (at least one event yielded).
      if (yieldedEvent) {
        attempt = 0;
      }
      // If the stream ended cleanly and we saw turn.done, we're done.
      if (seenTurnDone.done) {
        return;
      }
      // Clean end without turn.done: treat as a transport drop, not completion.
      // Only reconnect if the caller hasn't deliberately cancelled.
      if (abortSignal?.aborted === true) {
        return;
      }
      attempt += 1;
      if (attempt > TURN_STREAM_RECONNECT_MAX_ATTEMPTS) {
        throw new LiveConnectionLostError();
      }
      await delay(reconnectDelayMs(attempt), abortSignal);
      if (abortSignal && abortSignal.aborted) {
        return;
      }
    } catch (error) {
      if (isDeliberateAbort(error, abortSignal) || isTurnGoneError(error)) {
        throw error;
      }
      if (isStreamGoneError(error)) {
        // The stream is permanently gone (completed past the TTL, or a server
        // restart wiped it): reconnecting would 412 forever. Complete from the
        // turn's REST state instead of surfacing the raw 412.
        yield* fallbackToTurnFinalState({
          client,
          sessionId,
          turnId,
          streamGoneError: error,
          cursor,
          seenTurnDone,
        });
        return;
      }
      attempt += 1;
      if (attempt > TURN_STREAM_RECONNECT_MAX_ATTEMPTS) {
        throw new LiveConnectionLostError({ cause: error });
      }
      await delay(reconnectDelayMs(attempt), abortSignal);
      if (abortSignal && abortSignal.aborted) {
        throw error;
      }
    }
  }
}

function toHarnessContent(content: UserMessageContent): TrueForgeApi.UserMessageContent {
  if (typeof content === 'string') return content;
  return content.map(part => {
    if (part.type === 'text') return part;
    const { name, data } = part;
    if (typeof name !== 'string' || typeof data !== 'string') {
      throw new Error('File attachment must carry a string `name` and a data-URI `data`');
    }
    return { type: 'file', name, data };
  });
}

function toHarnessInput(input: TurnInputItem[]): TrueForgeApi.TurnInputItem[] {
  return input.map(item =>
    item.type === 'user.message' ? { ...item, content: toHarnessContent(item.content) } : item,
  );
}

export function createHarnessChatServer(
  options: CreateHarnessChatServerOptions = {},
): AgentChatServer<HarnessAgentSpec, HarnessUiSession, HarnessCreateSessionRequest> & HarnessChatServerExtensions {
  const client = options.client ?? createTrueForgeClient(options);
  return {
    // Foreground delta probe + pending-approval escape hatch (see sessionResync.ts).
    ...createSessionResyncExtensions(client),

    // The sandbox is resolved server-side from the turn, so `sandboxId` is accepted for parity
    // with hosts that address sandboxes directly and deliberately not forwarded.
    async downloadSandboxFile({ sessionId, turnId, path }) {
      const response = await client.sessions.downloadSandboxFile(sessionId, turnId, { path });
      return response.blob();
    },

    async createSession(request) {
      const metadata = createSessionMetadata(request);
      if (request.agentName !== undefined && request.agentName.length > 0) {
        const created = await client.sessions.create({
          agent: { name: request.agentName },
          ...(metadata === undefined ? {} : { metadata }),
        });
        return toUiSession(created.data);
      }
      if (request.agentSpec !== undefined) {
        const created = await client.sessions.create({
          agent: { spec: toHarnessAgentSpec(request.agentSpec) },
          ...(metadata === undefined ? {} : { metadata }),
        });
        return toUiSession(created.data);
      }
      throw new Error('createSession requires agentName or agentSpec');
    },

    async listSessions(request = {}) {
      const page = await client.sessions.list({
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.order === undefined ? {} : { order: request.order }),
        ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
        ...(request.agentId === undefined || request.agentId.length === 0 ? {} : { agentId: request.agentId }),
        ...(request.createdByMe === undefined ? {} : { createdByMe: request.createdByMe }),
      });
      return toListResult(page, toUiSession);
    },

    async getSession({ sessionId }) {
      const response = await client.sessions.get(sessionId);
      return toUiSession(response.data);
    },

    async deleteSession({ sessionId }) {
      await client.sessions.delete(sessionId);
    },

    async updateSession({
      sessionId,
      agentSpec,
      metadata,
      title,
    }: UpdateSessionRequest<HarnessAgentSpec> & { metadata?: Record<string, string> }) {
      // Named (reference) sessions reject agent updates server-side. `metadata` is a full
      // replace on the wire, so callers (e.g. AgentDetailsPreferenceContext) must merge it
      // with the session's existing metadata themselves before calling this.
      const request: TrueForgeApi.UpdateSessionRequest = {
        ...(agentSpec === undefined ? {} : { agent: { spec: toHarnessAgentSpec(agentSpec) } }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(title === undefined ? {} : { title }),
      };
      const response = await client.sessions.update(sessionId, request);
      return toUiSession(response.data);
    },

    async *createTurn({ sessionId, input, previousTurnId, abortSignal }) {
      // The pill's persona switch is a separate HTTP request. If the user hit
      // send while that PUT was still in flight, wait for it so the turn is
      // admitted after the new activation lands instead of answering as the
      // old persona. A pick made on a new chat before it existed lands here, before its first turn.
      await applyHeldPersona(sessionId);
      await awaitPendingPersonaMutation();
      const cursor: TurnStreamCursor = { sequence: undefined };
      const seenTurnDone = { done: false };
      let turnId: string | undefined;
      try {
        const clientTimezone = resolveClientTimezone();
        const stream = await client.sessions.createTurnStream(
          sessionId,
          {
            ...(input === undefined ? {} : { input: toHarnessInput(input) }),
            ...(previousTurnId === undefined ? {} : { previousTurnId }),
            ...(clientTimezone === undefined ? {} : { clientTimezone }),
          },
          abortSignal === undefined ? undefined : { abortSignal },
        );
        let fallbackSequence = 0;
        // This turn's id is not known until the stream itself reports it (`turn.created` is
        // always the first event), so `document.ingestion` events cannot be published for it
        // before that arrives; in practice extraction runs well after turn creation.
        for await (const item of stream.withMetadata()) {
          const seq = sequenceNumber(item.id, fallbackSequence);
          cursor.sequence = seq;
          fallbackSequence = seq + 1;
          if (item.data.type === 'turn.created') {
            turnId = item.data.turnId;
          }
          if (item.data.type === 'document.ingestion' && turnId !== undefined) {
            publishDocumentIngestionEvent(turnId, item.data);
          }
          tapContextCompactionStreamEvent(sessionId, item.data);
          tapSentinelStreamEvent(item.data);
          if (item.data.type === 'turn.done') {
            seenTurnDone.done = true;
            return;
          }
          const event = toUiStreamingEvent(item.data);
          if (event !== undefined) {
            yield { sequenceNumber: seq, event };
          }
        }
        // Clean end without turn.done after turn was created: reconnect.
        if (turnId !== undefined && !seenTurnDone.done && abortSignal?.aborted !== true) {
          try {
            yield* subscribeWithReconnect(client, sessionId, turnId, cursor, seenTurnDone, abortSignal);
            return;
          } catch (reconnectError) {
            rethrowStreamFailure(reconnectError, abortSignal);
          }
        }
      } catch (error) {
        // A turn.created event means the gateway registered the turn: from here
        // on, a transport drop (tab suspension, a network change, a closed body
        // stream) must reconnect rather than fail the turn — unless the caller
        // deliberately cancelled it.
        if (turnId !== undefined && !isDeliberateAbort(error, abortSignal)) {
          try {
            yield* subscribeWithReconnect(client, sessionId, turnId, cursor, seenTurnDone, abortSignal);
            return;
          } catch (reconnectError) {
            rethrowStreamFailure(reconnectError, abortSignal);
          }
        }
        rethrowStreamFailure(error, abortSignal);
      }
    },

    /** Resume a live turn; omitted/0 `afterSequenceNumber` replays from the start. */
    async *subscribeToTurn({ sessionId, turnId, afterSequenceNumber, abortSignal }) {
      const cursor: TurnStreamCursor = { sequence: afterSequenceNumber };
      const seenTurnDone = { done: false };
      try {
        yield* subscribeWithReconnect(client, sessionId, turnId, cursor, seenTurnDone, abortSignal);
      } catch (error) {
        rethrowStreamFailure(error, abortSignal);
      }
    },

    async cancelSession({ sessionId }) {
      await client.sessions.cancel(sessionId);
    },

    async listTurns({ sessionId, limit, pageToken }) {
      const page = await client.sessions.listTurns(sessionId, {
        ...(limit === undefined ? {} : { limit }),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      return toListResult(page, toUiTurn);
    },

    async getTurn({ sessionId, turnId }) {
      const response = await client.sessions.getTurn(sessionId, turnId);
      return toUiTurn(response.data);
    },

    async listEvents({ sessionId, pageToken, lastTurnId, limit }) {
      const page = await client.sessions.listEvents(sessionId, {
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(lastTurnId === undefined ? {} : { lastTurnId }),
        ...(limit === undefined ? {} : { limit }),
      });
      const data = page.data.flatMap(item => {
        // A chat that learns of a waiting call from history (opened mid-turn, or caught up after the
        // live stream dropped) gets its card here; the chat's one saved-card read may predate the ask.
        tapSentinelStreamEvent(item.event);
        const converted = toUiEventItem(item);
        return converted === undefined ? [] : [converted];
      });
      const token = page.response.pagination.nextPageToken;
      return {
        data,
        ...(token === undefined ? {} : { nextPageToken: token }),
      };
    },
  };
}
