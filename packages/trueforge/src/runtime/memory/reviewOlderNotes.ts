import type { ISessionStore, TurnRecordWithoutSnapshot } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import {
  entryOccurredAt,
  latestTombstonesByEntry,
  personaVaultNamespace,
  readVaultTombstones,
  reviewableNoRecordChatId,
  sanitizeNamespace,
  scanNamespaceEntries,
  vaultFilesystemNamespace,
  withoutHiddenMarkers,
  type ScannedMemoryEntry,
} from './markdownMemoryFiles';
import { createOutsideInputTracker, inputAttachesFiles } from './turnOutsideInput';

/** Most notes one request looks at, so a long history cannot make one request slow. */
export const MAX_NOTES_EXAMINED = 200;

const TURNS_PER_PAGE = 100;
const MAX_TURN_PAGES = 10;
const EVENTS_PER_PAGE = 200;
const MAX_EVENT_PAGES = 20;
/** A request stops looking at more notes after this long and hands back where it got to. */
const EXAMINE_BUDGET_MS = 15_000;

/** Why an older note cannot be marked as the person's own. */
export type ReviewRefusal = 'not_found' | 'not_reviewable' | 'edited_or_deleted' | 'chat_unavailable' | 'read_outside';

type NoteCheck = { ok: true; chatTitle: string | null } | { ok: false; reason: ReviewRefusal };

export interface ReviewScope {
  baseDir: string;
  /** Filesystem namespace of the person's own vault folder (the shared vault). */
  tenantNamespace: string;
  /** Filesystem namespace of the vault being reviewed. */
  vaultNamespace: string;
  tenantId: string;
  subjectId: string;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
}

type StoredTurn = TurnRecordWithoutSnapshot<TurnCustom>;

/** What one chat shows, read once per request. Undefined means the chat is gone, is not this person's, or cannot be read. */
interface ChatFacts {
  title: string | null;
  turns: ReadonlyMap<string, StoredTurn>;
}

async function readChat({
  scope,
  sessionId,
}: {
  scope: ReviewScope;
  sessionId: string;
}): Promise<ChatFacts | undefined> {
  try {
    const session = await scope.sessionStore.getSession({ tenant_id: scope.tenantId, session_id: sessionId });
    if (session?.created_by_subject.subject_id !== scope.subjectId) {
      return undefined;
    }
    const turns = new Map<string, StoredTurn>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_TURN_PAGES; page++) {
      const listed = await scope.sessionStore.listTurns({
        session_id: sessionId,
        limit: TURNS_PER_PAGE,
        page_token: pageToken,
      });
      for (const turn of listed.data) {
        turns.set(turn.turn_id, turn);
      }
      pageToken = listed.pagination.next_page_token;
      if (pageToken === undefined) {
        return { title: session.title, turns };
      }
    }
    // A chat too long to read in full cannot be shown to have read nothing from outside.
    return undefined;
  } catch {
    return undefined;
  }
}

/** The turn that finished at the instant the note was saved, when exactly one did. */
function savingTurn({ chat, savedAt }: { chat: ChatFacts; savedAt: number }): StoredTurn | undefined {
  const matches = [...chat.turns.values()].filter(
    turn => turn.state.status === 'done' && new Date(turn.state.completed_at).getTime() === savedAt,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** The turn and each turn before it in the chat, or undefined when the chain cannot be followed to its start. */
function turnsUpTo({ chat, last }: { chat: ChatFacts; last: StoredTurn }): StoredTurn[] | undefined {
  const chain: StoredTurn[] = [];
  const seen = new Set<string>();
  for (let turn: StoredTurn | undefined = last; turn !== undefined;) {
    if (seen.has(turn.turn_id)) {
      return undefined;
    }
    seen.add(turn.turn_id);
    chain.push(turn);
    if (turn.previous_turn_id === null) {
      return chain;
    }
    turn = chat.turns.get(turn.previous_turn_id);
  }
  return undefined;
}

/** True or false when the turns up to and including `last` did or did not read from outside; undefined when that cannot be told. */
async function readOutsideUpTo({
  scope,
  sessionId,
  chain,
}: {
  scope: ReviewScope;
  sessionId: string;
  chain: readonly StoredTurn[];
}): Promise<boolean | undefined> {
  if (chain.some(turn => inputAttachesFiles(turn.input))) {
    return true;
  }
  const last = chain[0];
  if (last === undefined) {
    return undefined;
  }
  try {
    const events = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const listed = await scope.sessionStore.listSessionEvents({
        session_id: sessionId,
        limit: EVENTS_PER_PAGE,
        page_token: pageToken,
        last_turn_id: last.turn_id,
        types: [EventType.MODEL_MESSAGE, EventType.TOOL_RESPONSE, EventType.TOOL_RESPONSE_V2],
        after_event_id: undefined,
      });
      events.push(...listed.data.map(item => item.event));
      pageToken = listed.pagination.next_page_token;
      if (pageToken === undefined) {
        const tracker = createOutsideInputTracker({ attachedFiles: false });
        for (const event of events.sort((a, b) => a.id.localeCompare(b.id))) {
          tracker.observe(event);
        }
        return tracker.ingested;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The vault a turn saved its notes into: its persona's vault, else the shared vault. */
function turnVaultNamespace({ scope, turn }: { scope: ReviewScope; turn: StoredTurn }): string {
  const persona = turn.custom?.persona;
  return persona === undefined || persona === null
    ? scope.tenantNamespace
    : sanitizeNamespace(vaultFilesystemNamespace(scope.tenantNamespace, personaVaultNamespace(persona.persona_name)));
}

/** Chats read once per request, and the answer for each turn that saved a note. */
interface RequestCache {
  chats: Map<string, Promise<ChatFacts | undefined>>;
  turnAnswers: Map<string, Promise<boolean | undefined>>;
}

function newCache(): RequestCache {
  return { chats: new Map(), turnAnswers: new Map() };
}

/**
 * The one check behind both the list and the apply: whether this note, as a note a turn saved with no
 * record of its source, can be shown to come from a chat where Aman read nothing from outside. Any check
 * that cannot be made refuses the note.
 */
async function checkNote({
  scope,
  entry,
  touched,
  cache,
}: {
  scope: ReviewScope;
  entry: ScannedMemoryEntry;
  touched: ReadonlySet<string>;
  cache: RequestCache;
}): Promise<NoteCheck> {
  if (touched.has(entry.id)) {
    return { ok: false, reason: 'edited_or_deleted' };
  }
  const sessionId = reviewableNoRecordChatId(entry.text);
  const occurredAt = entryOccurredAt(entry);
  if (sessionId === undefined) {
    return { ok: false, reason: 'not_reviewable' };
  }
  // A day with no time in the heading cannot name the turn that saved the note.
  const savedAt = occurredAt !== undefined && occurredAt.length > 10 ? new Date(occurredAt).getTime() : Number.NaN;
  let chatRead = cache.chats.get(sessionId);
  if (chatRead === undefined) {
    chatRead = readChat({ scope, sessionId });
    cache.chats.set(sessionId, chatRead);
  }
  const chat = await chatRead;
  const saver = chat === undefined || Number.isNaN(savedAt) ? undefined : savingTurn({ chat, savedAt });
  if (
    chat === undefined ||
    saver === undefined ||
    turnVaultNamespace({ scope, turn: saver }) !== scope.vaultNamespace
  ) {
    return { ok: false, reason: 'chat_unavailable' };
  }
  const key = `${sessionId}\n${saver.turn_id}`;
  let answer = cache.turnAnswers.get(key);
  if (answer === undefined) {
    const chain = turnsUpTo({ chat, last: saver });
    answer = chain === undefined ? Promise.resolve(undefined) : readOutsideUpTo({ scope, sessionId, chain });
    cache.turnAnswers.set(key, answer);
  }
  const readOutside = await answer;
  if (readOutside === undefined) {
    return { ok: false, reason: 'chat_unavailable' };
  }
  return readOutside ? { ok: false, reason: 'read_outside' } : { ok: true, chatTitle: chat.title };
}

async function vaultState(scope: ReviewScope): Promise<{ entries: ScannedMemoryEntry[]; touched: Set<string> }> {
  const scan = await scanNamespaceEntries({
    baseDir: scope.baseDir,
    namespace: scope.vaultNamespace,
    maxDailyFiles: Number.POSITIVE_INFINITY,
  });
  const markers = await readVaultTombstones({ baseDir: scope.baseDir, namespace: scope.vaultNamespace });
  return { entries: scan.entries, touched: new Set(latestTombstonesByEntry(markers).keys()) };
}

export interface ReviewCandidate {
  entryId: string;
  day: string;
  /** The text the Memories page shows. */
  text: string;
  chatTitle: string | null;
}

/**
 * Older notes the person may mark as their own, newest first, found fresh on every call. A request looks at
 * at most `MAX_NOTES_EXAMINED` notes that close with "no record" and stops sooner when its time budget runs
 * out; `nextCursor` says where the next request starts, or is null when every such note has been looked at.
 */
export async function findReviewCandidates({
  scope,
  cursor,
  now,
}: {
  scope: ReviewScope;
  cursor: number;
  now: () => number;
}): Promise<{ candidates: ReviewCandidate[]; nextCursor: number | null }> {
  const { entries, touched } = await vaultState(scope);
  const open = entries.filter(entry => !touched.has(entry.id) && reviewableNoRecordChatId(entry.text) !== undefined);
  const cache = newCache();
  const started = now();
  const candidates: ReviewCandidate[] = [];
  let examined = 0;
  for (const entry of open.slice(cursor, cursor + MAX_NOTES_EXAMINED)) {
    if (examined > 0 && now() - started > EXAMINE_BUDGET_MS) {
      break;
    }
    examined += 1;
    const check = await checkNote({ scope, entry, touched, cache });
    if (check.ok) {
      candidates.push({
        entryId: entry.id,
        day: entry.file.replace(/\.md$/, ''),
        text: withoutHiddenMarkers(entry.text),
        chatTitle: check.chatTitle,
      });
    }
  }
  const next = cursor + examined;
  return { candidates, nextCursor: next < open.length ? next : null };
}

/** Runs the full check again for each id, so only a note that is a candidate right now is let through. */
export async function checkReviewIds({
  scope,
  entryIds,
}: {
  scope: ReviewScope;
  entryIds: readonly string[];
}): Promise<{ allowed: string[]; refused: { entryId: string; reason: ReviewRefusal }[] }> {
  const { entries, touched } = await vaultState(scope);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const cache = newCache();
  const allowed: string[] = [];
  const refused: { entryId: string; reason: ReviewRefusal }[] = [];
  for (const entryId of new Set(entryIds)) {
    const entry = byId.get(entryId);
    if (entry === undefined) {
      refused.push({ entryId, reason: 'not_found' });
      continue;
    }
    const check = await checkNote({ scope, entry, touched, cache });
    if (check.ok) {
      allowed.push(entryId);
    } else {
      refused.push({ entryId, reason: check.reason });
    }
  }
  return { allowed, refused };
}
