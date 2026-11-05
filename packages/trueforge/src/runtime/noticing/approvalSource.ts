import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';

import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ApprovalSource } from './sources';

/** Chats not touched for this long are no longer waiting on anyone. */
const RECENT_CHATS_MS = 7 * 86_400_000;
const CHATS_PER_PASS = 100;

/**
 * Approvals that are waiting: a recent chat whose latest turn ended by asking for the person's ok. The chat's own
 * record is read, never its messages.
 */
export function sessionApprovalSource({
  sessionStore,
  now = () => new Date(),
}: {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions' | 'getTurn'>;
  now?: () => Date;
}): ApprovalSource {
  return {
    async listWaiting(owner) {
      const since = new Date(now().getTime() - RECENT_CHATS_MS);
      const page = await sessionStore.listSessions({
        tenant_id: owner.tenant_id,
        limit: CHATS_PER_PASS,
        page_token: undefined,
        order: 'desc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        folder_id: undefined,
        no_folder: false,
        created_by_or_agent_ids: { created_by_subject_id: owner.created_by, agent_ids: [] },
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      const waiting = [];
      for (const session of page.data) {
        if (session.last_turn_id === null || new Date(session.updated_at).getTime() < since.getTime()) {
          continue;
        }
        const turn = await sessionStore.getTurn({ session_id: session.session_id, turn_id: session.last_turn_id });
        if (turn?.state.status === 'done' && turn.state.required_actions.length > 0) {
          waiting.push({
            session_id: session.session_id,
            turn_id: turn.turn_id,
            waiting_since: new Date(turn.state.completed_at),
          });
        }
      }
      return waiting;
    },
  };
}
