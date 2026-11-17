import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import type { SessionCustom } from '../../db/sessionCustom';
import type { ITelegramStore } from '../../db/telegramStore';
import { TELEGRAM_METADATA_KEY } from './telegramChannel';

/**
 * Owes Telegram a copy of a message typed in the app's Telegram chat and of its answer, so both
 * sides read the same. Only a Telegram chat of the person who paired the bot is copied: no other
 * chat ever reaches Telegram. Never throws, because the turn has already started in the app.
 */
export async function queueAppTurnForTelegram(params: {
  store: Pick<ITelegramStore, 'getConnection' | 'addPendingReply'>;
  session: Pick<SessionRecord<SessionCustom>, 'tenant_id' | 'session_id' | 'created_by_subject' | 'metadata'>;
  /** The person who typed the message. */
  subjectId: string;
  turnId: string;
  logger: Logger;
}): Promise<void> {
  const { session } = params;
  if (
    session.metadata[TELEGRAM_METADATA_KEY] !== 'true' ||
    session.created_by_subject.subject_id !== params.subjectId
  ) {
    return;
  }
  try {
    const owner = { tenant_id: session.tenant_id, created_by: params.subjectId };
    const connection = await params.store.getConnection(owner);
    const chatId = connection?.paired_chat_id ?? null;
    if (connection === undefined || chatId === null) {
      return;
    }
    await params.store.addPendingReply({
      ...owner,
      connection_id: connection.id,
      session_id: session.session_id,
      turn_id: params.turnId,
      chat_id: chatId,
      origin: 'app',
    });
  } catch (error) {
    params.logger.warn('A message typed in the Telegram chat could not be queued for Telegram', {
      session_id: session.session_id,
      turn_id: params.turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
