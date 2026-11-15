/**
 * Profile learning: keeping the learned profile, the short document every chat starts with.
 *
 * It runs only for a user whose personalization profile has `learning_enabled` set from Settings;
 * there is no operator-side switch, and a user with no profile row has never opted in.
 *
 * Learning has no model call of its own. The turn's fact call, the one that decides what is worth
 * remembering, is shown the profile's lines and also says which kept facts belong in the profile.
 * Only what the person wrote is ever a source: that call sees the person's own text for the turn
 * and nothing the assistant, a tool, or recalled memory said. When no fact call ran for the turn
 * (no memory, or summaries off), this module makes that same call itself, once.
 *
 * The document is then edited by code, never rewritten by a model. A new line is added under its
 * heading. When the document is full, the oldest fact line is moved into memory exactly as
 * written, and lines that say how to work with the person stay. A line is moved only after memory
 * has accepted it, so nothing is shortened, merged, or lost to make room.
 *
 * Every failure is logged and can never fail, block, or delay the turn it learned from. Each write
 * leaves an `aman.profile.learned` passthrough audit row on the turn's event log, and is fenced on
 * the revision it read, so a person's own edit is never overwritten: the edit is read again and
 * the lines are added to it. A pass that finds learning off, or the row gone, writes nothing.
 *
 * The profile row is the authoritative state. The audit event is best-effort by design, and has
 * to be: the row and the event live in different stores, so no transaction can hold both. After
 * the profile write commits, the append is retried once and then only logged, at error level and
 * carrying the revision and both document digests, never allowed to undo or block anything.
 *
 * This module also registers `aman.profile.learned` in the harness's passthrough event
 * registry, the same way runtime/memory/memoryEvents.ts registers `aman.memory.recall`.
 */
import type { SessionRecord, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields, newEventId, type ILLM } from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'winston';
import type { IAgentStore } from '../db/agentStore';
import type { ICompletedTurnEventStore } from '../db/completedTurnEvents';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { PersonalizationRevisionConflictError, type IPersonalizationStore } from '../db/personalizationStore';
import {
  LEARNED_PROFILE_MAX_CHARACTERS,
  sanitizeLearnedProfile,
  type PersonalizationProfile,
} from '../personalization/profile';
import { ProfileLearnedEventSchema, type ProfileLearnedEvent } from '../schemas/profileLearningEvents';
import type { EventSubscription } from './event-subscription';
import type { MemoryClient, RetainItem } from './memory/memoryClient';
import { LEARNED_PROFILE_LINE_SOURCE, MEMORY_ORIGIN_METADATA_KEY, TOOL_INGESTED_ORIGIN } from './memory/memoryOrigin';
import type { SummarizeTurnContext } from './memory/memoryRetain';
import {
  resolveSummarizationModelFqn,
  summarizeTurnContent,
  type ProfileLineSuggestion,
} from './memory/memorySummarize';
import { uuidv5 } from './memory/uuidv5';
import type { TurnModelUsage } from './modelUsage';
import { sessionKeepsNothing } from './privateChat';
import type { TokenFactoryBudget } from './tokenFactoryBudget';

export { ProfileLearnedEventSchema } from '../schemas/profileLearningEvents';
export type { ProfileLearnedEvent } from '../schemas/profileLearningEvents';

/**
 * Registers `aman.profile.learned` in the harness's passthrough event registry. Same
 * mechanics and caveats as the `aman.memory.recall` registration in
 * runtime/memory/memoryEvents.ts: the augmentation must target the exact module that
 * declares `AgentPassthroughEventSchemaMap`, by relative path.
 */
declare module '../../../trueforge-core/src/core/events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.profile.learned': typeof ProfileLearnedEventSchema;
  }
}

/** `updated_by` actor for host-written learned-profile updates. */
export const PROFILE_LEARNING_ACTOR = 'aman-learning';

/** Prefix of the document id an earlier version saved a copy of the learned profile under. */
const LEARNED_PROFILE_DOCUMENT_ID_PREFIX = 'aman-learned-profile-';

/**
 * Text an earlier version stored as a memory when the profile was cleared. Nothing writes it now;
 * recall skips it so copies already stored never reach a chat.
 */
export const LEARNED_PROFILE_CLEARED_CONTENT = 'No learned profile is currently stored for this user.';

/** Delay before the one retry of the audit event append. */
const EVENT_APPEND_RETRY_DELAY_MS = 250;

/** Heading of the lines that say how the person wants the assistant to work with them. These stay when room is made. */
export const LEARNED_RULES_HEADING = 'How to work with me';

/** Heading new lines about the person are added under. */
export const LEARNED_FACTS_HEADING = 'About me';

/** Longest line added to the document; a longer one stays in memory only. */
const LEARNED_LINE_MAX_CHARACTERS = 300;

/** Times a write is tried again from a fresh read after the profile changed under it. */
const WRITE_ATTEMPTS = 3;

interface DocumentLine {
  raw: string;
  type: 'heading' | 'blank' | 'item';
  /** The heading the line sits under, lower-cased; empty before the first heading. */
  heading: string;
  /** The line without its bullet. */
  text: string;
  /** Added by this edit, so never the line that makes room for it. */
  added: boolean;
}

function readDocument(document: string | null): DocumentLine[] {
  let heading = '';
  return (document ?? '').split('\n').map((raw): DocumentLine => {
    const trimmed = raw.trim();
    const title = /^#{1,6}\s+(.*)$/.exec(trimmed)?.[1];
    if (title !== undefined) {
      heading = title.trim().toLowerCase();
      return { raw, type: 'heading', heading, text: title.trim(), added: false };
    }
    if (trimmed === '') {
      return { raw, type: 'blank', heading, text: '', added: false };
    }
    return { raw, type: 'item', heading, text: trimmed.replace(/^[-*\u2022]\s+/, '').trim(), added: false };
  });
}

function isRule(line: DocumentLine): boolean {
  return line.heading === LEARNED_RULES_HEADING.toLowerCase();
}

/** Drops a heading left with no lines, keeps one blank line before each heading, and trims the ends. */
function writeDocument(lines: readonly DocumentLine[]): string {
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (line.type === 'heading') {
      const next = lines.slice(index + 1).find(later => later.type !== 'blank');
      if (next === undefined || next.type === 'heading') {
        return;
      }
      if (out.length > 0 && out.at(-1) !== '') {
        out.push('');
      }
    }
    if (line.type === 'blank' && (out.length === 0 || out.at(-1) === '')) {
      return;
    }
    out.push(line.raw);
  });
  return out.join('\n').trim();
}

/** The document's lines as the fact call is shown them: no headings, no bullets, in document order. */
export function learnedProfileLines(document: string | null): string[] {
  return readDocument(document)
    .filter(line => line.type === 'item')
    .map(line => line.text);
}

/** One line fit to store: a single line, delimiter-safe, and short. Undefined when it cannot be one. */
function storableLine(text: string): string | undefined {
  const line = sanitizeLearnedProfile(text).replace(/\s+/g, ' ').trim();
  return line === '' || line.includes(']]>') || line.length > LEARNED_LINE_MAX_CHARACTERS ? undefined : line;
}

function addLine({ lines, line, kind }: { lines: DocumentLine[]; line: string; kind: 'rule' | 'fact' }): void {
  const title = kind === 'rule' ? LEARNED_RULES_HEADING : LEARNED_FACTS_HEADING;
  const heading = title.toLowerCase();
  const item: DocumentLine = { raw: `- ${line}`, type: 'item', heading, text: line, added: true };
  const last = lines.findLastIndex(existing => existing.heading === heading && existing.type !== 'blank');
  if (last !== -1) {
    lines.splice(last + 1, 0, item);
    return;
  }
  const section: DocumentLine[] = [{ raw: `## ${title}`, type: 'heading', heading, text: title, added: true }, item];
  // Rules lead the document, where every chat reads them first; facts follow whatever is there.
  if (kind === 'rule') {
    lines.unshift(...section);
  } else {
    lines.push(...section);
  }
}

/**
 * Adds learned lines to the document without rewording anything in it. A line the document
 * already holds is skipped. A line that replaces another takes that line out. When the result is
 * over `maxCharacters`, lines are taken out until it fits: the oldest line about the person first,
 * and a line on how to work with them only when no other is left. Every line taken out is returned
 * in `moved`, exactly as written, for the caller to keep elsewhere. When nothing is added the
 * document comes back untouched.
 */
export function addLearnedLines(params: {
  document: string | null;
  lines: readonly ProfileLineSuggestion[];
  maxCharacters: number;
}): { document: string | null; moved: string[] } {
  const lines = readDocument(params.document);
  const moved: string[] = [];
  let added = 0;
  for (const suggestion of params.lines) {
    const line = storableLine(suggestion.text);
    const known = (text: string): boolean => text.toLowerCase() === line?.toLowerCase();
    if (line === undefined || lines.some(existing => existing.type === 'item' && known(existing.text))) {
      continue;
    }
    const replaced = lines.findIndex(existing => existing.type === 'item' && existing.text === suggestion.replaces);
    const [old] = replaced === -1 ? [] : lines.splice(replaced, 1);
    if (old !== undefined) {
      moved.push(old.text);
    }
    addLine({ lines, line, kind: suggestion.kind });
    added += 1;
  }
  if (added === 0) {
    return { document: params.document, moved: [] };
  }
  while (writeDocument(lines).length > params.maxCharacters) {
    const movable = (line: DocumentLine): boolean => line.type === 'item' && !line.added;
    const fact = lines.findIndex(line => movable(line) && !isRule(line));
    const oldest = fact === -1 ? lines.findIndex(movable) : fact;
    const [out] = oldest === -1 ? [] : lines.splice(oldest, 1);
    if (out === undefined) {
      // Only this edit's own lines are left and they do not fit: add none of them.
      return { document: params.document, moved: [] };
    }
    moved.push(out.text);
  }
  return { document: writeDocument(lines), moved };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The context line copies were saved with; a store without document ids recognises older copies by it. */
const LEARNED_PROFILE_CONTEXT = 'Learned user profile';

/** The source the host stamped on copies; a store that returns metadata can tell a copy by it. */
const LEARNED_PROFILE_SOURCE = 'aman-profile-learning';

function learnedProfileDocumentId(userRef: string): string {
  return `${LEARNED_PROFILE_DOCUMENT_ID_PREFIX}${sha256Hex(userRef).slice(0, 16)}`;
}

/** True for a recalled note an earlier version saved as a copy of the learned profile. Reads only host-stamped metadata. */
export function isLearnedProfileCopy(metadata: Readonly<Record<string, string>> | undefined): boolean {
  return (
    metadata?.['source'] === LEARNED_PROFILE_SOURCE ||
    metadata?.['document_id']?.startsWith(LEARNED_PROFILE_DOCUMENT_ID_PREFIX) === true
  );
}

/**
 * Removes the copy of the learned profile that an earlier version saved into memory. The document
 * is in every prompt already, so memory holds none. A failure is logged and never thrown: the
 * caller's own work must not fail on it.
 */
export async function deleteLearnedProfileCopy(params: {
  client: MemoryClient | undefined;
  userRef: string;
  timeoutMs: number;
  logger: Logger;
}): Promise<void> {
  const { client, userRef, timeoutMs, logger } = params;
  if (client === undefined) {
    return;
  }
  try {
    const outcome = await client.deleteDocument({
      documentId: learnedProfileDocumentId(userRef),
      context: LEARNED_PROFILE_CONTEXT,
      timeoutMs,
    });
    if (!outcome.ok) {
      logger.warn('Learned profile copy could not be removed from memory', { reason: outcome.reason });
    }
  } catch (error) {
    logger.warn('Learned profile copy removal threw unexpectedly', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What the turn's fact call needs when this module has to make it itself. */
export interface ProfileLearningFactCall {
  modelProviderStore: IModelProviderStore;
  /** Model to ask; undefined means no call, so nothing is learned from the turn. */
  summarizationModelFqn: string | undefined;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
  personName?: string | undefined;
  timeZone?: string | undefined;
  /** Test seam; production leaves it unset and resolves a model client over the configured provider. */
  resolveLlm?: ((modelFqn: string) => Promise<ILLM>) | undefined;
}

/** Per-turn inputs the create-turn handler resolves up front and the drain carries to the pass. */
export interface ProfileLearningDrainMember {
  /** The chat the turn belongs to; nothing is learned from a private chat. */
  session: Pick<SessionRecord, 'is_incognito'>;
  personalizationStore: IPersonalizationStore;
  eventStore: ICompletedTurnEventStore;
  memoryClient: MemoryClient | undefined;
  retainTimeoutMs: number;
  tenantId: string;
  createdBy: string;
  userText: string;
  /** The learned profile's lines as the turn began, for the fact call to be shown. */
  knownLines: readonly string[];
  factCall: ProfileLearningFactCall;
}

/**
 * The learning member for one turn the person wrote, or undefined when their learning is off (the default, which
 * costs nothing). Learning rides the turn's fact call; the model found here is asked only when no fact call runs.
 * The pass reads the switch again after the turn, so turning learning off mid-turn is still obeyed. This runs while
 * a turn starts, so it must never fail one: a model lookup that throws drops learning for this turn.
 */
export async function profileLearningForTurn(params: {
  profile: Pick<PersonalizationProfile, 'learning_enabled' | 'learned_profile' | 'user_name'> | undefined;
  session: Pick<SessionRecord, 'is_incognito' | 'agent'>;
  sessionId: string;
  personalizationStore: IPersonalizationStore;
  eventStore: ICompletedTurnEventStore;
  memoryClient: MemoryClient | undefined;
  retainTimeoutMs: number;
  tenantId: string;
  createdBy: string;
  userText: string;
  timeZone: string | undefined;
  /** The turn's own fact call settings; undefined when no fact call runs, so the model is looked up here. */
  memorySummarize: SummarizeTurnContext | undefined;
  personaModelName: string | undefined;
  agentStore: IAgentStore;
  globalSettingsStore: IGlobalSettingsStore;
  modelProviderStore: IModelProviderStore;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
  logger: Logger;
}): Promise<ProfileLearningDrainMember | undefined> {
  const { profile } = params;
  if (profile?.learning_enabled !== true) {
    return undefined;
  }
  try {
    return {
      session: params.session,
      personalizationStore: params.personalizationStore,
      eventStore: params.eventStore,
      memoryClient: params.memoryClient,
      retainTimeoutMs: params.retainTimeoutMs,
      tenantId: params.tenantId,
      createdBy: params.createdBy,
      userText: params.userText,
      knownLines: learnedProfileLines(profile.learned_profile),
      factCall: {
        modelProviderStore: params.modelProviderStore,
        summarizationModelFqn:
          params.memorySummarize === undefined
            ? await resolveSummarizationModelFqn({
                tenantId: params.tenantId,
                personaModelName: params.personaModelName,
                sessionAgent: params.session.agent,
                agentStore: params.agentStore,
                globalSettingsStore: params.globalSettingsStore,
                modelProviderStore: params.modelProviderStore,
                logger: params.logger,
              })
            : params.memorySummarize.summarizationModelFqn,
        tokenFactoryBudget: params.tokenFactoryBudget,
        modelUsage: params.modelUsage,
        personName: profile.user_name ?? undefined,
        timeZone: params.timeZone,
      },
    };
  } catch (error) {
    params.logger.debug('Profile learning disabled for this turn: the model FQN did not resolve', {
      sessionId: params.sessionId,
      ...extractErrorLogFields(error),
    });
    return undefined;
  }
}

export interface SubmitProfileLearningParams extends ProfileLearningDrainMember {
  sessionId: string;
  turnId: string;
  completedAt: string;
  /** The reply, read only for its last question when the person's message is a short answer to it. */
  assistantText: string;
  /**
   * What the turn's fact call suggested for the profile. Undefined when no fact call ran for the
   * turn; this module then makes that call itself. An empty list means the call ran and found
   * nothing, and no other call is made.
   */
  suggestions: readonly ProfileLineSuggestion[] | undefined;
  /**
   * The turn's live event stream, so an open chat tab sees the audit event without a reload.
   * Only the drain owns one; omitting it costs the live echo and nothing else.
   */
  turnEventStream?: EventSubscription<TurnStreamingEvent> | undefined;
  logger: Logger;
}

/** The audit event as it is persisted and streamed: the bare event plus durable identity. */
type PersistedProfileLearnedEvent = ProfileLearnedEvent & { id: string; created_at: string };

/**
 * Persists the audit event, then echoes it to the turn's live stream.
 *
 * The profile row is already committed and authoritative by the time this runs, so nothing
 * here may throw: one retry absorbs a transient store failure, and a second failure is logged
 * at error level with the revision and both document digests, which is what a later
 * reconstruction of the missing row needs. The live echo is looser still: the durable row is
 * the record, so a failed put is only logged.
 */
async function appendLearnedProfileEvent(params: {
  eventStore: ICompletedTurnEventStore;
  turnEventStream: EventSubscription<TurnStreamingEvent> | undefined;
  sessionId: string;
  turnId: string;
  event: PersistedProfileLearnedEvent;
  logger: Logger;
}): Promise<void> {
  const { event, logger } = params;
  const input = { session_id: params.sessionId, turn_id: params.turnId, events: [event] };
  try {
    await params.eventStore.appendEventsToDoneTurn(input);
  } catch (first) {
    await sleep(EVENT_APPEND_RETRY_DELAY_MS);
    try {
      await params.eventStore.appendEventsToDoneTurn(input);
    } catch (second) {
      logger.error('Learned profile audit event was lost; the profile row still holds the document', {
        sessionId: params.sessionId,
        turnId: params.turnId,
        revision: event.revision,
        previousDigest: event.previous === null ? null : sha256Hex(event.previous),
        currentDigest: sha256Hex(event.current),
        firstReason: first instanceof Error ? first.message : String(first),
        reason: second instanceof Error ? second.message : String(second),
      });
      return;
    }
  }
  try {
    await params.turnEventStream?.put(event);
  } catch (error) {
    logger.warn('Learned profile audit event was persisted but not streamed', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function removeCopy(params: SubmitProfileLearningParams): Promise<void> {
  return deleteLearnedProfileCopy({
    client: params.memoryClient,
    userRef: params.createdBy,
    timeoutMs: params.retainTimeoutMs,
    logger: params.logger,
  });
}

/** The fact call, made here only because nothing else made it for this turn. Never throws. */
async function askForProfileLines(
  params: SubmitProfileLearningParams,
  knownLines: readonly string[],
): Promise<readonly ProfileLineSuggestion[]> {
  const { factCall } = params;
  const result = await summarizeTurnContent({
    userText: params.userText,
    assistantText: params.assistantText,
    turnDate: params.completedAt,
    timeZone: factCall.timeZone,
    personName: factCall.personName,
    tenantId: params.tenantId,
    modelProviderStore: factCall.modelProviderStore,
    summarizationModelFqn: factCall.summarizationModelFqn,
    tokenFactoryBudget: factCall.tokenFactoryBudget,
    modelUsage: factCall.modelUsage,
    logger: params.logger,
    profileLines: knownLines,
    vaultDir: params.memoryClient?.pagesWriteDir?.(),
    resolveLlm: factCall.resolveLlm,
  });
  return result.status === 'summarized' ? (result.profileLines ?? []) : [];
}

/**
 * Keeps lines taken out of the document in memory. A line does not record whose words it was
 * learned from, so the note is kept as something read, not as the person's own words. True only when
 * memory accepted every line; the caller leaves the document as it was otherwise. The document id
 * comes from the line itself, so a second attempt stores the same notes, not more of them.
 */
async function keepMovedLines(params: SubmitProfileLearningParams, moved: readonly string[]): Promise<boolean> {
  const client = params.memoryClient;
  if (client === undefined) {
    return false;
  }
  const items = moved.map((line): RetainItem => ({
    content: line,
    timestamp: params.completedAt,
    document_id: `aman-profile-line-${sha256Hex(`${params.createdBy}\n${line}`).slice(0, 24)}`,
    metadata: { source: LEARNED_PROFILE_LINE_SOURCE, [MEMORY_ORIGIN_METADATA_KEY]: TOOL_INGESTED_ORIGIN },
  }));
  try {
    const outcome = await client.retain({
      items,
      operationId: uuidv5({ name: items.map(item => item.document_id).join('\n'), namespace: MOVED_LINES_NAMESPACE }),
      timeoutMs: params.retainTimeoutMs,
    });
    if (!outcome.ok) {
      params.logger.warn('Lines leaving the learned profile were not accepted by memory', { reason: outcome.reason });
    }
    return outcome.ok;
  } catch (error) {
    params.logger.warn('Keeping lines that leave the learned profile threw unexpectedly', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Namespace for the operation ids of moved-line saves. */
const MOVED_LINES_NAMESPACE = '5b0f4a1e-7c1d-5d43-9a55-2f6f0c3b8e17';

async function learnFromTurn(params: SubmitProfileLearningParams): Promise<void> {
  const read = () =>
    params.personalizationStore.getProfile({ tenant_id: params.tenantId, created_by: params.createdBy });
  let profile = await read();
  // The profile is the switch, and it is read here rather than at the turn so a user who turns
  // learning off while a turn was running is obeyed. No row at all means off: nothing has ever
  // opted in. Before any model call and before any write.
  if (profile?.learning_enabled !== true) {
    return;
  }
  const suggestions =
    params.suggestions ?? (await askForProfileLines(params, learnedProfileLines(profile.learned_profile)));

  for (let attempt = 0; attempt < WRITE_ATTEMPTS && suggestions.length > 0; attempt += 1) {
    if (attempt > 0 || params.suggestions === undefined) {
      // A model call or a lost write sits behind us: act on the profile as it is now.
      profile = await read();
      if (profile?.learning_enabled !== true) {
        params.logger.debug('Profile learning stopped: learning was switched off during the turn', {
          sessionId: params.sessionId,
          turnId: params.turnId,
        });
        return;
      }
    }
    const previous = profile.learned_profile;
    const edit = addLearnedLines({
      document: previous,
      lines: suggestions,
      maxCharacters: LEARNED_PROFILE_MAX_CHARACTERS,
    });
    if (edit.document === previous || edit.document === null) {
      break;
    }
    // Memory takes the lines before the document lets go of them, so a failed save loses nothing.
    if (edit.moved.length > 0 && !(await keepMovedLines(params, edit.moved))) {
      params.logger.warn('Learned profile left unchanged: it is full and memory could not take its oldest lines', {
        sessionId: params.sessionId,
        turnId: params.turnId,
      });
      break;
    }
    let updated: PersonalizationProfile;
    try {
      updated = await params.personalizationStore.upsertProfile({
        tenant_id: params.tenantId,
        created_by: params.createdBy,
        updated_by: PROFILE_LEARNING_ACTOR,
        expected_revision: profile.revision,
        assistant_name: profile.assistant_name,
        assistant_identity: profile.assistant_identity,
        voice_guidance: profile.voice_guidance,
        user_name: profile.user_name,
        address_as: profile.address_as,
        user_profile: profile.user_profile,
        pinned_preferences: profile.pinned_preferences,
        help_areas: profile.help_areas,
        learned_profile: edit.document,
        learning_enabled: profile.learning_enabled,
      });
    } catch (error) {
      if (error instanceof PersonalizationRevisionConflictError) {
        params.logger.debug('Profile learning write lost the revision fence; reading the profile again', {
          sessionId: params.sessionId,
          turnId: params.turnId,
        });
        continue;
      }
      throw error;
    }
    await appendLearnedProfileEvent({
      eventStore: params.eventStore,
      turnEventStream: params.turnEventStream,
      sessionId: params.sessionId,
      turnId: params.turnId,
      event: {
        type: 'aman.profile.learned',
        previous,
        current: edit.document,
        revision: updated.revision,
        id: newEventId(),
        created_at: new Date().toISOString(),
      },
      logger: params.logger,
    });
    break;
  }

  await removeCopy(params);
}

/**
 * Entry point called from the turn event drain on a successful turn.
 * Never throws and never rejects: a learning failure must never affect the turn.
 */
export async function submitProfileLearning(params: SubmitProfileLearningParams): Promise<void> {
  if (sessionKeepsNothing({ session: params.session }) || params.userText.trim() === '') {
    return;
  }
  try {
    await learnFromTurn(params);
  } catch (error) {
    params.logger.warn('Profile learning failed', {
      sessionId: params.sessionId,
      turnId: params.turnId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
