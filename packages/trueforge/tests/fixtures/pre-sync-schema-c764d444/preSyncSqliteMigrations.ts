/**
 * Generated fixture: the SQLite migration chain from commit c764d444
 * (main's tip immediately before the upstream sync, 96e0fb1f),
 * consolidated into one file so this fixture doesn't add dozens of tracked
 * files. See ../README.md for origin and regeneration.
 *
 * Do not edit by hand — regenerate from the individual migration files at
 * c764d444 if this fixture ever needs to change.
 */
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Minimal slice of src/personas/persona.ts needed by 20260827_000002_persona_name_key. */
interface PersonaContent {
  display_name: string;
  aliases: string[];
  instructions: string;
  model_name: string;
}

function personaMatchKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFKC');
}

function personaNameKeys(content: PersonaContent): string[] {
  return [content.display_name, ...content.aliases].map(personaMatchKey).filter(key => key.length > 0);
}

// ---- 20260730_000001_init.ts ----
async function up_m20260730_000001_init(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SELECT 1`.execute(trx);
  });
}

async function down_m20260730_000001_init(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SELECT 1`.execute(trx);
  });
}

// ---- 20260730_000002_session_store.ts ----
/**
 * Session-store tables for SQLite (canonical DDL owner).
 *
 * JSON payload columns are BLOB holding SQLite JSONB (via jsonb(...)).
 * Timestamps are ISO-8601 TEXT. Context order is turn_thread_context (not an array column).
 */
async function up_m20260730_000002_session_store(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE session (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_spec BLOB NOT NULL,
        title TEXT,
        last_turn_id TEXT,
        custom BLOB,
        last_activity_timestamp_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE INDEX session_list_idx
        ON session (tenant_id, created_at, session_id)
    `.execute(trx);

    await sql`
      CREATE TABLE turn (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        first_turn_id TEXT NOT NULL,
        previous_turn_id TEXT,
        ancestor_ids BLOB NOT NULL,
        input BLOB NOT NULL,
        state BLOB NOT NULL,
        checkpoint BLOB NOT NULL,
        custom BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE INDEX turn_list_idx
        ON turn (session_id, created_at, turn_id)
    `.execute(trx);

    await sql`
      CREATE TABLE turn_thread (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        checkpoint BLOB NOT NULL,
        agent_info BLOB,
        current_context_usage BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, thread_id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE TABLE turn_thread_context (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        pos INTEGER NOT NULL,
        append_id INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_id, thread_id, pos)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE INDEX turn_thread_context_append_idx
        ON turn_thread_context (session_id, thread_id, append_id)
    `.execute(trx);

    await sql`
      CREATE TABLE session_event (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, event_id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE TABLE thread_context_log (
        append_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        body BLOB NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE INDEX thread_context_log_lookup_idx
        ON thread_context_log (session_id, thread_id, append_id)
    `.execute(trx);

    await sql`
      CREATE TABLE thread_capability_state (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        key TEXT NOT NULL,
        state BLOB,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, thread_id, key)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260730_000002_session_store(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS thread_capability_state`.execute(trx);
    await sql`DROP TABLE IF EXISTS thread_context_log`.execute(trx);
    await sql`DROP TABLE IF EXISTS session_event`.execute(trx);
    await sql`DROP TABLE IF EXISTS turn_thread_context`.execute(trx);
    await sql`DROP TABLE IF EXISTS turn_thread`.execute(trx);
    await sql`DROP TABLE IF EXISTS turn`.execute(trx);
    await sql`DROP TABLE IF EXISTS session`.execute(trx);
  });
}

// ---- 20260803_000001_model_provider.ts ----
/**
 * Configured model providers for SQLite (canonical DDL owner).
 * Mirrors the Postgres `model_provider` table: manifest is BLOB SQLite JSONB
 * (via jsonb(...)), timestamps are ISO-8601 TEXT.
 */
async function up_m20260803_000001_model_provider(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE model_provider (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        manifest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260803_000001_model_provider(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS model_provider`.execute(trx);
  });
}

// ---- 20260807_000001_mcp_oauth.ts ----
/**
 * MCP Dynamic Client Registration (RFC 7591) tables for SQLite — mirrors
 * db/postgres/migrations/20260803_000001_mcp_oauth.ts, including the `mcp_server.id`
 * FK target (application-generated ulid) for the two child tables.
 */
async function up_m20260807_000001_mcp_oauth(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE mcp_server (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        manifest BLOB NOT NULL,
        oauth_server BLOB,
        oauth_client BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE UNIQUE INDEX mcp_server_tenant_name_idx
        ON mcp_server (tenant_id, name)
    `.execute(trx);

    await sql`
      CREATE TABLE oauth_token (
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        token BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (oauth_server_id)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE TABLE oauth_pending_authorization (
        id TEXT NOT NULL,
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        auth_data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260807_000001_mcp_oauth(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS oauth_pending_authorization`.execute(trx);
    await sql`DROP TABLE IF EXISTS oauth_token`.execute(trx);
    await sql`DROP TABLE IF EXISTS mcp_server`.execute(trx);
  });
}

// ---- 20260808_000001_skill.ts ----
/**
 * Configured skills for SQLite (canonical DDL owner).
 * Mirrors the Postgres `skill` table: manifest is BLOB SQLite JSONB
 * (via jsonb(...)), timestamps are ISO-8601 TEXT.
 */
async function up_m20260808_000001_skill(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE skill (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        manifest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260808_000001_skill(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS skill`.execute(trx);
  });
}

// ---- 20260809_000001_sandbox_provider.ts ----
/**
 * Configured sandbox provider (canonical DDL owner).
 *
 * Singleton per tenant: PK is `tenant_id` only. Manifest is BLOB JSONB.
 */
async function up_m20260809_000001_sandbox_provider(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE sandbox_provider (
        tenant_id TEXT NOT NULL,
        manifest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260809_000001_sandbox_provider(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS sandbox_provider`.execute(trx);
  });
}

// ---- 20260810_000001_agent.ts ----
/**
 * Agent registry + session agent binding for SQLite.
 *
 * - `agent`: mirrors Postgres (manifest is BLOB SQLite JSONB; timestamps ISO TEXT).
 * - `session`: agent_id XOR agent_spec. STRICT cannot drop NOT NULL in place —
 *   rebuild the session table. Child rows keep matching session_id values.
 *
 * `DROP TABLE session` needs FKs off (`turn` etc. still REFERENCES it).
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so toggle it around the
 * txn (Kysely Migrator does not wrap SQLite migrations — see kysely#56).
 */
async function up_m20260810_000001_agent(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE agent (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          manifest BLOB NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id),
          UNIQUE (tenant_id, name)
        ) STRICT
      `.execute(trx);

      await sql`
        CREATE TABLE session_new (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_id TEXT,
          agent_spec BLOB,
          title TEXT,
          last_turn_id TEXT,
          custom BLOB,
          last_activity_timestamp_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id),
          CHECK (
            (agent_id IS NOT NULL AND agent_spec IS NULL)
            OR (agent_id IS NULL AND agent_spec IS NOT NULL)
          )
        ) STRICT
      `.execute(trx);

      await sql`
        INSERT INTO session_new (
          tenant_id,
          session_id,
          agent_id,
          agent_spec,
          title,
          last_turn_id,
          custom,
          last_activity_timestamp_ms,
          created_at,
          updated_at
        )
        SELECT
          tenant_id,
          session_id,
          NULL,
          agent_spec,
          title,
          last_turn_id,
          custom,
          last_activity_timestamp_ms,
          created_at,
          updated_at
        FROM session
      `.execute(trx);

      await sql`DROP TABLE session`.execute(trx);
      await sql`ALTER TABLE session_new RENAME TO session`.execute(trx);

      await sql`
        CREATE INDEX session_list_idx
          ON session (tenant_id, created_at, session_id)
      `.execute(trx);

      await sql`
        CREATE INDEX session_agent_id_idx
          ON session (tenant_id, agent_id)
          WHERE agent_id IS NOT NULL
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

async function down_m20260810_000001_agent(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`DELETE FROM session WHERE agent_spec IS NULL`.execute(trx);

      await sql`
        CREATE TABLE session_old (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_spec BLOB NOT NULL,
          title TEXT,
          last_turn_id TEXT,
          custom BLOB,
          last_activity_timestamp_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id)
        ) STRICT
      `.execute(trx);

      await sql`
        INSERT INTO session_old (
          tenant_id,
          session_id,
          agent_spec,
          title,
          last_turn_id,
          custom,
          last_activity_timestamp_ms,
          created_at,
          updated_at
        )
        SELECT
          tenant_id,
          session_id,
          agent_spec,
          title,
          last_turn_id,
          custom,
          last_activity_timestamp_ms,
          created_at,
          updated_at
        FROM session
      `.execute(trx);

      await sql`DROP TABLE session`.execute(trx);
      await sql`ALTER TABLE session_old RENAME TO session`.execute(trx);

      await sql`
        CREATE INDEX session_list_idx
          ON session (tenant_id, created_at, session_id)
      `.execute(trx);

      await sql`DROP TABLE IF EXISTS agent`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

// ---- 20260811_000001_session_created_by.ts ----
/** Add immutable `created_by` identity on session. */
async function up_m20260811_000001_session_created_by(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN created_by TEXT NOT NULL DEFAULT ''
    `.execute(trx);
  });
}

async function down_m20260811_000001_session_created_by(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260811_000001_session_created_by is not reversible'));
}

// ---- 20260812_000001_session_agent_name.ts ----
/**
 * Create-time snapshot of registry agent name on named sessions.
 * Backfills from `agent.name` where `session.agent_id` still resolves;
 * orphan refs stay NULL.
 */
async function up_m20260812_000001_session_agent_name(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN agent_name TEXT
    `.execute(trx);
    await sql`
      UPDATE session
      SET agent_name = (
        SELECT a.name
        FROM agent AS a
        WHERE a.id = session.agent_id
          AND a.tenant_id = session.tenant_id
      )
      WHERE agent_id IS NOT NULL
    `.execute(trx);
  });
}

async function down_m20260812_000001_session_agent_name(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260812_000001_session_agent_name is not reversible'));
}

// ---- 20260813_000001_mcp_oauth_user_scoped.ts ----
/**
 * Scope MCP OAuth access/refresh tokens per harness user, and stamp `user_id` on
 * pending authorizations so the public callback can write the correct token row.
 * Drops previously shared (server-only) tokens — callers must re-authorize.
 *
 * SQLite cannot alter primary keys in place, so the token/pending tables are
 * rebuilt (empty after the deletes below). Mirrors
 * db/postgres/migrations/20260813_000001_mcp_oauth_user_scoped.ts.
 *
 * Wrapped in a transaction so drop/create pairs roll back together. SQLite has
 * no LOCK TABLE / ACCESS EXCLUSIVE; a no-op UPDATE before each delete escalates
 * the deferred txn to a RESERVED write lock so concurrent connections cannot
 * insert until this migration commits.
 */
async function up_m20260813_000001_mcp_oauth_user_scoped(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    // Escalate deferred txn → RESERVED (writer lock) before clearing the table.
    await sql`UPDATE oauth_token SET updated_at = updated_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_token`.execute(trx);
    await sql`DROP TABLE oauth_token`.execute(trx);
    await sql`
      CREATE TABLE oauth_token (
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        token BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT oauth_token_pkey PRIMARY KEY (oauth_server_id, user_id)
      ) STRICT
    `.execute(trx);

    // In-flight pending rows cannot be attributed to a user; drop them.
    await sql`UPDATE oauth_pending_authorization SET created_at = created_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_pending_authorization`.execute(trx);
    await sql`DROP TABLE oauth_pending_authorization`.execute(trx);
    await sql`
      CREATE TABLE oauth_pending_authorization (
        id TEXT NOT NULL,
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        auth_data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        CONSTRAINT oauth_pending_authorization_pkey PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260813_000001_mcp_oauth_user_scoped(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`UPDATE oauth_pending_authorization SET created_at = created_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_pending_authorization`.execute(trx);
    await sql`DROP TABLE oauth_pending_authorization`.execute(trx);
    await sql`
      CREATE TABLE oauth_pending_authorization (
        id TEXT NOT NULL,
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        auth_data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        CONSTRAINT oauth_pending_authorization_pkey PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    await sql`UPDATE oauth_token SET updated_at = updated_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_token`.execute(trx);
    await sql`DROP TABLE oauth_token`.execute(trx);
    await sql`
      CREATE TABLE oauth_token (
        oauth_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
        token BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT oauth_token_pkey PRIMARY KEY (oauth_server_id)
      ) STRICT
    `.execute(trx);
  });
}

// ---- 20260814_000001_session_list_updated_at_idx.ts ----
/**
 * listSessions orders by `updated_at` (session_id tie-break). Keep
 * `session_list_idx` on `created_at` for start/end timestamp filters.
 */
async function up_m20260814_000001_session_list_updated_at_idx(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE INDEX session_list_updated_at_idx
        ON session (tenant_id, updated_at, session_id)
    `.execute(trx);
  });
}

async function down_m20260814_000001_session_list_updated_at_idx(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX session_list_updated_at_idx`.execute(trx);
  });
}

// ---- 20260815_000001_sandbox_provider_status.ts ----
/**
 * Persist the release sandbox image build status alongside the provider config.
 * `build_metadata` is nullable opaque jsonb (build_ref + image_uri when present).
 *
 * `status` keeps the 'pending' default here: SQLite cannot drop a column default
 * without rebuilding the table, and it is harmless because every upsert writes
 * status explicitly (Postgres drops the default after backfill).
 *
 * Existing rows already have an active snapshot named in the legacy
 * `manifest.snapshot_name`; backfill them as ready with that name as build_ref.
 * The image_uri is captured as the release image at the time of this migration.
 */
const RELEASE_IMAGE_URI =
  'tfy.jfrog.io/tfy-images/truefoundry-utils-core-sandbox:029ea5ff6438cf86b79282e087bfc17528067946';

async function up_m20260815_000001_sandbox_provider_status(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE sandbox_provider ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`.execute(trx);
    await sql`ALTER TABLE sandbox_provider ADD COLUMN status_reason TEXT`.execute(trx);
    // Nullable: SQLite forbids non-constant DEFAULTs on ADD COLUMN when rows exist.
    await sql`ALTER TABLE sandbox_provider ADD COLUMN build_metadata BLOB`.execute(trx);

    await sql`
      UPDATE sandbox_provider
      SET status = 'ready',
          build_metadata = jsonb(json_object(
            'build_ref', json_extract(json(manifest), '$.snapshot_name'),
            'image_uri', ${RELEASE_IMAGE_URI}
          ))
      WHERE json_extract(json(manifest), '$.snapshot_name') IS NOT NULL
    `.execute(trx);
  });
}

async function down_m20260815_000001_sandbox_provider_status(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE sandbox_provider DROP COLUMN build_metadata`.execute(trx);
    await sql`ALTER TABLE sandbox_provider DROP COLUMN status_reason`.execute(trx);
    await sql`ALTER TABLE sandbox_provider DROP COLUMN status`.execute(trx);
  });
}

// ---- 20260815_000002_mcp_server_description.ts ----
/**
 * Required `description` on `mcp_server.manifest`. Backfill `{name} MCP Server`
 * when the key is missing or blank so existing rows satisfy McpServerManifestSchema.
 * Mirrors db/postgres/migrations/20260815_000002_mcp_server_description.ts.
 */
async function up_m20260815_000002_mcp_server_description(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE mcp_server
    SET manifest = jsonb_set(manifest, '$.description', jsonb(json_quote(name || ' MCP Server')))
    WHERE trim(coalesce(json_extract(manifest, '$.description'), '')) = ''
  `.execute(db);
}

async function down_m20260815_000002_mcp_server_description(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE mcp_server
    SET manifest = jsonb_remove(manifest, '$.description')
    WHERE json_extract(manifest, '$.description') = name || ' MCP Server'
  `.execute(db);
}

// ---- 20260818_000001_mcp_pending_auth_return_to.ts ----
/**
 * Pending-authorization `auth_data` jsonb key `redirect_url` → `return_to` (path).
 * In-flight rows are short-lived and cannot be rewritten safely; drop them so
 * callers restart authorize with the new shape.
 * Mirrors db/postgres/migrations/20260818_000001_mcp_pending_auth_return_to.ts.
 *
 * Wrapped in a transaction. SQLite has no LOCK TABLE; a no-op UPDATE escalates
 * the deferred txn to a RESERVED write lock before the delete.
 */
async function up_m20260818_000001_mcp_pending_auth_return_to(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`UPDATE oauth_pending_authorization SET created_at = created_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_pending_authorization`.execute(trx);
  });
}

async function down_m20260818_000001_mcp_pending_auth_return_to(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    // Rows written with `return_to` are incompatible with the prior shape; clear them.
    await sql`UPDATE oauth_pending_authorization SET created_at = created_at WHERE false`.execute(trx);
    await sql`DELETE FROM oauth_pending_authorization`.execute(trx);
  });
}

// ---- 20260824_000001_session_approval_grants.ts ----
/** Durable exact-tool grants created by "Allow for this chat". */
async function up_m20260824_000001_session_approval_grants(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN approval_grants TEXT NOT NULL DEFAULT '[]'
    `.execute(trx);
  });
}

async function down_m20260824_000001_session_approval_grants(db: Kysely<unknown>): Promise<void> {
  void db;
  return Promise.reject(new Error('20260824_000001_session_approval_grants is not reversible'));
}

// ---- 20260824_000010_personalization_profile.ts ----
/** Local per-user assistant/user profile. No session or conversation data is copied here. */
async function up_m20260824_000010_personalization_profile(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE personalization_profile (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        assistant_name TEXT,
        assistant_identity TEXT,
        voice_guidance TEXT,
        user_profile TEXT,
        pinned_preferences BLOB NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260824_000010_personalization_profile(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS personalization_profile`.execute(trx);
  });
}

// ---- 20260824_000020_session_approval_grants_jsonb.ts ----
/**
 * Repair the initial approval-grant migration, which declared a TEXT column
 * while the SQLite stores consistently bind JSON as JSONB BLOBs.
 */
async function up_m20260824_000020_session_approval_grants_jsonb(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE session_new (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          agent_id TEXT,
          agent_name TEXT,
          agent_spec BLOB,
          title TEXT,
          last_turn_id TEXT,
          approval_grants BLOB NOT NULL,
          custom BLOB,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_activity_timestamp_ms INTEGER NOT NULL,
          PRIMARY KEY (session_id),
          CHECK (
            (agent_id IS NOT NULL AND agent_spec IS NULL)
            OR (agent_id IS NULL AND agent_spec IS NOT NULL)
          )
        ) STRICT
      `.execute(trx);

      await sql`
        INSERT INTO session_new (
          tenant_id,
          session_id,
          created_by,
          agent_id,
          agent_name,
          agent_spec,
          title,
          last_turn_id,
          approval_grants,
          custom,
          created_at,
          updated_at,
          last_activity_timestamp_ms
        )
        SELECT
          tenant_id,
          session_id,
          created_by,
          agent_id,
          agent_name,
          agent_spec,
          title,
          last_turn_id,
          jsonb(approval_grants),
          custom,
          created_at,
          updated_at,
          last_activity_timestamp_ms
        FROM session
      `.execute(trx);

      await sql`DROP TABLE session`.execute(trx);
      await sql`ALTER TABLE session_new RENAME TO session`.execute(trx);

      await sql`
        CREATE INDEX session_list_idx
          ON session (tenant_id, created_at, session_id)
      `.execute(trx);
      await sql`
        CREATE INDEX session_list_updated_at_idx
          ON session (tenant_id, updated_at, session_id)
      `.execute(trx);
      await sql`
        CREATE INDEX session_agent_id_idx
          ON session (tenant_id, agent_id)
          WHERE agent_id IS NOT NULL
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

async function down_m20260824_000020_session_approval_grants_jsonb(db: Kysely<unknown>): Promise<void> {
  void db;
  return Promise.reject(new Error('20260824_000020_session_approval_grants_jsonb is not reversible'));
}

// ---- 20260825_000001_session_folders.ts ----
async function up_m20260825_000001_session_folders(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async transaction => {
    await sql`
      CREATE TABLE session_folder (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(transaction);
    await sql`
      CREATE INDEX session_folder_owner_name_idx
        ON session_folder (tenant_id, created_by, name, id)
    `.execute(transaction);
    await sql`
      ALTER TABLE session
        ADD COLUMN folder_id TEXT REFERENCES session_folder(id) ON DELETE SET NULL
    `.execute(transaction);
    await sql`
      CREATE INDEX session_folder_id_idx
        ON session (folder_id)
        WHERE folder_id IS NOT NULL
    `.execute(transaction);
  });
}

async function down_m20260825_000001_session_folders(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async transaction => {
    await sql`DROP INDEX IF EXISTS session_folder_id_idx`.execute(transaction);
    await sql`ALTER TABLE session DROP COLUMN folder_id`.execute(transaction);
    await sql`DROP TABLE IF EXISTS session_folder`.execute(transaction);
  });
}

// ---- 20260827_000001_persona.ts ----
/**
 * User-configured personas and the per-session log of which one answered.
 *
 * `session_persona` is append-only: its highest-`seq` row is the chat's active
 * persona, and each row carrying a `turn_id` is that turn's provenance. It is
 * not a foreign key onto `persona` — deleting a persona must not erase the
 * record of turns it already answered.
 *
 * Ordering is `seq`, not a timestamp or a ulid: two decisions can land in the
 * same millisecond, and "which persona is active" must never depend on which
 * of two same-instant rows sorted first.
 */
async function up_m20260827_000001_persona(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE persona (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aliases BLOB NOT NULL,
        instructions TEXT NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX persona_owner_idx ON persona (tenant_id, created_by, display_name)`.execute(trx);
    await sql`
      CREATE TABLE session_persona (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        turn_id TEXT,
        persona_id TEXT,
        persona_name TEXT,
        model_name TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, seq)
      ) STRICT
    `.execute(trx);
  });
}

async function down_m20260827_000001_persona(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS session_persona`.execute(trx);
    await sql`DROP TABLE IF EXISTS persona`.execute(trx);
  });
}

// ---- 20260827_000001_repository_binding.ts ----
/**
 * Historical repository-binding schema.
 *
 * Keep this migration registered permanently: deployed SQLite databases may
 * already record it as applied, even while the repository surface is absent
 * from a later application build.
 */
async function up_m20260827_000001_repository_binding(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE repository (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, created_by, name)
      ) STRICT
    `.execute(trx);
    await trx.schema.alterTable('session').addColumn('repository_id', 'text').execute();
    await sql`
      CREATE INDEX session_repository_id_idx
        ON session (tenant_id, repository_id)
        WHERE repository_id IS NOT NULL
    `.execute(trx);
  });
}

async function down_m20260827_000001_repository_binding(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX IF EXISTS session_repository_id_idx`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('repository_id').execute();
    await sql`DROP TABLE IF EXISTS repository`.execute(trx);
  });
}

// ---- 20260827_000002_persona_name_key.ts ----
interface PersonaRow {
  tenant_id: string;
  id: string;
  created_by: string;
  display_name: string;
  aliases: unknown;
}

interface NameReservation {
  tenant_id: string;
  created_by: string;
  normalized_key: string;
  persona_id: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((alias: unknown) => typeof alias === 'string');
}

function parseAliases(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error('cannot backfill persona names: persona.aliases is not valid JSON', { cause: error });
    }
  } else if (value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(value)) as unknown;
    } catch (error) {
      throw new Error('cannot backfill persona names: persona.aliases is not valid JSON', { cause: error });
    }
  }
  if (!isStringArray(parsed)) {
    throw new Error('cannot backfill persona names: persona.aliases must be an array of strings');
  }
  return parsed;
}

function buildReservations(rows: PersonaRow[]): NameReservation[] {
  const reservations = new Map<string, NameReservation>();
  const collisions = new Map<string, Set<string>>();

  for (const row of rows) {
    const keys = new Set(
      personaNameKeys({
        display_name: row.display_name,
        aliases: parseAliases(row.aliases),
        instructions: '',
        model_name: '',
      }),
    );
    if (keys.size === 0) {
      throw new Error(`cannot backfill persona names: persona ${row.id} has no usable name`);
    }
    for (const normalized_key of keys) {
      const existing = reservations.get(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`);
      if (existing !== undefined && existing.persona_id !== row.id) {
        const owners =
          collisions.get(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`) ??
          new Set([existing.persona_id]);
        owners.add(row.id);
        collisions.set(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`, owners);
        continue;
      }
      reservations.set(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`, {
        tenant_id: row.tenant_id,
        created_by: row.created_by,
        normalized_key,
        persona_id: row.id,
      });
    }
  }

  if (collisions.size > 0) {
    const details = [...collisions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, owners]) => `${key.replaceAll('\u0000', '/')}: ${[...owners].sort().join(', ')}`)
      .join('; ');
    throw new Error(`cannot backfill persona names: normalized-name collisions must be resolved first (${details})`);
  }
  return [...reservations.values()];
}

async function insertReservations(trx: Kysely<unknown>, reservations: NameReservation[]): Promise<void> {
  if (reservations.length === 0) {
    return;
  }
  await sql`
    INSERT INTO persona_name_key (tenant_id, created_by, normalized_key, persona_id)
    VALUES ${sql.join(
      reservations.map(row => sql`(${row.tenant_id}, ${row.created_by}, ${row.normalized_key}, ${row.persona_id})`),
    )}
  `.execute(trx);
}

/**
 * Completes the persona schema introduced by 000001 without editing that
 * already-applied migration. Existing names are checked in stable ID order;
 * normalized collisions abort the transaction rather than assigning ownership
 * nondeterministically or changing user data.
 */
async function up_m20260827_000002_persona_name_key(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      const result = await sql<PersonaRow>`
        SELECT tenant_id, id, created_by, display_name, json(aliases) AS aliases
        FROM persona
        ORDER BY tenant_id, created_by, id
      `.execute(trx);
      const reservations = buildReservations(result.rows);

      await sql`
        CREATE UNIQUE INDEX persona_owner_id_key
          ON persona (tenant_id, created_by, id)
      `.execute(trx);
      await sql`
        CREATE TABLE persona_name_key (
          tenant_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          normalized_key TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, created_by, normalized_key),
          FOREIGN KEY (tenant_id, created_by, persona_id)
            REFERENCES persona(tenant_id, created_by, id) ON DELETE CASCADE
        ) STRICT
      `.execute(trx);
      await insertReservations(trx, reservations);
      await sql`
        CREATE INDEX persona_name_key_persona_idx
          ON persona_name_key (tenant_id, persona_id)
      `.execute(trx);

      await sql`
        CREATE TABLE session_persona_new (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          turn_id TEXT,
          persona_id TEXT,
          persona_name TEXT,
          model_name TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, session_id, seq)
        ) STRICT
      `.execute(trx);
      await sql`
        INSERT INTO session_persona_new
          (tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at)
        SELECT tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at
        FROM session_persona
      `.execute(trx);
      await sql`DROP TABLE session_persona`.execute(trx);
      await sql`ALTER TABLE session_persona_new RENAME TO session_persona`.execute(trx);
      await sql`CREATE INDEX session_persona_session_idx ON session_persona (session_id)`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

async function down_m20260827_000002_persona_name_key(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`DROP INDEX IF EXISTS session_persona_session_idx`.execute(trx);
      await sql`
        CREATE TABLE session_persona_old (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          turn_id TEXT,
          persona_id TEXT,
          persona_name TEXT,
          model_name TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, session_id, seq)
        ) STRICT
      `.execute(trx);
      await sql`
        INSERT INTO session_persona_old
          (tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at)
        SELECT tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at
        FROM session_persona
      `.execute(trx);
      await sql`DROP TABLE session_persona`.execute(trx);
      await sql`ALTER TABLE session_persona_old RENAME TO session_persona`.execute(trx);
      await sql`DROP TABLE IF EXISTS persona_name_key`.execute(trx);
      await sql`DROP INDEX IF EXISTS persona_owner_id_key`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

// ---- 20260830_000001_repository_verification.ts ----
/**
 * Completes the historical repository binding with revisioned verification
 * metadata. Suggestions are deliberately kept in a separate table: only rows
 * in repository_verify_command are eligible for a future executor.
 */
async function up_m20260830_000001_repository_verification(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE repository
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    `.execute(trx);
    await sql`
      ALTER TABLE session
        ADD COLUMN workspace_cwd TEXT CHECK (workspace_cwd IS NULL OR length(trim(workspace_cwd)) > 0)
    `.execute(trx);

    await sql`
      CREATE TABLE repository_verify_command (
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL CHECK (length(trim(command_id)) > 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('build', 'test', 'verify')),
        command TEXT NOT NULL CHECK (length(command) > 0),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, command_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX repository_verify_command_repository_idx
        ON repository_verify_command (repository_id, purpose, command_id)
    `.execute(trx);

    await sql`
      CREATE TABLE repository_verify_command_proposal (
        id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('build', 'test', 'verify')),
        command TEXT NOT NULL CHECK (length(command) > 0),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('agents_md', 'package_json')),
        source_path TEXT NOT NULL CHECK (length(trim(source_path)) > 0),
        source_fingerprint TEXT NOT NULL CHECK (length(trim(source_fingerprint)) > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX repository_verify_command_proposal_repository_idx
        ON repository_verify_command_proposal (repository_id, created_at, id)
    `.execute(trx);
  });
}

async function down_m20260830_000001_repository_verification(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS repository_verify_command_proposal`.execute(trx);
    await sql`DROP TABLE IF EXISTS repository_verify_command`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('repository').dropColumn('revision').execute();
  });
}

// ---- 20260831_000001_task_checklist.ts ----
async function up_m20260831_000001_task_checklist(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE session ADD COLUMN task_checklist BLOB`.execute(trx);
  });
}

async function down_m20260831_000001_task_checklist(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('session').dropColumn('task_checklist').execute();
  });
}

// ---- 20260831_000002_command_execution.ts ----
/** Durable lifecycle for one registered verification command. */
async function up_m20260831_000002_command_execution(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE command_execution (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_revision INTEGER NOT NULL CHECK (repository_revision >= 0),
        command_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
        status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
        disposition TEXT CHECK (
          disposition IS NULL OR disposition IN (
            'denied',
            'policy_blocked',
            'executed_ok',
            'executed_nonzero',
            'never_ran',
            'outcome_unknown'
          )
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, turn_id, tool_call_id),
        FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
        CHECK (
          (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
          OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
        )
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX command_execution_running_idx
        ON command_execution (status, session_id, turn_id)
        WHERE status = 'running'
    `.execute(trx);
  });
}

async function down_m20260831_000002_command_execution(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS command_execution`.execute(trx);
  });
}

// ---- 20260831_000003_implementation_plan_grants.ts ----
/** Owner-scoped implementation-plan grant durability. */
async function up_m20260831_000003_implementation_plan_grants(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE implementation_plan_grant (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        grant_id TEXT NOT NULL,
        grant BLOB NOT NULL CHECK (json_valid(grant, 8) AND json_type(grant) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, grant_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX implementation_plan_grant_owner_idx
        ON implementation_plan_grant (tenant_id, created_by, session_id, grant_id)
    `.execute(trx);
  });
}

async function down_m20260831_000003_implementation_plan_grants(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS implementation_plan_grant`.execute(trx);
  });
}

// ---- 20260831_000004_implementation_plan_dispatch_fence.ts ----
/** Durable cross-replica plan dispatch boundary and checkout binding. */
async function up_m20260831_000004_implementation_plan_dispatch_fence(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN checkout_id TEXT`.execute(trx);
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN workspace_cwd TEXT`.execute(trx);
    await sql`ALTER TABLE implementation_plan_grant ADD COLUMN revoked_at TEXT`.execute(trx);
    // Grants minted before checkout identity existed are deliberately invalidated.
    await sql`
      UPDATE implementation_plan_grant
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE checkout_id IS NULL OR workspace_cwd IS NULL
    `.execute(trx);
    await sql`
      CREATE TABLE implementation_plan_dispatch (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        checkout_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'completed')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, turn_id, dispatch_id),
        FOREIGN KEY (session_id, grant_id)
          REFERENCES implementation_plan_grant(session_id, grant_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, turn_id)
          REFERENCES turn(session_id, turn_id) ON DELETE CASCADE
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX implementation_plan_dispatch_pending_idx
        ON implementation_plan_dispatch (session_id, grant_id, state)
    `.execute(trx);
  });
}

async function down_m20260831_000004_implementation_plan_dispatch_fence(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS implementation_plan_dispatch`.execute(trx);
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('revoked_at').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('checkout_id').execute();
  });
}

// ---- 20260901_000001_command_execution_repair.ts ----
const LEGACY_LEASE_EXPIRY = '1970-01-01T00:00:00.000Z';

/**
 * Converges databases that applied the original command-execution migration
 * with databases that briefly received its expanded replacement under the
 * same migration name.
 */
async function up_m20260901_000001_command_execution_repair(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      const columns = await sql<{ name: string }>`PRAGMA table_info(command_execution)`.execute(trx);
      const hasCommandExecutionTable = columns.rows.length > 0;
      const hasOwnershipColumns = columns.rows.some(column => column.name === 'owner_id');

      if (!hasOwnershipColumns) {
        await sql`
          CREATE TABLE command_execution_repaired (
            session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            repository_id TEXT NOT NULL,
            repository_revision INTEGER NOT NULL CHECK (repository_revision >= 0),
            command_id TEXT NOT NULL,
            command TEXT NOT NULL,
            cwd TEXT NOT NULL,
            timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
            status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
            disposition TEXT CHECK (
              disposition IS NULL OR disposition IN (
                'denied',
                'policy_blocked',
                'executed_ok',
                'executed_nonzero',
                'never_ran',
                'outcome_unknown'
              )
            ),
            owner_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            PRIMARY KEY (session_id, turn_id, thread_id, tool_call_id),
            UNIQUE (lease_id),
            FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
            CHECK (
              (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
              OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
            )
          ) STRICT
        `.execute(trx);
        if (hasCommandExecutionTable) {
          await sql`
            INSERT INTO command_execution_repaired (
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, owner_id, lease_id,
              lease_expires_at, started_at, completed_at
            )
            SELECT
              session_id, turn_id, thread_id, tool_call_id, tool_name,
              repository_id, repository_revision, command_id, command, cwd,
              timeout_ms, status, disposition, 'legacy-migration',
              'legacy-command-execution:' || rowid,
              ${LEGACY_LEASE_EXPIRY}, started_at, completed_at
            FROM command_execution
          `.execute(trx);
        }
        await sql`DROP INDEX IF EXISTS command_execution_running_idx`.execute(trx);
        await sql`DROP TABLE IF EXISTS command_execution`.execute(trx);
        await sql`ALTER TABLE command_execution_repaired RENAME TO command_execution`.execute(trx);
      }

      await sql`DROP INDEX IF EXISTS command_execution_running_idx`.execute(trx);
      await sql`
        CREATE INDEX command_execution_running_idx
          ON command_execution (status, owner_id, lease_expires_at)
          WHERE status = 'running'
      `.execute(trx);
      await sql`
        CREATE TABLE IF NOT EXISTS repository_workspace_verification (
          repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
          workspace_cwd TEXT NOT NULL,
          mutation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (mutation_epoch >= 0),
          lease_owner_id TEXT,
          lease_id TEXT UNIQUE,
          lease_expires_at TEXT,
          observation_pending INTEGER NOT NULL DEFAULT 0 CHECK (observation_pending IN (0, 1)),
          receipt_state_sha256 TEXT,
          receipt_command TEXT,
          receipt_created_at TEXT,
          receipt_result_session_id TEXT,
          receipt_result_turn_id TEXT,
          receipt_result_thread_id TEXT,
          receipt_result_tool_call_id TEXT,
          receipt_result_event_id TEXT,
          PRIMARY KEY (repository_id, workspace_cwd),
          CHECK (
            (lease_id IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
            OR (lease_id IS NOT NULL AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
          ),
          CHECK (
            (
              receipt_state_sha256 IS NULL AND receipt_command IS NULL AND receipt_created_at IS NULL
              AND receipt_result_session_id IS NULL AND receipt_result_turn_id IS NULL
              AND receipt_result_thread_id IS NULL AND receipt_result_tool_call_id IS NULL
              AND receipt_result_event_id IS NULL
            )
            OR (
              receipt_state_sha256 IS NOT NULL AND receipt_command IS NOT NULL AND receipt_created_at IS NOT NULL
              AND receipt_result_session_id IS NOT NULL AND receipt_result_turn_id IS NOT NULL
              AND receipt_result_thread_id IS NOT NULL AND receipt_result_tool_call_id IS NOT NULL
              AND receipt_result_event_id IS NOT NULL
            )
          )
        ) STRICT
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

/** The original three-column command key cannot represent every repaired row. */
function down_m20260901_000001_command_execution_repair(): Promise<void> {
  return Promise.reject(new Error('20260901_000001_command_execution_repair is not reversible'));
}

// ---- 20260901_000010_personalization_learned_profile.ts ----
/**
 * Host-maintained learned profile document on the personalization profile.
 * Nullable: existing rows have learned nothing yet.
 * Mirrors db/postgres/migrations/20260901_000010_personalization_learned_profile.ts.
 */
async function up_m20260901_000010_personalization_learned_profile(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN learned_profile TEXT
    `.execute(trx);
  });
}

async function down_m20260901_000010_personalization_learned_profile(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260901_000010_personalization_learned_profile is not reversible'));
}

// ---- 20260902_000010_personalization_learning_enabled.ts ----
/**
 * User switch for the learned-profile distillation pass, carried on the personalization profile.
 * Defaults to 0 so an existing profile and a fresh deployment both start with learning off.
 * Mirrors db/postgres/migrations/20260902_000010_personalization_learning_enabled.ts.
 */
async function up_m20260902_000010_personalization_learning_enabled(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN learning_enabled INTEGER NOT NULL DEFAULT 0 CHECK (learning_enabled IN (0, 1))
    `.execute(trx);
  });
}

async function down_m20260902_000010_personalization_learning_enabled(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260902_000010_personalization_learning_enabled is not reversible'));
}

// ---- 20260913_000001_space.ts ----
/** Durable spaces: a persistent, named, structured page the model creates and updates. */
async function up_m20260913_000001_space(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE space_aggregate (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE space (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        body TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX space_list_idx
      ON space (tenant_id, created_by, status, name, id)
    `.execute(trx);
  });
}

async function down_m20260913_000001_space(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE space`.execute(trx);
    await sql`DROP TABLE space_aggregate`.execute(trx);
  });
}

// ---- 20260914_000001_space_format.ts ----
/**
 * `format` on `space`: `markdown` (default) or `html`. `20260913_000001_space` already shipped
 * (build fe3d8653) without this column, so it is added here rather than edited in place.
 * Mirrors db/postgres/migrations/20260914_000001_space_format.ts.
 */
async function up_m20260914_000001_space_format(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE space
        ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html'))
    `.execute(trx);
  });
}

async function down_m20260914_000001_space_format(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260914_000001_space_format is not reversible'));
}

// ---- 20260914_000002_turn_artifact.ts ----
/**
 * Persisted sandbox-artifact bytes, copied from the sandbox once a turn finishes so a download
 * outlives the sandbox that produced it (the provider auto-stops and later deletes it).
 * `artifact_blob` is content-addressed and deduplicated by digest within a tenant; `turn_artifact`
 * is the per-turn, per-path index the download route looks up.
 */
async function up_m20260914_000002_turn_artifact(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE artifact_blob (
        tenant_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        mime TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, digest)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE turn_artifact (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('stored', 'skipped_size', 'skipped_missing')),
        digest TEXT,
        size INTEGER,
        mime TEXT,
        skip_reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, turn_id, path)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX turn_artifact_session_idx
      ON turn_artifact (tenant_id, session_id, turn_id)
    `.execute(trx);
  });
}

async function down_m20260914_000002_turn_artifact(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE turn_artifact`.execute(trx);
    await sql`DROP TABLE artifact_blob`.execute(trx);
  });
}

export const preSyncSqliteMigrations: Record<string, Migration> = {
  '20260730_000001_init': { up: up_m20260730_000001_init, down: down_m20260730_000001_init },
  '20260730_000002_session_store': { up: up_m20260730_000002_session_store, down: down_m20260730_000002_session_store },
  '20260803_000001_model_provider': {
    up: up_m20260803_000001_model_provider,
    down: down_m20260803_000001_model_provider,
  },
  '20260807_000001_mcp_oauth': { up: up_m20260807_000001_mcp_oauth, down: down_m20260807_000001_mcp_oauth },
  '20260808_000001_skill': { up: up_m20260808_000001_skill, down: down_m20260808_000001_skill },
  '20260809_000001_sandbox_provider': {
    up: up_m20260809_000001_sandbox_provider,
    down: down_m20260809_000001_sandbox_provider,
  },
  '20260810_000001_agent': { up: up_m20260810_000001_agent, down: down_m20260810_000001_agent },
  '20260811_000001_session_created_by': {
    up: up_m20260811_000001_session_created_by,
    down: down_m20260811_000001_session_created_by,
  },
  '20260812_000001_session_agent_name': {
    up: up_m20260812_000001_session_agent_name,
    down: down_m20260812_000001_session_agent_name,
  },
  '20260813_000001_mcp_oauth_user_scoped': {
    up: up_m20260813_000001_mcp_oauth_user_scoped,
    down: down_m20260813_000001_mcp_oauth_user_scoped,
  },
  '20260814_000001_session_list_updated_at_idx': {
    up: up_m20260814_000001_session_list_updated_at_idx,
    down: down_m20260814_000001_session_list_updated_at_idx,
  },
  '20260815_000001_sandbox_provider_status': {
    up: up_m20260815_000001_sandbox_provider_status,
    down: down_m20260815_000001_sandbox_provider_status,
  },
  '20260815_000002_mcp_server_description': {
    up: up_m20260815_000002_mcp_server_description,
    down: down_m20260815_000002_mcp_server_description,
  },
  '20260818_000001_mcp_pending_auth_return_to': {
    up: up_m20260818_000001_mcp_pending_auth_return_to,
    down: down_m20260818_000001_mcp_pending_auth_return_to,
  },
  '20260824_000001_session_approval_grants': {
    up: up_m20260824_000001_session_approval_grants,
    down: down_m20260824_000001_session_approval_grants,
  },
  '20260824_000010_personalization_profile': {
    up: up_m20260824_000010_personalization_profile,
    down: down_m20260824_000010_personalization_profile,
  },
  '20260824_000020_session_approval_grants_jsonb': {
    up: up_m20260824_000020_session_approval_grants_jsonb,
    down: down_m20260824_000020_session_approval_grants_jsonb,
  },
  '20260825_000001_session_folders': {
    up: up_m20260825_000001_session_folders,
    down: down_m20260825_000001_session_folders,
  },
  '20260827_000001_persona': { up: up_m20260827_000001_persona, down: down_m20260827_000001_persona },
  '20260827_000001_repository_binding': {
    up: up_m20260827_000001_repository_binding,
    down: down_m20260827_000001_repository_binding,
  },
  '20260827_000002_persona_name_key': {
    up: up_m20260827_000002_persona_name_key,
    down: down_m20260827_000002_persona_name_key,
  },
  '20260830_000001_repository_verification': {
    up: up_m20260830_000001_repository_verification,
    down: down_m20260830_000001_repository_verification,
  },
  '20260831_000001_task_checklist': {
    up: up_m20260831_000001_task_checklist,
    down: down_m20260831_000001_task_checklist,
  },
  '20260831_000002_command_execution': {
    up: up_m20260831_000002_command_execution,
    down: down_m20260831_000002_command_execution,
  },
  '20260831_000003_implementation_plan_grants': {
    up: up_m20260831_000003_implementation_plan_grants,
    down: down_m20260831_000003_implementation_plan_grants,
  },
  '20260831_000004_implementation_plan_dispatch_fence': {
    up: up_m20260831_000004_implementation_plan_dispatch_fence,
    down: down_m20260831_000004_implementation_plan_dispatch_fence,
  },
  '20260901_000001_command_execution_repair': {
    up: up_m20260901_000001_command_execution_repair,
    down: down_m20260901_000001_command_execution_repair,
  },
  '20260901_000010_personalization_learned_profile': {
    up: up_m20260901_000010_personalization_learned_profile,
    down: down_m20260901_000010_personalization_learned_profile,
  },
  '20260902_000010_personalization_learning_enabled': {
    up: up_m20260902_000010_personalization_learning_enabled,
    down: down_m20260902_000010_personalization_learning_enabled,
  },
  '20260913_000001_space': { up: up_m20260913_000001_space, down: down_m20260913_000001_space },
  '20260914_000001_space_format': { up: up_m20260914_000001_space_format, down: down_m20260914_000001_space_format },
  '20260914_000002_turn_artifact': { up: up_m20260914_000002_turn_artifact, down: down_m20260914_000002_turn_artifact },
};
