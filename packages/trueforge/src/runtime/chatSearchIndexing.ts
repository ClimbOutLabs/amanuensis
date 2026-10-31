import type { TurnInputItem, TurnRecordWithoutSnapshot } from '@truefoundry/trueforge-core/agent-session';
import type {
  ChatSearchDocument,
  ISessionStore,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { isAgentInputUserMessage, isFileContentPart, isHostWrappedText } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { TENANT_ID } from '../tenancy';

/**
 * What counts as searchable text in one finished turn: the words the person typed and the
 * assistant's final reply. Tool calls, tool output, attachments and text the host wrapped
 * around a message stay out. This is the one place that decides it; the live indexer, the
 * backfill and the import rebuild all read turns through here.
 */
export function chatSearchDocumentsForTurn(turn: TurnRecordWithoutSnapshot): ChatSearchDocument[] {
  const documents: ChatSearchDocument[] = [];
  const userText = turn.input
    .filter(isAgentInputUserMessage)
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter(part => !isFileContentPart(part))
            .map(part => part.text)
            .filter(text => !isHostWrappedText(text))
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

/** Writes one finished turn into the search index. A failure is logged, never thrown: indexing must not fail a turn. */
export async function indexChatTurn(deps: {
  sessionStore: ISessionStore;
  tenant_id: string;
  turn: TurnRecordWithoutSnapshot;
  logger: Logger;
}): Promise<void> {
  try {
    await deps.sessionStore.indexChatMessages({
      tenant_id: deps.tenant_id,
      session_id: deps.turn.session_id,
      turn_id: deps.turn.turn_id,
      documents: chatSearchDocumentsForTurn(deps.turn),
    });
  } catch (error) {
    deps.logger.warn(
      { err: error instanceof Error ? error.message : String(error), turn_id: deps.turn.turn_id },
      'A finished turn could not be added to the past-chat search index.',
    );
  }
}

const BACKFILL_CURSOR_KEY = 'chat_search_backfill_cursor';
const BACKFILL_DONE_KEY = 'chat_search_backfill_done';
const BACKFILL_PAGE_SIZE = 50;

export interface ChatSearchBackfillResult {
  sessions_scanned: number;
  turns_indexed: number;
  /** True when every chat has been walked and there is nothing left to do. */
  done: boolean;
}

/**
 * Fills the search index for chats that already exist. A resumable job, not a migration:
 * the extraction rules above live in code shared with the live indexer, and a stopped run
 * picks up from the page token kept in the global settings. Each turn's write replaces
 * that turn's documents, so re-running a page is harmless. Live indexing and imports keep
 * the index current afterwards; this job only covers what was already there.
 */
export async function runChatSearchBackfill(deps: {
  sessionStore: ISessionStore;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<ChatSearchBackfillResult> {
  const done = await deps.globalSettingsStore.getSetting({ key: BACKFILL_DONE_KEY });
  if (done?.value === 'true') {
    return { sessions_scanned: 0, turns_indexed: 0, done: true };
  }
  const savedCursor = await deps.globalSettingsStore.getSetting({ key: BACKFILL_CURSOR_KEY });
  let pageToken: string | null = savedCursor?.value ?? null;
  let sessionsScanned = 0;
  let turnsIndexed = 0;
  for (;;) {
    const page = await deps.sessionStore.listSessions({
      tenant_id: TENANT_ID,
      limit: BACKFILL_PAGE_SIZE,
      page_token: pageToken,
      order: 'asc',
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      folder_id: undefined,
      no_folder: false,
      created_by_or_agent_ids: undefined,
    });
    for (const session of page.data) {
      sessionsScanned += 1;
      turnsIndexed += await indexSessionTurns(deps, session.session_id);
    }
    const nextPageToken = page.pagination.next_page_token;
    if (nextPageToken === undefined) {
      break;
    }
    pageToken = nextPageToken;
    await deps.globalSettingsStore.setSetting({ key: BACKFILL_CURSOR_KEY, value: pageToken });
  }
  await deps.globalSettingsStore.setSetting({ key: BACKFILL_DONE_KEY, value: 'true' });
  await deps.globalSettingsStore.deleteSetting({ key: BACKFILL_CURSOR_KEY });
  deps.logger.info(
    { sessions_scanned: sessionsScanned, turns_indexed: turnsIndexed },
    'Past-chat search backfill finished.',
  );
  return { sessions_scanned: sessionsScanned, turns_indexed: turnsIndexed, done: true };
}

/** Indexes every finished turn of one chat. Shared by the backfill; imports rebuild through the same path per restored turn instead. */
async function indexSessionTurns(
  deps: { sessionStore: ISessionStore; logger: Logger },
  sessionId: string,
): Promise<number> {
  let indexed = 0;
  let pageToken: string | null = null;
  for (;;) {
    const page = await deps.sessionStore.listTurns({ session_id: sessionId, limit: BACKFILL_PAGE_SIZE, page_token: pageToken });
    for (const turn of page.data) {
      if (turn.state.status === 'running') {
        continue;
      }
      await indexChatTurn({ sessionStore: deps.sessionStore, tenant_id: TENANT_ID, turn, logger: deps.logger });
      indexed += 1;
    }
    const nextPageToken = page.pagination.next_page_token;
    if (nextPageToken === undefined) {
      break;
    }
    pageToken = nextPageToken;
  }
  return indexed;
}

/**
 * Starts the backfill without waiting for it and never throws: a failure is logged and
 * the next start tries again from the saved page token.
 */
export function startChatSearchBackfill(deps: {
  sessionStore: ISessionStore;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): void {
  void runChatSearchBackfill(deps).catch((error: unknown) => {
    deps.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'The past-chat search backfill stopped early. It will try again on the next start.',
    );
  });
}
