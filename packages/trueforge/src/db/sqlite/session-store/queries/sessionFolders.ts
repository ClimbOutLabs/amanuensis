import type { SessionFolderRecord } from '@truefoundry/trueforge-core/agent-session';
import type {
  CreateSessionFolderInput,
  DeleteSessionFolderInput,
  GetSessionFolderInput,
  ListSessionFoldersInput,
  SetSessionFolderInput,
  UpdateSessionFolderInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  SessionFolderNotFoundError,
  SessionNotFoundError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import { sql, type Kysely } from 'kysely';
import { nowIso } from '../../sqlExpressions';
import type { Database } from '../../types';

function toRecord(row: {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  created_at: string;
  updated_at: string;
}): SessionFolderRecord {
  return {
    tenant_id: row.tenant_id,
    folder_id: row.id,
    created_by: row.created_by,
    name: row.name,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createSessionFolder(
  db: Kysely<Database>,
  input: CreateSessionFolderInput,
): Promise<SessionFolderRecord> {
  const timestamp = nowIso();
  const row = await db
    .insertInto('session_folder')
    .values({
      id: input.folder_id,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      name: input.name,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export async function getSessionFolder(
  db: Kysely<Database>,
  input: GetSessionFolderInput,
): Promise<SessionFolderRecord | undefined> {
  const row = await db
    .selectFrom('session_folder')
    .selectAll()
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .where('id', '=', input.folder_id)
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row);
}

export async function listSessionFolders(
  db: Kysely<Database>,
  input: ListSessionFoldersInput,
): Promise<SessionFolderRecord[]> {
  const rows = await db
    .selectFrom('session_folder')
    .selectAll()
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .orderBy('name', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toRecord);
}

export async function updateSessionFolder(
  db: Kysely<Database>,
  input: UpdateSessionFolderInput,
): Promise<SessionFolderRecord | undefined> {
  const row = await db
    .updateTable('session_folder')
    .set({ name: input.name, updated_at: nowIso() })
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .where('id', '=', input.folder_id)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row);
}

export async function deleteSessionFolder(db: Kysely<Database>, input: DeleteSessionFolderInput): Promise<void> {
  await db
    .deleteFrom('session_folder')
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .where('id', '=', input.folder_id)
    .execute();
}

export async function setSessionFolder(db: Kysely<Database>, input: SetSessionFolderInput): Promise<void> {
  await db.transaction().execute(async transaction => {
    const session = await transaction
      .selectFrom('session')
      .select(['session_id', sql<string>`json_extract(created_by_subject, '$.subject_id')`.as('created_by')])
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .executeTakeFirst();
    if (session?.created_by !== input.created_by) {
      throw new SessionNotFoundError(input.session_id);
    }

    if (input.folder_id !== null) {
      const folder = await getSessionFolder(transaction, {
        tenant_id: input.tenant_id,
        folder_id: input.folder_id,
        created_by: input.created_by,
      });
      if (folder === undefined) {
        throw new SessionFolderNotFoundError(input.folder_id);
      }
    }

    await transaction
      .updateTable('session')
      .set({ folder_id: input.folder_id })
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .executeTakeFirst();
  });
}
