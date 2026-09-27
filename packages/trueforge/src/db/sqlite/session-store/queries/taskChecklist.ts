import {
  parseStoredTaskChecklist,
  TaskChecklistSchema,
  type TaskChecklist,
} from '@truefoundry/trueforge-core/agent-session/schemas/taskChecklist';
import type {
  GetTaskChecklistInput,
  ReplaceTaskChecklistInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  SessionNotFoundError,
  StaleTaskChecklistError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import { sql, type Kysely } from 'kysely';
import { jsonbBind, jsonText, nowIso } from '../../sqlExpressions';
import type { Database } from '../../types';

export async function getTaskChecklist(db: Kysely<Database>, input: GetTaskChecklistInput): Promise<TaskChecklist> {
  const row = await db
    .selectFrom('session')
    .select(jsonText<TaskChecklist | null>(sql.ref('task_checklist')).as('task_checklist'))
    .where('tenant_id', '=', input.tenant_id)
    .where('session_id', '=', input.session_id)
    .executeTakeFirst();

  if (row === undefined) {
    throw new SessionNotFoundError(input.session_id);
  }
  return parseStoredTaskChecklist(row.task_checklist);
}

export async function replaceTaskChecklist(
  db: Kysely<Database>,
  input: ReplaceTaskChecklistInput,
): Promise<TaskChecklist> {
  const current = await getTaskChecklist(db, input);
  if (current.revision !== input.expected_revision) {
    throw new StaleTaskChecklistError(input.expected_revision, current);
  }
  const next = TaskChecklistSchema.parse({ revision: current.revision + 1, items: input.items });
  const result = await db
    .updateTable('session')
    .set({ task_checklist: jsonbBind(next), updated_at: nowIso(), last_activity_timestamp_ms: Date.now() })
    .where('tenant_id', '=', input.tenant_id)
    .where('session_id', '=', input.session_id)
    .where(
      sql<boolean>`task_checklist IS NULL OR json_extract(task_checklist, '$.revision') = ${input.expected_revision}`,
    )
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    const actual = await getTaskChecklist(db, input);
    throw new StaleTaskChecklistError(input.expected_revision, actual);
  }
  return next;
}
