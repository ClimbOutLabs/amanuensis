import type { TurnRecordWithoutSnapshot } from '@truefoundry/trueforge-core/agent-session';
import type { ChatSearchDocument, ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { isAgentInputUserMessage, isFileContentPart, isHostWrappedText } from '@truefoundry/trueforge-core/core';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IPersonaStore } from '../db/personaStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { PersonaActivation } from '../personas/persona';

/** Text the person typed, without attachments or text the host wrapped around the message. */
function personText(text: string): string {
  return isHostWrappedText(text) ? '' : text;
}

/**
 * What counts as searchable text in one finished turn: the words the person typed and the
 * assistant's final reply. Tool calls, tool output, attachments and text the host wrapped
 * around a message stay out. The live indexer and the backfill both read turns through here.
 */
export function chatSearchDocumentsForTurn<TCustom extends object>(
  turn: TurnRecordWithoutSnapshot<TCustom>,
): ChatSearchDocument[] {
  const documents: ChatSearchDocument[] = [];
  const userText = turn.input
    .filter(isAgentInputUserMessage)
    .map(message =>
      typeof message.content === 'string'
        ? personText(message.content)
        : message.content
            .filter(part => !isFileContentPart(part))
            .map(part => personText(part.text))
            .filter(text => text.length > 0)
            .join(' '),
    )
    .filter(text => text.trim().length > 0)
    .join('\n\n');
  if (userText.length > 0) {
    documents.push({ message_id: 'user', role: 'user', text: userText, created_at: turn.created_at });
  }
  if (turn.state.status === 'done') {
    const content = turn.state.output?.content;
    const assistantText =
      typeof content === 'string'
        ? content
        : content == null
          ? ''
          : content.map(part => (part.type === 'text' ? part.text : part.refusal)).join('\n');
    if (assistantText.trim().length > 0) {
      documents.push({ message_id: 'assistant', role: 'assistant', text: assistantText, created_at: turn.updated_at });
    }
  }
  return documents;
}

/** Whose chats an index job covers. */
export interface ChatSearchPerson {
  tenant_id: string;
  created_by: string;
}

/**
 * People whose chats still need a full pass, each with the token of the latest request. A
 * finishing pass removes its person only while the token is the one it started with, so a
 * request made during the pass is never lost.
 */
const PENDING_KEY = 'chat_search_backfill_pending';
const PendingBackfillsSchema = z.record(z.string(), z.string());
const BACKFILL_PAGE_SIZE = 50;

function personKey(person: ChatSearchPerson): string {
  return JSON.stringify([person.tenant_id, person.created_by]);
}

function cursorKey(person: ChatSearchPerson): string {
  return `chat_search_backfill_cursor:${personKey(person)}`;
}

function generationKey(person: ChatSearchPerson): string {
  return `chat_search_generation:${personKey(person)}`;
}

const PersonKeySchema = z.tuple([z.string(), z.string()]);

function personFromKey(key: string): ChatSearchPerson | undefined {
  try {
    const parsed = PersonKeySchema.safeParse(JSON.parse(key));
    return parsed.success ? { tenant_id: parsed.data[0], created_by: parsed.data[1] } : undefined;
  } catch {
    return undefined;
  }
}

async function readPending(
  store: IGlobalSettingsStore,
): Promise<{ raw: string | null; pending: Record<string, string> }> {
  const row = await store.getSetting({ key: PENDING_KEY });
  if (row === undefined) {
    return { raw: null, pending: {} };
  }
  try {
    const parsed = PendingBackfillsSchema.safeParse(JSON.parse(row.value));
    return { raw: row.value, pending: parsed.success ? parsed.data : {} };
  } catch {
    return { raw: row.value, pending: {} };
  }
}

function withoutPerson(pending: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(pending).filter(([entry]) => entry !== key));
}

/**
 * Applies one change to the pending list with compare-and-set, retrying when another writer got
 * there first. Returns false when the change declined to write by returning undefined.
 */
async function updatePending(
  store: IGlobalSettingsStore,
  change: (pending: Record<string, string>) => Record<string, string> | undefined,
): Promise<boolean> {
  for (;;) {
    const { raw, pending } = await readPending(store);
    const next = change({ ...pending });
    if (next === undefined) {
      return false;
    }
    const value = Object.keys(next).length === 0 ? null : JSON.stringify(next);
    if (value === raw || (await store.compareAndSetSetting({ key: PENDING_KEY, expected: raw, value }))) {
      return true;
    }
  }
}

/**
 * Asks for a full pass over one person's chats, starting from their first chat. The pass runs
 * only while their past-chat search switch is on; a server picks it up when it next starts,
 * so a request written by a process that is about to exit is not lost.
 */
export async function requestChatSearchBackfill(deps: {
  globalSettingsStore: IGlobalSettingsStore;
  person: ChatSearchPerson;
}): Promise<void> {
  await deps.globalSettingsStore.deleteSetting({ key: cursorKey(deps.person) });
  const token = randomUUID();
  await updatePending(deps.globalSettingsStore, pending => ({ ...pending, [personKey(deps.person)]: token }));
}

export interface ChatSearchIndexerDeps {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  globalSettingsStore: IGlobalSettingsStore;
  sentinelSettingsStore: ISentinelSettingsStore;
  personaStore: Pick<IPersonaStore, 'listSessionPersonaActivations'>;
  logger: Logger;
}

/** The switch state a write must still see to go ahead: on, and in the same switch generation it started in. */
interface ChatSearchSwitchState {
  enabled: boolean;
  generation: number;
}

/**
 * Whether the persona that answered a turn is known. A turn whose persona cannot be
 * decided is not indexed at all: guessing the main assistant would hand its words to
 * every persona, so the safe answer is to leave it out until a pass can decide it.
 */
type PersonaDecision = { decided: true; persona_id: string | null } | { decided: false };

function activationTime(activation: PersonaActivation): number {
  const parsed = Date.parse(activation.created_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Keeps the past-chat search index for people who turned the search on, and only for them.
 * A finished turn is written as it ends; chats from before the switch went on are written by
 * a resumable pass per person. Turning the switch off removes the person's rows and stops
 * their pass. A write that fails asks for a new pass, so no turn is left out for good.
 */
export class ChatSearchIndexer {
  readonly #deps: ChatSearchIndexerDeps;
  /** Passes running in this process, so a second request for the same person waits for the first. */
  readonly #running = new Map<string, Promise<void>>();

  constructor(deps: ChatSearchIndexerDeps) {
    this.#deps = deps;
  }

  /** Writes one finished turn when its person has the search on. Never throws: indexing must not fail a turn. */
  async indexFinishedTurn(input: ChatSearchPerson & { session_id: string; turn_id: string }): Promise<void> {
    const person = { tenant_id: input.tenant_id, created_by: input.created_by };
    try {
      const before = await this.#switchState(person);
      if (!before.enabled) {
        return;
      }
      const turn = await this.#deps.sessionStore.getTurn({ session_id: input.session_id, turn_id: input.turn_id });
      if (turn === undefined || turn.state.status === 'running') {
        return;
      }
      const written = await this.#writeTurn({
        tenant_id: input.tenant_id,
        turn,
        generation: before.generation,
        person,
      });
      if (written !== 'written') {
        return;
      }
      // An earlier write for this person failed: now that writes work again, run the pass it asked for.
      if ((await readPending(this.#deps.globalSettingsStore)).pending[personKey(person)] !== undefined) {
        this.#start(person);
      }
    } catch (error) {
      this.#deps.logger.warn(
        'A finished turn could not be added to the past-chat search index. It will be added later.',
        {
          err: error instanceof Error ? error.message : String(error),
          turn_id: input.turn_id,
        },
      );
      await this.#requestQuietly(person);
    }
  }

  /**
   * Asks for a pass over the person's chats. Called before the switch is saved as on, so a save
   * that fails leaves only a request the pass drops once it sees the switch off.
   */
  async requestPass(person: ChatSearchPerson): Promise<void> {
    await requestChatSearchBackfill({ globalSettingsStore: this.#deps.globalSettingsStore, person });
  }

  /**
   * Follows the saved switch: on runs the requested pass, off removes the person's rows and
   * pending work. Every follow bumps the person's switch generation, so work started under
   * an older setting stops at its next write instead of finishing the old plan, and a pass
   * that was told to forget can never drop the work of a newer switch-on.
   */
  async followSwitch(input: ChatSearchPerson & { enabled: boolean }): Promise<void> {
    const person = { tenant_id: input.tenant_id, created_by: input.created_by };
    await this.#bumpGeneration(person);
    if (input.enabled) {
      // The request that turned the switch on normally asked for a pass first, but make
      // sure one is pending for this generation even when it did not.
      const key = personKey(person);
      await updatePending(this.#deps.globalSettingsStore, pending =>
        pending[key] === undefined ? { ...pending, [key]: randomUUID() } : undefined,
      );
      this.#start(person);
      return;
    }
    await this.#forget(person);
  }

  /** Starts every pass still pending: at boot, after an import, or after a failed write. Never rejects. */
  async resumePending(): Promise<void> {
    try {
      const { pending } = await readPending(this.#deps.globalSettingsStore);
      for (const key of Object.keys(pending)) {
        const person = personFromKey(key);
        if (person !== undefined) {
          this.#start(person);
        }
      }
    } catch (error) {
      this.#deps.logger.warn('Past-chat search could not read its pending work. It will try again on the next start.', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Resolves once every pass started in this process has stopped. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.all(this.#running.values());
    }
  }

  #start(person: ChatSearchPerson): void {
    const key = personKey(person);
    if (this.#running.has(key)) {
      return;
    }
    const run = this.#backfill(person)
      .catch((error: unknown) => {
        this.#deps.logger.warn('The past-chat search pass stopped early. It will try again on the next start.', {
          err: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#running.delete(key);
      });
    this.#running.set(key, run);
  }

  async #backfill(person: ChatSearchPerson): Promise<void> {
    const key = personKey(person);
    for (;;) {
      const token = (await readPending(this.#deps.globalSettingsStore)).pending[key];
      if (token === undefined) {
        return;
      }
      const state = await this.#switchState(person);
      if (!state.enabled) {
        // The switch is off: drop only the request this pass started with. A request
        // made while this pass ran belongs to a newer switch-on and stays.
        const dropped = await updatePending(this.#deps.globalSettingsStore, pending =>
          pending[key] === token ? withoutPerson(pending, key) : undefined,
        );
        if (dropped) {
          await this.#deps.globalSettingsStore.deleteSetting({ key: cursorKey(person) });
        }
        const now = await this.#switchState(person);
        if (now.enabled && (await readPending(this.#deps.globalSettingsStore)).pending[key] !== undefined) {
          continue;
        }
        return;
      }
      const walked = await this.#walkChats(person, state.generation);
      if (walked === 'stale') {
        // The switch changed under this pass: start over from the state that is saved now.
        continue;
      }
      if (walked === 'off') {
        continue;
      }
      const finished = await updatePending(this.#deps.globalSettingsStore, pending =>
        pending[key] === token ? withoutPerson(pending, key) : undefined,
      );
      await this.#deps.globalSettingsStore.deleteSetting({ key: cursorKey(person) });
      if (finished) {
        return;
      }
      // Asked again while this pass ran: walk once more from the first chat.
    }
  }

  /**
   * Walks the person's chats from the saved page onward. The switch generation is checked
   * again before every write, so a pass never writes for a setting that has moved on:
   * 'off' when the switch is off in this generation, 'stale' when the generation changed.
   */
  async #walkChats(person: ChatSearchPerson, generation: number): Promise<'completed' | 'off' | 'stale'> {
    for (;;) {
      const state = await this.#switchState(person);
      if (!state.enabled) {
        return state.generation === generation ? 'off' : 'stale';
      }
      if (state.generation !== generation) {
        return 'stale';
      }
      const saved = await this.#deps.globalSettingsStore.getSetting({ key: cursorKey(person) });
      const page = await this.#deps.sessionStore.listSessions({
        tenant_id: person.tenant_id,
        limit: BACKFILL_PAGE_SIZE,
        page_token: saved?.value,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        folder_id: undefined,
        no_folder: false,
        created_by_or_agent_ids: { created_by_subject_id: person.created_by, agent_ids: [] },
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      for (const session of page.data) {
        const written = await this.#writeSessionTurns({
          tenant_id: person.tenant_id,
          session_id: session.session_id,
          generation,
          person,
        });
        if (written === 'stale') {
          return 'stale';
        }
        if (written === 'off') {
          const now = await this.#switchState(person);
          return now.generation === generation ? 'off' : 'stale';
        }
      }
      const next = page.pagination.next_page_token;
      if (next === undefined) {
        const end = await this.#switchState(person);
        if (!end.enabled) {
          return end.generation === generation ? 'off' : 'stale';
        }
        return end.generation === generation ? 'completed' : 'stale';
      }
      await this.#deps.globalSettingsStore.setSetting({ key: cursorKey(person), value: next });
    }
  }

  async #writeSessionTurns(input: {
    tenant_id: string;
    session_id: string;
    generation: number;
    person: ChatSearchPerson;
  }): Promise<'written' | 'off' | 'stale'> {
    const activations = await this.#activationsFor(input);
    let pageToken: string | undefined;
    for (;;) {
      const page = await this.#deps.sessionStore.listTurns({
        session_id: input.session_id,
        limit: BACKFILL_PAGE_SIZE,
        page_token: pageToken,
      });
      for (const turn of page.data) {
        if (turn.state.status !== 'running') {
          const written = await this.#writeTurn({
            tenant_id: input.tenant_id,
            turn,
            generation: input.generation,
            activations,
            person: input.person,
          });
          if (written !== 'written') {
            return written;
          }
        }
      }
      pageToken = page.pagination.next_page_token;
      if (pageToken === undefined) {
        return 'written';
      }
    }
  }

  /**
   * Writes one turn, after checking the switch one last time for this write. A turn whose
   * persona cannot be decided is cleared from the index instead of being guessed. When the
   * switch changed while the write ran, the write is taken back, since the clear may have
   * run first; the live path and the pass both write through here, so both are covered.
   */
  async #writeTurn(input: {
    tenant_id: string;
    turn: TurnRecordWithoutSnapshot<TurnCustom>;
    generation: number;
    activations?: PersonaActivation[];
    person: ChatSearchPerson;
  }): Promise<'written' | 'off' | 'stale'> {
    const { turn } = input;
    const state = await this.#switchState(input.person);
    if (!state.enabled) {
      return 'off';
    }
    if (state.generation !== input.generation) {
      return 'stale';
    }
    const activations =
      input.activations ?? (await this.#activationsFor({ tenant_id: input.tenant_id, session_id: turn.session_id }));
    const decision = await this.#personaDecisionOf({ tenant_id: input.tenant_id, turn, activations });
    await this.#deps.sessionStore.indexChatMessages({
      tenant_id: input.tenant_id,
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      persona_id: decision.decided ? decision.persona_id : null,
      documents: decision.decided ? chatSearchDocumentsForTurn(turn) : [],
    });
    const after = await this.#switchState(input.person);
    if (after.enabled && after.generation === input.generation) {
      return 'written';
    }
    await this.#deps.sessionStore.indexChatMessages({
      tenant_id: input.tenant_id,
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      persona_id: null,
      documents: [],
    });
    return after.generation === input.generation ? 'off' : 'stale';
  }

  async #activationsFor(input: { tenant_id: string; session_id: string }): Promise<PersonaActivation[]> {
    return await this.#deps.personaStore.listSessionPersonaActivations({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      limit: 1000,
    });
  }

  /**
   * The persona that answered the turn, following the same inheritance the turn resolver
   * uses: the turn's own snapshot first, then its recorded activation, then the decision
   * inherited from earlier turns in its own chain (a later manual choice made before this
   * turn wins over an earlier turn's snapshot), then a manual choice made before the turn
   * with no earlier turn to inherit from. A chat that never had any persona choice before
   * the turn is the main assistant's. Anything else cannot be decided and is left out.
   */
  async #personaDecisionOf(input: {
    tenant_id: string;
    turn: TurnRecordWithoutSnapshot<TurnCustom>;
    activations: PersonaActivation[];
  }): Promise<PersonaDecision> {
    const { turn, activations } = input;
    const snapshot = turn.custom?.persona;
    if (snapshot !== undefined) {
      return { decided: true, persona_id: snapshot?.persona_id ?? null };
    }
    const exact = activations.find(activation => activation.turn_id === turn.turn_id);
    if (exact !== undefined) {
      return { decided: true, persona_id: exact.persona_id };
    }
    const manualId = turn.custom?.manual_persona_activation_id;
    const ownManual =
      manualId === undefined || manualId === null
        ? undefined
        : activations.find(activation => activation.id === manualId);
    const turnTime = turn.created_at.getTime();
    const visited = new Set<string>([turn.turn_id]);
    let parentId = turn.previous_turn_id;
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = await this.#deps.sessionStore.getTurn({ session_id: turn.session_id, turn_id: parentId });
      if (parent === undefined) {
        break;
      }
      const parentSnapshot = parent.custom?.persona;
      const parentExact =
        parentSnapshot === undefined
          ? activations.find(activation => activation.turn_id === parent.turn_id)
          : undefined;
      if (parentSnapshot !== undefined || parentExact !== undefined) {
        const inherited: PersonaDecision = {
          decided: true,
          persona_id:
            parentSnapshot !== undefined ? (parentSnapshot?.persona_id ?? null) : (parentExact?.persona_id ?? null),
        };
        if (ownManual !== undefined && ownManual.id !== (parent.custom?.manual_persona_activation_id ?? null)) {
          return { decided: true, persona_id: ownManual.persona_id };
        }
        const parentTime = parent.created_at.getTime();
        const manualBetween = activations.find(
          activation =>
            activation.turn_id === null &&
            activationTime(activation) >= parentTime &&
            activationTime(activation) <= turnTime,
        );
        return manualBetween === undefined ? inherited : { decided: true, persona_id: manualBetween.persona_id };
      }
      parentId = parent.previous_turn_id;
    }
    if (ownManual !== undefined) {
      return { decided: true, persona_id: ownManual.persona_id };
    }
    const manualBefore = activations.find(
      activation => activation.turn_id === null && activationTime(activation) <= turnTime,
    );
    if (manualBefore !== undefined) {
      return { decided: true, persona_id: manualBefore.persona_id };
    }
    const anyBefore = activations.some(activation => activationTime(activation) <= turnTime);
    return anyBefore ? { decided: false } : { decided: true, persona_id: null };
  }

  /** Reads the switch and its generation. A failed read throws, so a passing outage never clears anyone's index. */
  async #switchState(person: ChatSearchPerson): Promise<ChatSearchSwitchState> {
    const settings = await this.#deps.sentinelSettingsStore.get({
      tenant_id: person.tenant_id,
      created_by: person.created_by,
    });
    const row = await this.#deps.globalSettingsStore.getSetting({ key: generationKey(person) });
    const generation = row === undefined ? 0 : Number.parseInt(row.value, 10);
    return {
      enabled: settings.chat_search_enabled,
      generation: Number.isNaN(generation) ? 0 : generation,
    };
  }

  /** Moves the person's switch generation forward by one, with compare-and-set retries. */
  async #bumpGeneration(person: ChatSearchPerson): Promise<void> {
    const key = generationKey(person);
    for (;;) {
      const row = await this.#deps.globalSettingsStore.getSetting({ key });
      const current = row === undefined ? 0 : Number.parseInt(row.value, 10);
      const next = (Number.isNaN(current) ? 0 : current) + 1;
      if (
        await this.#deps.globalSettingsStore.compareAndSetSetting({
          key,
          expected: row?.value ?? null,
          value: String(next),
        })
      ) {
        return;
      }
    }
  }

  async #forget(person: ChatSearchPerson): Promise<void> {
    const key = personKey(person);
    await updatePending(this.#deps.globalSettingsStore, pending => {
      if (pending[key] === undefined) {
        return undefined;
      }
      return withoutPerson(pending, key);
    });
    await this.#deps.globalSettingsStore.deleteSetting({ key: cursorKey(person) });
    await this.#deps.sessionStore.clearChatSearchIndex({
      tenant_id: person.tenant_id,
      created_by_subject_id: person.created_by,
    });
    // A switch-on that raced this forget has the last word: ask for a fresh pass so
    // nothing it turned on is lost with the rows just cleared.
    const state = await this.#switchState(person);
    if (state.enabled) {
      await requestChatSearchBackfill({ globalSettingsStore: this.#deps.globalSettingsStore, person });
      this.#start(person);
    }
  }

  async #requestQuietly(person: ChatSearchPerson): Promise<void> {
    try {
      await requestChatSearchBackfill({ globalSettingsStore: this.#deps.globalSettingsStore, person });
    } catch (error) {
      this.#deps.logger.warn('Past-chat search could not note a turn to add later.', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
