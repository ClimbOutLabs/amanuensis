import { LATEST_ANSWER_AT_METADATA_KEY, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import type { SessionCustom, TurnCustom } from '../db/sessionCustom';

/** The part of the session store the answer stamp needs: read the chat, then write it back. */
export type LatestAnswerSessionStore = Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession' | 'updateSession'>;

/**
 * Records on the chat's session metadata when its latest answer landed: the ISO time a turn
 * finished with a final message. The chat list compares this stamp with the time the person
 * last opened the chat in their browser and shows the unseen-answer dot while the stamp is
 * newer. The stamp is a nicety on top of a finished turn, never part of the turn itself, so
 * a failure here is logged and swallowed rather than failing work that already succeeded.
 */
export async function stampLatestAnswer(input: {
  sessionStore: LatestAnswerSessionStore;
  tenantId: string;
  sessionId: string;
  answeredAt: string;
  logger: Logger;
}): Promise<void> {
  try {
    const record = await input.sessionStore.getSession({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
    });
    if (record === undefined) {
      return;
    }
    if (record.metadata[LATEST_ANSWER_AT_METADATA_KEY] === input.answeredAt) {
      return;
    }
    await input.sessionStore.updateSession({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      agent: undefined,
      title: undefined,
      metadata: { ...record.metadata, [LATEST_ANSWER_AT_METADATA_KEY]: input.answeredAt },
    });
  } catch (error) {
    input.logger.warn('Could not stamp the latest answer time on the chat; the chat list dot may lag.', {
      session_id: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
