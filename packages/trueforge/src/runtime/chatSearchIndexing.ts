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
  personaStore: Pick<IPersonaStore, 'getTurnPersonaActivation'>;
  logger: Logger;
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
      if (!(await this.#enabled(person))) {
        return;
      }
      const turn = await this.#deps.sessionStore.getTurn({ session_id: input.session_id, turn_id: input.turn_id });
      if (turn === undefined || turn.state.status === 'running') {
        return;
      }
      await this.#writeTurn({ tenant_id: input.tenant_id, turn });
      // The switch went off while this write ran: take the write back, since the clear may have run first.
      if (!(await this.#enabled(person))) {
        await this.#deps.sessionStore.indexChatMessages({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          turn_id: input.turn_id,
          persona_id: null,
          documents: [],
        });
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

  /** Follows the saved switch: on runs the requested pass, off removes the person's rows and pending work. */
  async followSwitch(input: ChatSearchPerson & { enabled: boolean }): Promise<void> {
    const person = { tenant_id: input.tenant_id, created_by: input.created_by };
    if (input.enabled) {
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
      if (!(await this.#walkChats(person))) {
        await this.#forget(person);
        return;
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

  /** Walks the person's chats from the saved page onward; false when the switch is off. */
  async #walkChats(person: ChatSearchPerson): Promise<boolean> {
    for (;;) {
      if (!(await this.#enabled(person))) {
        return false;
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
        await this.#writeSessionTurns({ tenant_id: person.tenant_id, session_id: session.session_id });
      }
      const next = page.pagination.next_page_token;
      if (next === undefined) {
        return this.#enabled(person);
      }
      await this.#deps.globalSettingsStore.setSetting({ key: cursorKey(person), value: next });
    }
  }

  async #writeSessionTurns(input: { tenant_id: string; session_id: string }): Promise<void> {
    let pageToken: string | undefined;
    for (;;) {
      const page = await this.#deps.sessionStore.listTurns({
        session_id: input.session_id,
        limit: BACKFILL_PAGE_SIZE,
        page_token: pageToken,
      });
      for (const turn of page.data) {
        if (turn.state.status !== 'running') {
          await this.#writeTurn({ tenant_id: input.tenant_id, turn });
        }
      }
      pageToken = page.pagination.next_page_token;
      if (pageToken === undefined) {
        return;
      }
    }
  }

  async #writeTurn(input: { tenant_id: string; turn: TurnRecordWithoutSnapshot<TurnCustom> }): Promise<void> {
    const { turn } = input;
    await this.#deps.sessionStore.indexChatMessages({
      tenant_id: input.tenant_id,
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      persona_id: await this.#personaIdOf(input),
      documents: chatSearchDocumentsForTurn(turn),
    });
  }

  /** The persona that answered the turn, or null for the main assistant. Older turns kept it only in the activation log. */
  async #personaIdOf(input: {
    tenant_id: string;
    turn: TurnRecordWithoutSnapshot<TurnCustom>;
  }): Promise<string | null> {
    const snapshot = input.turn.custom?.persona;
    if (snapshot !== undefined) {
      return snapshot?.persona_id ?? null;
    }
    const activation = await this.#deps.personaStore.getTurnPersonaActivation({
      tenant_id: input.tenant_id,
      session_id: input.turn.session_id,
      turn_id: input.turn.turn_id,
    });
    return activation?.persona_id ?? null;
  }

  /** Reads the switch. A failed read throws, so a passing outage never clears anyone's index. */
  async #enabled(person: ChatSearchPerson): Promise<boolean> {
    const settings = await this.#deps.sentinelSettingsStore.get({
      tenant_id: person.tenant_id,
      created_by: person.created_by,
    });
    return settings.chat_search_enabled;
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
