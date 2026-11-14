/**
 * Builds and submits the retain call for one completed turn's exchange.
 *
 * The host is the only writer (design invariant 4): every retain submission uses a
 * deterministic operation id derived from `(session_id, turn_id)`, so submitting the same
 * exchange twice (the drain hook's own submission, and the capability's reliability-loop
 * resubmission for a vanished operation) is a no-op on the memory provider's side.
 */
import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields, type ILLM } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import configuration from '../../config';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import { readMemoryPageSortingSetting } from '../memoryPageSortingSettings';
import type { TurnModelUsage } from '../modelUsage';
import { sessionKeepsNothing } from '../privateChat';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import { withoutAbilityNotes } from './assistantAbilityNotes';
import { appendHandledNote } from './handledNotes';
import { localDay } from './localDay';
import { normalizedEntryBody, SESSION_ID_METADATA_KEY } from './markdownMemoryFiles';
import type { MemoryClient, RetainItem, WrittenEntry } from './memoryClient';
import { isOperationCompletedStatus, isOperationFailedStatus } from './memoryClient';
import {
  ASSISTANT_RESPONSE_SOURCE,
  labeledNoteText,
  NOTE_DATE_METADATA_KEY,
  NOTE_SOURCE_METADATA_KEY,
  noteLabel,
  noteRetainContent,
  REPLY_READ_NOTHING_METADATA_KEY,
  type MemoryNoteSource,
} from './memoryNotes';
import { summarizeTurnNotes, type TurnToolResult } from './memoryNotesSummarize';
import {
  MEMORY_ORIGIN_METADATA_KEY,
  TOOL_INGESTED_ORIGIN,
  USER_STATED_ORIGIN,
  type AmanMemoryOrigin,
} from './memoryOrigin';
import {
  summarizeTurnContent,
  usablePersonName,
  type ProfileLineSuggestion,
  type SummaryFallbackReason,
} from './memorySummarize';
import { sortWrittenNotes } from './pageSortRun';
import { uuidv5 } from './uuidv5';

/** Fixed namespace for every operation id this host mints, in the style of RFC 4122's example namespaces. */
export const AMAN_MEMORY_NAMESPACE = 'b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b';

/** Deterministic retain operation id for one turn's exchange. */
export function retainOperationId(params: { sessionId: string; turnId: string }): string {
  return uuidv5({ name: `${params.sessionId}/${params.turnId}`, namespace: AMAN_MEMORY_NAMESPACE });
}

export interface BuildRetainItemParams {
  sessionId: string;
  turnId: string;
  userText: string;
  completedAt: string;
  /** Where the turn's text came from. The caller always says; nothing is assumed. */
  origin: AmanMemoryOrigin;
  /**
   * The text to store in place of the person's words as they wrote them: the durable facts.
   * Set only when `MEMORY_SUMMARIZE` is on for this turn.
   *
   * Screening adjudication: it inherits the turn's origin unchanged. Summarization is not a
   * trust upgrade: facts from a tool_ingested turn stay tool_ingested (the summarizer treats
   * the exchange as untrusted and may echo injected content), and a user_stated turn stays
   * user_stated.
   */
  memoryText?: string | undefined;
}

/**
 * The item for the person's side of a turn: the facts, or their own words when the turn is kept in full.
 * The reply is never part of it, because what the assistant said is not what the person said; a turn kept
 * in full saves the reply as a note of its own. Returns undefined when that side holds nothing.
 *
 * Lossless by design: this never drops or gates a memory on its origin. It only stamps the origin
 * so the recall screen can decide, later and per turn, which recalled items reach the model.
 */
export function buildRetainItem(params: BuildRetainItemParams): RetainItem | undefined {
  const userText = params.userText.trim();
  const content = params.memoryText === undefined ? userText && `User: ${userText}` : params.memoryText.trim();
  if (content === '') {
    return undefined;
  }
  const item: RetainItem = {
    content,
    timestamp: params.completedAt,
    document_id: `aman-${params.sessionId}-${params.turnId}`,
    metadata: {
      [SESSION_ID_METADATA_KEY]: params.sessionId,
      turn_id: params.turnId,
      source: 'aman-chat',
      [MEMORY_ORIGIN_METADATA_KEY]: params.origin,
    },
  };
  return item;
}

/**
 * Context for LLM summarization of a turn. Canonical shape shared by the turn drain
 * input and the retain params: both must agree, so it is defined once here.
 */
export interface SummarizeTurnContext {
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  /** Model to summarize with; an undefined or blank value means no summary, so the turn saves nothing. */
  summarizationModelFqn: string | undefined;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
  /** Read after a save to learn whether notes are sorted onto pages. */
  globalSettingsStore: IGlobalSettingsStore;
  /**
   * The person's name from their personalization profile. A saved fact leaves the person out and
   * uses the name only where it would be unclear without it. Undefined when the profile holds no
   * name; the summarizer then falls back on "the person".
   */
  personName?: string | undefined;
  /**
   * The name of the assistant or persona that replied, from the persona or profile, so a note about
   * its reply can say whose reply it was. Undefined falls back to "the assistant".
   */
  assistantName?: string | undefined;
  /**
   * Lines of the person's personalization and learned profile. A summary that only repeats them is
   * not saved, so the profile is never copied into memory turn after turn.
   */
  profileLines?: readonly string[] | undefined;
  /** Test seam; production leaves it unset and resolves a model client over the configured provider. */
  resolveLlm?: ((modelFqn: string) => Promise<ILLM>) | undefined;
}

/** A line as compared for the profile guard: case, surrounding space, and a leading bullet do not count. */
function comparableLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*\u2022]\s+)/, '')
    .trim()
    .toLowerCase();
}

/**
 * True when every fact is already a line of the profile (so the whole summary is a copy of it, or
 * a line-for-line subset). A summary with even one new line is kept whole.
 */
export function isProfileEcho(params: {
  facts: readonly string[];
  profileLines: readonly string[] | undefined;
}): boolean {
  if (params.facts.length === 0 || params.profileLines === undefined || params.profileLines.length === 0) {
    return false;
  }
  const known = new Set(params.profileLines.map(comparableLine).filter(line => line !== ''));
  return params.facts.every(fact => fact.split('\n').every(line => known.has(comparableLine(line))));
}

/**
 * Present for an interactive turn, so its memory outcomes are logged at info. Absent for
 * scheduled turns and recovery resubmissions, which log nothing at info.
 */
export interface RetainOutcomeLog {
  /** The persona whose vault the turn retains into; `shared` when no persona is active. */
  personaName: string;
}

/**
 * Rides the turn's fact call when the person has profile learning on, so learning costs no model
 * call of its own: the call is shown the profile's lines and says which kept facts belong there.
 */
export interface TurnProfileLearning {
  /** The learned profile's lines, in the order the model sees them numbered. */
  knownLines: readonly string[];
  /** Called once the fact call has run, with the lines it suggested; an empty list when it kept nothing or failed. */
  onAnswered: (lines: readonly ProfileLineSuggestion[]) => void;
}

export interface SubmitRetainParams {
  client: MemoryClient;
  /** The chat the turn belongs to; a private chat keeps nothing, so nothing is decided or sent. */
  session: Pick<SessionRecord, 'is_incognito'>;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
  completedAt: string;
  /** The person's IANA time zone, so a summary writes dates as the day they lived. */
  timeZone?: string | undefined;
  /** Where the turn's text came from. The caller always says; nothing is assumed. */
  origin: AmanMemoryOrigin;
  /**
   * True only when the caller knows the chat had read nothing from outside when the reply was written:
   * no tool result, file, recalled note or summary that is not the person's own words, in any turn.
   * Left out, the chat counts as having read something.
   */
  chatReadNothing?: boolean | undefined;
  /**
   * True when the reply changed a memory page with the page tools. The message then has its one writer, so the
   * notes saved from it are kept but never sorted onto pages a second time, in other words.
   */
  chatWrotePages?: boolean | undefined;
  logger: Logger;
  outcomeLog?: RetainOutcomeLog | undefined;
  /** What the turn's tools returned, so concrete findings can be saved as labeled notes. */
  toolResults?: readonly TurnToolResult[] | undefined;
  /**
   * Context for LLM summarization of the turn. Present only when turn summarization was
   * enabled for the turn (the Settings toggle's persisted override, else the
   * `MEMORY_SUMMARIZE` env default, resolved once per turn by `resolveTurnSummarizeContext`);
   * when the summarization fails or finds nothing durable, nothing is retained. Absent means
   * never summarize (the full exchange is kept).
   */
  summarize?: SummarizeTurnContext | undefined;
  /** Present only when profile learning is on for the person and this is the turn's first attempt. */
  profileLearning?: TurnProfileLearning | undefined;
}

/**
 * Fire-and-forget retain submission for one turn. Never throws: a memory-provider failure
 * here must never fail or delay the turn it belongs to. This function does not record any
 * pending-operation state: the capability's own sweep (hydrated from durable capability
 * state) is the retry path for a submission that never reached the provider.
 */
export async function submitRetain(params: SubmitRetainParams): Promise<void> {
  await attemptRetainSubmission(params);
}

/** Outcome of one retain submission attempt; `skipped` means there was nothing to retain. */
type RetainSubmissionResult = 'submitted' | 'failed' | 'skipped';

/**
 * What one turn adds to memory: text to store, notes alone, the turn in full, or nothing at all. A turn kept
 * in full is the person's words plus the reply as a note.
 */
type TurnMemory =
  | { kind: 'text'; text: string; notes: readonly LabeledNote[] }
  | { kind: 'notes'; notes: readonly LabeledNote[] }
  | { kind: 'exchange'; notes: readonly LabeledNote[] }
  | { kind: 'nothing' };

/** A finding or reply note ready to store: its source, its day, and its text with the label in front. */
export interface LabeledNote {
  source: MemoryNoteSource;
  date: string;
  text: string;
}

/** One fact is a plain sentence; several are short bullet lines. */
function formatFacts(facts: readonly string[]): string {
  const [only] = facts;
  return facts.length === 1 && only !== undefined ? only : facts.map(fact => `- ${fact}`).join('\n');
}

/**
 * Decides what the turn adds to memory when summarization context was provided. The context is
 * present only when turn summarization is enabled for the turn (the Settings toggle's
 * persisted override, else the `MEMORY_SUMMARIZE` env default, resolved once per turn by
 * `resolveTurnSummarizeContext`), so its presence is the enablement signal. Without it the full
 * exchange is kept for the backend to digest.
 *
 * With it, the exchange itself is never stored: durable facts are stored, and a failed summary,
 * an unsummarized turn, or "nothing durable" stores nothing. Every outcome is logged at debug so
 * the effective state stays observable.
 */
async function decideTurnMemory(params: SubmitRetainParams): Promise<TurnMemory> {
  const summarize = params.summarize;
  if (summarize === undefined) {
    return decidePersonFacts(params);
  }
  const [person, notes] = await Promise.all([decidePersonFacts(params), decideNotes({ params, summarize })]);
  if (notes.length === 0) {
    return person;
  }
  return person.kind === 'text' ? { ...person, notes } : { kind: 'notes', notes };
}

/** The findings and reply notes of the turn, labeled with where they came from and the day. Never throws. */
async function decideNotes({
  params,
  summarize,
}: {
  params: SubmitRetainParams;
  summarize: SummarizeTurnContext;
}): Promise<LabeledNote[]> {
  const notes = await summarizeTurnNotes({
    results: params.toolResults ?? [],
    assistantText: params.assistantText,
    turnDate: params.completedAt,
    timeZone: params.timeZone,
    personName: summarize.personName,
    assistantName: summarize.assistantName,
    tenantId: summarize.tenantId,
    modelProviderStore: summarize.modelProviderStore,
    summarizationModelFqn: summarize.summarizationModelFqn,
    tokenFactoryBudget: summarize.tokenFactoryBudget,
    modelUsage: summarize.modelUsage,
    logger: params.logger,
  });
  const date = turnDay(params);
  const assistantName = usablePersonName(summarize.assistantName);
  return notes
    .filter(note => withoutAbilityNotes([note.text]).length > 0)
    .map(note => ({
      source: note.source,
      date,
      text: labeledNoteText({ label: noteLabel({ source: note.source, date, assistantName }), text: note.text }),
    }));
}

/** The day the turn ended, as the person lived it. */
function turnDay(params: SubmitRetainParams): string {
  const instant = new Date(params.completedAt);
  return localDay({
    instant: Number.isNaN(instant.getTime()) ? new Date() : instant,
    timeZone: params.timeZone,
  }).date;
}

/** The whole reply of a turn kept in full, as a reply note; nothing when the reply only said what the assistant cannot do. */
function fullReplyNotes(params: SubmitRetainParams): LabeledNote[] {
  const [reply] = withoutAbilityNotes([params.assistantText.trim()]);
  if (reply === undefined) {
    return [];
  }
  const date = turnDay(params);
  const label = noteLabel({ source: ASSISTANT_RESPONSE_SOURCE, date, assistantName: undefined });
  return [{ source: ASSISTANT_RESPONSE_SOURCE, date, text: labeledNoteText({ label, text: reply }) }];
}

/** What the person said that is worth keeping, decided as it always was; notes are decided apart from it. */
async function decidePersonFacts(params: SubmitRetainParams): Promise<TurnMemory> {
  const summarize = params.summarize;
  if (summarize === undefined) {
    params.logger.debug('Turn summarization context not provided; retaining the full exchange', {
      sessionId: params.sessionId,
      turnId: params.turnId,
    });
    return { kind: 'exchange', notes: fullReplyNotes(params) };
  }
  try {
    const result = await summarizeTurnContent({
      userText: params.userText,
      assistantText: params.assistantText,
      turnDate: params.completedAt,
      timeZone: params.timeZone,
      tenantId: summarize.tenantId,
      modelProviderStore: summarize.modelProviderStore,
      summarizationModelFqn: summarize.summarizationModelFqn,
      personName: summarize.personName,
      tokenFactoryBudget: summarize.tokenFactoryBudget,
      modelUsage: summarize.modelUsage,
      logger: params.logger,
      profileLines: params.profileLearning?.knownLines,
      vaultDir: params.client.pagesWriteDir?.(),
      resolveLlm: summarize.resolveLlm,
    });
    params.profileLearning?.onAnswered(result.status === 'summarized' ? (result.profileLines ?? []) : []);
    switch (result.status) {
      case 'summarized': {
        await recordSummaryOutcome(params, { outcome: 'summarized' });
        const facts = withoutAbilityNotes(result.facts);
        if (facts.length === 0) {
          logTurnMemoryNotSaved(params, {
            message: 'it only described what the assistant could not do',
            reason: 'ability_notes_only',
          });
          return { kind: 'nothing' };
        }
        if (isProfileEcho({ facts, profileLines: summarize.profileLines })) {
          logTurnMemoryNotSaved(params, {
            message: 'it only repeated what the profile already says',
            reason: 'profile_echo',
          });
          return { kind: 'nothing' };
        }
        params.logger.debug('Turn summarized; storing the facts instead of the exchange', {
          sessionId: params.sessionId,
          turnId: params.turnId,
          factCount: facts.length,
        });
        return { kind: 'text', text: formatFacts(facts), notes: [] };
      }
      case 'nothing_to_keep':
        await recordSummaryOutcome(params, { outcome: 'summarized' });
        logTurnMemoryNotSaved(params, { message: 'it held nothing worth keeping', reason: 'nothing_to_keep' });
        return { kind: 'nothing' };
      case 'failed':
        params.logger.debug('Memory summarization failed', { reason: result.reason });
        await recordSummaryOutcome(params, { outcome: 'failed', reason: result.fallback });
        logTurnMemoryNotSaved(params, { message: 'the summary failed', reason: result.fallback });
        return { kind: 'nothing' };
      case 'skipped':
        params.logger.debug('Memory summarization skipped', { reason: result.reason });
        // An empty exchange holds nothing to lose. A missing model is a loss the Memories page should say.
        if (result.reason === 'no-model-configured') {
          await recordSummaryOutcome(params, { outcome: 'failed', reason: 'model_unresolved' });
          logTurnMemoryNotSaved(params, { message: 'no summary model is set', reason: 'no_summary_model' });
        }
        return { kind: 'nothing' };
    }
  } catch (error) {
    params.logger.debug('Memory summarization threw', {
      reason: error instanceof Error ? error.message : String(error),
    });
    await recordSummaryOutcome(params, { outcome: 'failed', reason: 'model_failed' });
    logTurnMemoryNotSaved(params, { message: 'the summary failed', reason: 'model_failed' });
    return { kind: 'nothing' };
  }
}

/**
 * Notes a summary attempt's outcome on the client when it tracks summary state, so a
 * failed summary stays visible on the Memories page until a later summary succeeds.
 * A deliberate skip (an empty exchange) is not a failure and never reaches this helper.
 * Never throws.
 */
async function recordSummaryOutcome(
  params: SubmitRetainParams,
  note: { outcome: 'summarized' | 'failed'; reason?: SummaryFallbackReason | undefined },
): Promise<void> {
  try {
    await params.client.noteSummaryOutcome?.(note);
  } catch (error) {
    params.logger.debug('Recording the turn summary outcome failed', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Info line for a turn that adds nothing to memory, with the one reason; interactive turns only. */
function logTurnMemoryNotSaved(params: SubmitRetainParams, why: { message: string; reason: string }): void {
  if (params.outcomeLog === undefined) {
    return;
  }
  params.logger.info(`Turn memory not saved: ${why.message}`, {
    sessionId: params.sessionId,
    turnId: params.turnId,
    personaName: params.outcomeLog.personaName,
    reason: why.reason,
  });
}

/**
 * Retain items for the turn's notes. They carry the untrusted origin, so recall holds them to the strict
 * screening posture: a finding is what something outside the chat said, and a reply note is the assistant's
 * own words, neither of them the person's voice.
 */
function noteRetainItems({
  params,
  notes,
}: {
  params: SubmitRetainParams;
  notes: readonly LabeledNote[];
}): RetainItem[] {
  return notes.map((note, index) =>
    noteRetainItem({
      sessionId: params.sessionId,
      turnId: params.turnId,
      completedAt: params.completedAt,
      note,
      documentId: `aman-${params.sessionId}-${params.turnId}-note-${String(index)}`,
      chatReadNothing: params.chatReadNothing === true && params.origin === USER_STATED_ORIGIN,
    }),
  );
}

/** One note ready for the provider, carrying the untrusted origin like every note. */
export function noteRetainItem({
  sessionId,
  turnId,
  completedAt,
  note,
  documentId,
  chatReadNothing,
}: {
  sessionId: string;
  turnId: string;
  completedAt: string;
  note: LabeledNote;
  documentId: string;
  /** Whether the chat had read nothing from outside when this note was made; it counts only on a reply note. */
  chatReadNothing: boolean;
}): RetainItem {
  return {
    content: noteRetainContent({ text: note.text, source: note.source, date: note.date }),
    timestamp: completedAt,
    document_id: documentId,
    metadata: {
      [SESSION_ID_METADATA_KEY]: sessionId,
      turn_id: turnId,
      source: 'aman-chat',
      [MEMORY_ORIGIN_METADATA_KEY]: TOOL_INGESTED_ORIGIN,
      [NOTE_SOURCE_METADATA_KEY]: note.source,
      [NOTE_DATE_METADATA_KEY]: note.date,
      ...(chatReadNothing && note.source === ASSISTANT_RESPONSE_SOURCE
        ? { [REPLY_READ_NOTHING_METADATA_KEY]: 'true' }
        : {}),
    },
  };
}

/** Newest daily files compared before a retain. An older copy is stored again, and recall shows the two as one. */
const DUPLICATE_CHECK_DAILY_FILES = 14;

/**
 * The items not already in the vault this client writes into. An item that carries the read-content
 * origin (a finding, a reply note, or a fact from a turn that read a tool result) comes back turn after
 * turn while the same email or page is in view, so one whose body matches a live entry in the newest
 * daily files is not stored again.
 * Items from a turn that read nothing outside the chat, and backends with no listing, store every item.
 */
async function withoutStoredCopies({
  params,
  items,
}: {
  params: SubmitRetainParams;
  items: readonly RetainItem[];
}): Promise<RetainItem[]> {
  const readContent = (item: RetainItem): boolean => item.metadata[MEMORY_ORIGIN_METADATA_KEY] === TOOL_INGESTED_ORIGIN;
  if (!items.some(readContent)) {
    return [...items];
  }
  const listRecent = params.client.listRecentWrittenEntries?.bind(params.client);
  if (listRecent === undefined) {
    return [...items];
  }
  let stored: Set<string>;
  try {
    const listed = await listRecent({
      maxDailyFiles: DUPLICATE_CHECK_DAILY_FILES,
      timeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
    });
    if (!listed.ok) {
      return [...items];
    }
    stored = new Set(listed.entries.map(entry => normalizedEntryBody(entry.text)));
  } catch (error) {
    // A listing that fails must never lose a memory; the copy is stored and the person can delete it.
    params.logger.debug('Memory listing failed before retain; storing without the duplicate check', {
      sessionId: params.sessionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [...items];
  }
  return items.filter(item => !readContent(item) || !stored.has(normalizedEntryBody(item.content)));
}

/**
 * Records that the notes a save has just written need no sorting, because the reply wrote to the pages itself.
 * Never throws: a note that could not be recorded is sorted later like any other.
 */
async function markFiledByChat({
  client,
  written,
  logger,
}: {
  client: MemoryClient;
  written: readonly WrittenEntry[] | undefined;
  logger: Logger;
}): Promise<void> {
  const vaultDir = client.pagesWriteDir?.();
  if (vaultDir === undefined) {
    return;
  }
  try {
    for (const entry of written ?? []) {
      await appendHandledNote({ vaultDir, noteId: entry.id, outcome: 'chat' });
    }
  } catch (error) {
    logger.warn(
      'Notes of a reply that wrote to the pages could not be recorded as filed.',
      extractErrorLogFields(error),
    );
  }
}

/**
 * Starts sorting the notes a save has just written, without waiting for it: the reply and the save never depend
 * on it. The work is bounded by the summarizer's limit on calls at once.
 */
export function startPageSorting({
  client,
  written,
  summarize,
  timeZone,
  logger,
}: {
  client: MemoryClient;
  written: readonly WrittenEntry[] | undefined;
  summarize: SummarizeTurnContext | undefined;
  timeZone: string | undefined;
  logger: Logger;
}): void {
  if (written === undefined || written.length === 0 || summarize === undefined) {
    return;
  }
  // The setting is read now, after the save, so a change in Settings applies to the very next save.
  void readMemoryPageSortingSetting({ globalSettingsStore: summarize.globalSettingsStore, logger }).then(setting =>
    sortWrittenNotes({ mode: setting.mode, client, written, summarize, timeZone, logger }),
  );
}

async function attemptRetainSubmission(
  params: SubmitRetainParams,
  /**
   * Precomputed decision. When provided, the LLM is NOT invoked again, because the caller
   * already attempted summarization. When absent, it is decided here.
   */
  precomputed?: TurnMemory,
): Promise<RetainSubmissionResult> {
  if (sessionKeepsNothing({ session: params.session })) {
    return 'skipped';
  }
  // The decision is made once per turn: a repeat attempt must not call the model again.
  const memory = precomputed ?? (await decideTurnMemory(params));
  if (memory.kind === 'nothing') {
    // Recorded as done so the next turn's sweep does not rebuild this turn's exchange from the chat.
    await params.client.completeOperation?.(retainOperationId({ sessionId: params.sessionId, turnId: params.turnId }));
    return 'skipped';
  }
  const noteItems = noteRetainItems({ params, notes: memory.notes });
  const personItem =
    memory.kind === 'notes'
      ? undefined
      : buildRetainItem({ ...params, memoryText: memory.kind === 'text' ? memory.text : undefined });
  if (personItem === undefined && noteItems.length === 0) {
    // Decided here, before any backend call, so every backend behaves the same. Returning
    // 'skipped' also ends the verification pass, so this info line is logged once per turn.
    // Summarized facts were already filtered, so only a turn kept in full needs this line.
    if (memory.kind === 'exchange' && params.assistantText.trim() !== '') {
      logTurnMemoryNotSaved(params, {
        message: 'it only described what the assistant could not do',
        reason: 'ability_notes_only',
      });
    }
    return 'skipped';
  }
  const items = await withoutStoredCopies({
    params,
    items: [...(personItem === undefined ? [] : [personItem]), ...noteItems],
  });
  if (items.length === 0) {
    logTurnMemoryNotSaved(params, { message: 'the same note is already in memory', reason: 'already_stored' });
    await params.client.completeOperation?.(retainOperationId({ sessionId: params.sessionId, turnId: params.turnId }));
    return 'skipped';
  }
  try {
    const outcome = await params.client.retain({
      items,
      operationId: retainOperationId({ sessionId: params.sessionId, turnId: params.turnId }),
      timeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      params.logger.warn('Memory retain submission failed', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        reason: outcome.reason,
      });
      return 'failed';
    }
    if (params.chatWrotePages === true) {
      await markFiledByChat({ client: params.client, written: outcome.written, logger: params.logger });
    } else {
      startPageSorting({
        client: params.client,
        written: outcome.written,
        summarize: params.summarize,
        timeZone: params.timeZone,
        logger: params.logger,
      });
    }
    return 'submitted';
  } catch (error) {
    params.logger.warn('Memory retain submission threw unexpectedly', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/**
 * Retain submission with one bounded verification pass, for the turn event drain.
 *
 * The drain's submission used to be single-shot: when it failed, the only retry was the next
 * turn's sweep, so a session's final turn could lose its memory silently. After the submission
 * settles, this runs one sweep-equivalent pass over the deterministic operation id: one status
 * check, then at most one recovery — retryOperation for a failed op, or a resubmission of the
 * exact exchange when the op is missing or unreadable. The deterministic id makes resubmission
 * idempotent, and a queued or running op is left for the next sweep. Never throws; a
 * still-unverified op is logged with its operation id rather than dropped silently.
 *
 * Resolves `true` only when the provider holds the exchange (completed, queued, running, or
 * accepted by a retry), so callers can make claims about a save only on that outcome.
 */
export async function submitRetainWithVerification(params: SubmitRetainParams): Promise<boolean> {
  // Before the summary model runs: a private chat's words reach neither memory nor its notes.
  if (sessionKeepsNothing({ session: params.session })) {
    return false;
  }
  // Decide once; the retry path below must reuse it rather than invoking the LLM a second
  // time (cost, latency, and non-determinism).
  const precomputed = await decideTurnMemory(params);
  const result = await attemptRetainSubmission(params, precomputed);
  if (result === 'skipped') {
    return false;
  }
  const operationId = retainOperationId({ sessionId: params.sessionId, turnId: params.turnId });
  const timeoutMs = configuration.MEMORY_RETAIN_TIMEOUT_MS;
  // Vanished, never landed, or unreadable: resubmit the exact exchange once.
  // Reuse the precomputed summary; do not invoke the LLM again.
  const resubmitOnce = async (reason?: string): Promise<boolean> => {
    const retryResult = await attemptRetainSubmission(params, precomputed);
    if (retryResult !== 'submitted') {
      params.logger.warn('Memory retain unverified after single retry pass', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        operationId,
        ...(reason === undefined ? {} : { reason }),
      });
    }
    return retryResult === 'submitted';
  };
  try {
    const check = await params.client.getOperation(operationId, timeoutMs);
    if (check.ok) {
      if (isOperationCompletedStatus(check.status)) {
        return true;
      }
      if (isOperationFailedStatus(check.status)) {
        const retried = await params.client.retryOperation(operationId, timeoutMs);
        if (!retried.ok) {
          params.logger.warn('Memory retain retry failed for failed operation', {
            sessionId: params.sessionId,
            turnId: params.turnId,
            operationId,
          });
        }
        return retried.ok;
      }
      if (check.status === 'unknown') {
        return await resubmitOnce();
      }
      // Still queued/running (or an unrecognized status): leave it for the next turn's sweep.
      params.logger.debug('Memory retain operation still pending after drain submission', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        operationId,
        status: check.status,
      });
      return true;
    }
    // Status unreadable: one deterministic resubmission is safe and may recover a submission
    // whose response was lost.
    return await resubmitOnce(check.reason);
  } catch (error) {
    params.logger.warn('Memory retain verification pass threw unexpectedly', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      operationId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return result === 'submitted';
  }
}
