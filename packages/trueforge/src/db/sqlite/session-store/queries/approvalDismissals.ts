import type {
  ApprovalDismissalRecord,
  ListApprovalDismissalsInput,
  RecordApprovalDismissalInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import type { Kysely } from 'kysely';
import type { Database } from '../../types';

/** Keeps the first record for a thread and tool call, so a repeat dismissal changes nothing. */
export async function recordApprovalDismissal(
  db: Kysely<Database>,
  input: RecordApprovalDismissalInput,
): Promise<void> {
  await db
    .insertInto('approval_dismissal')
    .values({
      session_id: input.session_id,
      thread_id: input.thread_id,
      tool_call_id: input.tool_call_id,
      dismissed_at: input.dismissed_at,
    })
    .onConflict(oc => oc.columns(['session_id', 'thread_id', 'tool_call_id']).doNothing())
    .execute();
}

export async function listApprovalDismissals(
  db: Kysely<Database>,
  input: ListApprovalDismissalsInput,
): Promise<ApprovalDismissalRecord[]> {
  const rows = await db
    .selectFrom('approval_dismissal')
    .select(['thread_id', 'tool_call_id', 'dismissed_at'])
    .where('session_id', '=', input.session_id)
    .orderBy('dismissed_at')
    .orderBy('thread_id')
    .orderBy('tool_call_id')
    .execute();
  return rows;
}
