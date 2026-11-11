import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';
import { APPROVAL_EXPIRY_MINUTES } from '@truefoundry/trueforge-core/core/permissions/approvalExpiry';

import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ApprovalSource, WaitingApproval } from './sources';

const CHATS_PER_PAGE = 100;
/** Most pages one pass reads, so a very busy install cannot keep a pass going for long. */
const MAX_PAGES = 10;

/**
 * Requests for someone's ok that are still open, across everyone in the tenant: a chat whose latest turn ended by
 * asking for approval. Chats are read newest first and only as far back as a request stays open. The chat's own
 * record is read, never its messages.
 */
export function sessionApprovalSource({
  sessionStore,
  tenant_id,
  now = () => new Date(),
}: {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions' | 'getTurn'>;
  tenant_id: string;
  now?: () => Date;
}): ApprovalSource {
  return {
    async listWaiting() {
      const openSince = now().getTime() - APPROVAL_EXPIRY_MINUTES * 60_000;
      const waiting: WaitingApproval[] = [];
      let page_token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const listed = await sessionStore.listSessions({
          tenant_id,
          limit: CHATS_PER_PAGE,
          page_token,
          order: 'desc',
          start_timestamp: undefined,
          end_timestamp: undefined,
          agent_id: undefined,
          folder_id: undefined,
          no_folder: false,
          include_private: false,
          created_by_or_agent_ids: undefined,
          metadata: undefined,
          source_type: undefined,
          source_id: undefined,
          // An incognito chat leaves no trace outside itself, so its waiting approvals are never raised.
        });
        let older = false;
        for (const session of listed.data) {
          if (new Date(session.updated_at).getTime() < openSince) {
            older = true;
            break;
          }
          if (session.last_turn_id === null) {
            continue;
          }
          // One read per chat, but only for chats touched within the last half hour, so the count follows how many
          // chats were in use just now, and MAX_PAGES caps it however busy the install is.
          const turn = await sessionStore.getTurn({ session_id: session.session_id, turn_id: session.last_turn_id });
          if (turn?.state.status !== 'done') {
            continue;
          }
          for (const action of turn.state.required_actions) {
            if (action.type === EventType.TOOL_APPROVAL_REQUIRED) {
              waiting.push({
                owner: { tenant_id: session.tenant_id, created_by: session.created_by_subject.subject_id },
                session_id: session.session_id,
                approval_id: action.id,
                waiting_since: new Date(action.created_at),
              });
            }
          }
        }
        page_token = listed.pagination.next_page_token;
        if (older || page_token === undefined) {
          break;
        }
      }
      return waiting;
    },
  };
}
