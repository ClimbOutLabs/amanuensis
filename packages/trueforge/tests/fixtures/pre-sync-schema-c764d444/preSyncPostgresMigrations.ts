/**
 * Generated fixture: the Postgres migration chain from commit c764d444
 * (main's tip immediately before the upstream sync, PR #174 / 96e0fb1f),
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

/**
 * Keeps migrations atomic both when invoked directly and through Kysely's
 * Postgres migrator, which already supplies a transaction to each migration.
 */
function withMigrationTransaction(
  db: Kysely<unknown>,
  callback: (trx: Kysely<unknown>) => Promise<void>,
): Promise<void> {
  return db.isTransaction ? callback(db) : db.transaction().execute(callback);
}

// ---- 20260727_000001_init.ts ----
async function up_m20260727_000001_init(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`SELECT 1`.execute(db);
}

async function down_m20260727_000001_init(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`SELECT 1`.execute(db);
}

// ---- 20260728_000001_session_store.ts ----
/**
 * Session-store tables (canonical DDL owner).
 *
 * Write-heat summary: `turn_thread` is the one deliberately-hot table with its hot
 * columns (`context_ids`, `current_context_usage`) isolated from the pointer-carried
 * big ones (`agent_info`, `checkpoint`); `session`, `turn`, and
 * `thread_capability_state` take small bounded HOT-friendly updates; the two logs
 * are pure insert. Nothing ever rewrites a large value except the array concat
 * itself — the documented, bounded cost of the raw-array model.
 *
 * Column placement rule: top-level column ONLY if (a) key/query target, (b) hot
 * write target (isolated so nothing else churns with it; typed operators), or
 * (c) big-and-immutable (own TOAST value carried by pointer through row rewrites).
 * Everything small/rare/descriptive inlines into a store-owned extensible
 * `checkpoint` jsonb. `custom` is always its own column: `checkpoint` is
 * store-owned, `custom` is caller-owned.
 */
async function up_m20260728_000001_session_store(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('session')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // top: big + immutable-in-practice (updateSession patch only);
    //      TOAST pointer rides through per-turn tip bumps untouched
    .addColumn('agent_spec', 'jsonb', col => col.notNull())
    // top: list-displayed, independently patched; first-write-wins
    //      (COALESCE) targets it directly
    .addColumn('title', 'text')
    // top: HOT — bumped once per createTurn under the session lock;
    //      tiny fixed-width column keeps the bump a cheap HOT update
    .addColumn('last_turn_id', 'text')
    // top: caller-owned opaque extension; never mixed with store state
    .addColumn('custom', 'jsonb')
    // top: hot, bumped with the tip ("activity" = turn creation)
    .addColumn('last_activity_timestamp_ms', 'bigint', col => col.notNull())
    // top: list ordering (indexed below)
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('session_pkey', ['tenant_id', 'session_id'])
    // headroom so the per-turn bump stays HOT (no index churn)
    .modifyEnd(sql`WITH (fillfactor = 85)`)
    .execute();

  await db.schema
    .createIndex('session_list_idx')
    .on('session')
    .columns(['tenant_id', 'created_at', 'session_id'])
    .execute();

  await db.schema
    .createTable('turn')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // key (ulid)
    .addColumn('turn_id', 'text', col => col.notNull())
    // top: immutable topology; filter target
    .addColumn('first_turn_id', 'text', col => col.notNull())
    // top: immutable topology; NULL = session's first turn
    .addColumn('previous_turn_id', 'text')
    // top: immutable; queried by the anchored ancestor-chain walk
    //      (spill through older turns); typed array
    .addColumn('ancestor_ids', sql`text[]`, col => col.notNull())
    // top: big + written once at create; TOAST pointer stable after
    .addColumn('input', 'jsonb', col => col.notNull())
    // top: THE fence/freeze target — every gated write predicates on
    //      state->>'status'; exactly one terminal flip per turn
    .addColumn('state', 'jsonb', col => col.notNull())
    // inlined: {mcp_servers, sandbox_info, ...future} — both small,
    //      patched at most once or twice per turn (resource init);
    //      extensible without migration
    .addColumn('checkpoint', 'jsonb', col => col.notNull())
    // top: caller-owned opaque extension
    .addColumn('custom', 'jsonb')
    // top: list ordering (indexed below)
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('turn_pkey', ['tenant_id', 'session_id', 'turn_id'])
    // headroom for the state flip + rare checkpoint patches
    .modifyEnd(sql`WITH (fillfactor = 85)`)
    .execute();

  await db.schema
    .createIndex('turn_list_idx')
    .on('turn')
    .columns(['tenant_id', 'session_id', 'created_at', 'turn_id'])
    .execute();

  // the complete STATE of one thread at one turn
  await db.schema
    .createTable('turn_thread')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // key
    .addColumn('turn_id', 'text', col => col.notNull())
    // key
    .addColumn('thread_id', 'text', col => col.notNull())
    // inlined: {parent, completion, ...future} — parent: small,
    //      immutable; completion: can be big but written ONCE at
    //      thread end (rare + terminal); the hot path below never
    //      touches this jsonb
    .addColumn('checkpoint', 'jsonb', col => col.notNull())
    // top: big + immutable thread IDENTITY. Real data: sub-agent
    //      instructions in one working session ran 2.4–8.8KB
    //      (median 4.4KB) — always past the ~2KB TOAST threshold,
    //      so a dedicated column lets every array rewrite carry the
    //      TOAST value by pointer instead of re-serializing it.
    //      Deliberately duplicates context[0] (the task is also the
    //      thread's first user message): the log copy is
    //      conversation state and compaction may reclaim it; this
    //      copy is identity and must survive context surgery
    //      (restore re-resolves the child definition from
    //      name/model/input here). NULL for the root thread.
    .addColumn('agent_info', 'jsonb')
    // top: hot — set by the SAME single-statement UPDATE as the
    //      array concat (zero extra row versions; ~300B inline;
    //      byte-neutral vs stamping log rows). Kept out of
    //      checkpoint so the jsonb never rewrites on the hot path.
    //      Escape hatch: if the array ever becomes write-once
    //      (ranges / writer-filter), move this back onto
    //      thread_context_log rows (previously validated design).
    .addColumn('current_context_usage', 'jsonb', col => col.notNull())
    // top: THE context — log append_ids in context order. Hot
    //      concat target (`||`), typed bigint[] operator; dominant
    //      TOAST value (~8KB at 1k live messages, entire value
    //      rewritten per append batch — the accepted cost of the
    //      raw-array choice; range-encoding is the recorded shrink
    //      if measured).
    .addColumn('context_ids', sql`bigint[]`, col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('turn_thread_pkey', ['tenant_id', 'session_id', 'turn_id', 'thread_id'])
    // the ONE deliberately-hot table: rewritten 5–10x while its
    // turn runs; immutable once the turn is terminal (fence)
    .modifyEnd(sql`WITH (fillfactor = 70)`)
    .execute();

  await db.schema
    .createTable('session_event')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // top: every read is turn-scoped or turn-attributed (envelope)
    .addColumn('turn_id', 'text', col => col.notNull())
    // top/key: event.id, a process-local monotonic ULID minted when the event is
    //      created. Lexical ordering preserves the single turn writer's creation
    //      order, including events created in the same millisecond.
    //
    // A database auto-increment id is deliberately not used: it assigns order
    //      at persistence rather than event creation, couples the contract to
    //      Postgres, and sequence allocation across pooled connections,
    //      transactions, retries, or larger sequence caches need not represent
    //      logical event order. The event already owns a portable unique id, so
    //      a second store-generated identity would duplicate identity and make
    //      ordering backend-dependent.
    //
    // See https://github.com/ulid/spec#monotonicity
    .addColumn('event_id', 'text', col => col.notNull())
    // top: PersistedTurnEvent payload, written once
    .addColumn('event', 'jsonb', col => col.notNull())
    // top: copied from event.created_at (required by PersistedTurnEvent), so
    //      future time-range filters can be indexed without inspecting jsonb.
    //      Ordering still uses event_id.
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('session_event_pkey', ['tenant_id', 'session_id', 'turn_id', 'event_id'])
    // pure INSERT → fillfactor 100
    .execute();

  // pure immutable CONTENT; no state → no checkpoint field
  await db.schema
    .createTable('thread_context_log')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // key
    .addColumn('thread_id', 'text', col => col.notNull())
    // top: THE message id — store-assigned (the delta createTurn
    //      interface killed content addressing: the store is told
    //      what's new, so no hashing/dedupe); consumed by
    //      data-modifying CTE in the same statement (RETURNING
    //      → array concat, one network call). bigint on purpose:
    //      no exhaustion (~290M years at 1k msg/s; int4 would die
    //      in months). NOT an order key: the array is the sole
    //      order authority (reads use unnest WITH ORDINALITY).
    //      Cross-statement id order is NEVER relied on for context
    //      (pool + sequence CACHE could invert it); the only id
    //      ordering used is INTRA-statement (array_agg ORDER BY
    //      append_id over one INSERT's RETURNING = VALUES order,
    //      backend-local, safe under any CACHE setting)
    .addColumn('append_id', 'bigint', col => col.notNull().generatedAlwaysAsIdentity())
    // top: provenance — which turn wrote the row; debugging + the
    //      future writer-filter migration; tiny; NOT used for
    //      visibility (the array is the sole visibility authority)
    .addColumn('turn_id', 'text', col => col.notNull())
    // top: the ContextMessage — written exactly once, never updated
    .addColumn('body', 'jsonb', col => col.notNull())
    // top: future indexed time filters without a table rewrite
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('thread_context_log_pkey', ['tenant_id', 'session_id', 'thread_id', 'append_id'])
    // pure INSERT → default fillfactor 100, zero dead tuples;
    // cleanup is whole-session delete only
    .execute();

  // PER-TURN KV snapshot, latest-wins per (turn, thread, key)
  await db.schema
    .createTable('thread_capability_state')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key
    .addColumn('session_id', 'text', col => col.notNull())
    // key: capability history is PER TURN — fork/restore from any
    //      turn must see the map AS OF that turn, and a frozen
    //      turn's map must never change under it. (A cross-turn
    //      latest-wins PK was tried and REVERTED for exactly the
    //      fork reason.)
    .addColumn('turn_id', 'text', col => col.notNull())
    // key
    .addColumn('thread_id', 'text', col => col.notNull())
    // key: capability state key; `tfy.` prefix reserved
    .addColumn('key', 'text', col => col.notNull())
    // top: the value IS the row — JsonValue (undefined banned at
    //      the harness boundary); NULL = explicitly cleared
    .addColumn('state', 'jsonb')
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('thread_capability_state_pkey', ['tenant_id', 'session_id', 'turn_id', 'thread_id', 'key'])
    // single-statement fenced upsert per CAPABILITY_STATE event
    .modifyEnd(sql`WITH (fillfactor = 85)`)
    .execute();
}

async function down_m20260728_000001_session_store(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('thread_capability_state').ifExists().cascade().execute();
  await db.schema.dropTable('thread_context_log').ifExists().cascade().execute();
  await db.schema.dropTable('session_event').ifExists().cascade().execute();
  await db.schema.dropTable('turn_thread').ifExists().cascade().execute();
  await db.schema.dropTable('turn').ifExists().cascade().execute();
  await db.schema.dropTable('session').ifExists().cascade().execute();
}

// ---- 20260803_000001_mcp_oauth.ts ----
async function up_m20260803_000001_mcp_oauth(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('mcp_server')
    .addColumn('id', 'text', c => c.notNull())
    .addColumn('tenant_id', 'text', c => c.notNull())
    .addColumn('name', 'text', c => c.notNull())
    .addColumn('manifest', 'jsonb', c => c.notNull())
    .addColumn('oauth_server', 'jsonb')
    .addColumn('oauth_client', 'jsonb')
    .addColumn('created_at', 'timestamptz', c => c.notNull())
    .addColumn('updated_at', 'timestamptz', c => c.notNull())
    .addPrimaryKeyConstraint('mcp_server_pkey', ['id'])
    .execute();

  await db.schema
    .createIndex('mcp_server_tenant_name_idx')
    .on('mcp_server')
    .columns(['tenant_id', 'name'])
    .unique()
    .execute();

  await db.schema
    .createTable('oauth_token')
    .addColumn('oauth_server_id', 'text', c => c.notNull().references('mcp_server.id').onDelete('cascade'))
    .addColumn('token', 'jsonb', c => c.notNull())
    .addColumn('updated_at', 'timestamptz', c => c.notNull())
    .addPrimaryKeyConstraint('oauth_token_pkey', ['oauth_server_id'])
    .execute();

  await db.schema
    .createTable('oauth_pending_authorization')
    .addColumn('id', 'text', c => c.notNull())
    .addColumn('oauth_server_id', 'text', c => c.notNull().references('mcp_server.id').onDelete('cascade'))
    .addColumn('auth_data', 'jsonb', c => c.notNull())
    .addColumn('created_at', 'timestamptz', c => c.notNull()) // used for TTL expiry on read
    .addPrimaryKeyConstraint('oauth_pending_authorization_pkey', ['id'])
    .execute();
}

async function down_m20260803_000001_mcp_oauth(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('oauth_pending_authorization').ifExists().cascade().execute();
  await db.schema.dropTable('oauth_token').ifExists().cascade().execute();
  await db.schema.dropTable('mcp_server').ifExists().cascade().execute();
}

// ---- 20260803_000001_model_provider.ts ----
/**
 * Configured model providers (canonical DDL owner).
 *
 * Manifest pattern: identity as columns, everything else (type, base_url,
 * auth, models) in one `manifest` jsonb validated by Zod on every write.
 * The PK is the only DB-level invariant — all others live at the Zod layer —
 * so future manifest fields are schema changes, not migrations.
 */
async function up_m20260803_000001_model_provider(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('model_provider')
    // key
    .addColumn('tenant_id', 'text', col => col.notNull())
    // key: natural key within tenant; first segment of fully qualified model names
    .addColumn('name', 'text', col => col.notNull())
    // ModelProvider document; replaced whole on every upsert
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('model_provider_pkey', ['tenant_id', 'name'])
    .execute();
}

async function down_m20260803_000001_model_provider(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('model_provider').ifExists().cascade().execute();
}

// ---- 20260803_000002_session_scoped_keys.ts ----
/** Drop tenant_id from turn-scoped tables; session_id is globally unique with cascade FKs. */
async function up_m20260803_000002_session_scoped_keys(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  // Index includes tenant_id; drop before reshaping turn.
  await db.schema.dropIndex('turn_list_idx').execute();

  // session_id must be unique before child FKs can reference it alone.
  await db.schema.alterTable('session').dropConstraint('session_pkey').execute();
  await db.schema.alterTable('session').addPrimaryKeyConstraint('session_pkey', ['session_id']).execute();

  // turn: drop tenant_id, rekey, cascade on session delete.
  await db.schema.alterTable('turn').dropConstraint('turn_pkey').execute();
  await db.schema.alterTable('turn').dropColumn('tenant_id').execute();
  await db.schema.alterTable('turn').addPrimaryKeyConstraint('turn_pkey', ['session_id', 'turn_id']).execute();
  await db.schema
    .alterTable('turn')
    .addForeignKeyConstraint('turn_session_fkey', ['session_id'], 'session', ['session_id'])
    .onDelete('cascade')
    .execute();

  // turn_thread: drop tenant_id, rekey, cascade on session delete.
  await db.schema.alterTable('turn_thread').dropConstraint('turn_thread_pkey').execute();
  await db.schema.alterTable('turn_thread').dropColumn('tenant_id').execute();
  await db.schema
    .alterTable('turn_thread')
    .addPrimaryKeyConstraint('turn_thread_pkey', ['session_id', 'turn_id', 'thread_id'])
    .execute();
  await db.schema
    .alterTable('turn_thread')
    .addForeignKeyConstraint('turn_thread_session_fkey', ['session_id'], 'session', ['session_id'])
    .onDelete('cascade')
    .execute();

  // session_event: drop tenant_id, rekey, cascade on session delete.
  await db.schema.alterTable('session_event').dropConstraint('session_event_pkey').execute();
  await db.schema.alterTable('session_event').dropColumn('tenant_id').execute();
  await db.schema
    .alterTable('session_event')
    .addPrimaryKeyConstraint('session_event_pkey', ['session_id', 'turn_id', 'event_id'])
    .execute();
  await db.schema
    .alterTable('session_event')
    .addForeignKeyConstraint('session_event_session_fkey', ['session_id'], 'session', ['session_id'])
    .onDelete('cascade')
    .execute();

  // thread_context_log: drop tenant_id, rekey, cascade on session delete.
  await db.schema.alterTable('thread_context_log').dropConstraint('thread_context_log_pkey').execute();
  await db.schema.alterTable('thread_context_log').dropColumn('tenant_id').execute();
  await db.schema
    .alterTable('thread_context_log')
    .addPrimaryKeyConstraint('thread_context_log_pkey', ['session_id', 'thread_id', 'append_id'])
    .execute();
  await db.schema
    .alterTable('thread_context_log')
    .addForeignKeyConstraint('thread_context_log_session_fkey', ['session_id'], 'session', ['session_id'])
    .onDelete('cascade')
    .execute();

  // thread_capability_state: drop tenant_id, rekey, cascade on session delete.
  await db.schema.alterTable('thread_capability_state').dropConstraint('thread_capability_state_pkey').execute();
  await db.schema.alterTable('thread_capability_state').dropColumn('tenant_id').execute();
  await db.schema
    .alterTable('thread_capability_state')
    .addPrimaryKeyConstraint('thread_capability_state_pkey', ['session_id', 'turn_id', 'thread_id', 'key'])
    .execute();
  await db.schema
    .alterTable('thread_capability_state')
    .addForeignKeyConstraint('thread_capability_state_session_fkey', ['session_id'], 'session', ['session_id'])
    .onDelete('cascade')
    .execute();

  // Rebuild list index without tenant_id.
  await db.schema.createIndex('turn_list_idx').on('turn').columns(['session_id', 'created_at', 'turn_id']).execute();
}

/** Irreversible: the dropped tenant_id values are not recoverable. */
function down_m20260803_000002_session_scoped_keys(): Promise<void> {
  return Promise.reject(new Error('20260803_000002_session_scoped_keys is not reversible'));
}

// ---- 20260808_000001_skill.ts ----
/**
 * Configured skills (canonical DDL owner).
 *
 * Manifest pattern: identity as columns, everything else (type, url, path, ref,
 * description — and duplicated `name`) in one `manifest` jsonb validated by Zod
 * on every write. The PK is the only DB-level invariant — all others live at
 * the Zod layer — so future manifest fields are schema changes, not migrations.
 */
async function up_m20260808_000001_skill(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('skill')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('skill_pkey', ['tenant_id', 'name'])
    .execute();
}

async function down_m20260808_000001_skill(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('skill').ifExists().cascade().execute();
}

// ---- 20260809_000001_sandbox_provider.ts ----
/**
 * Configured sandbox provider (canonical DDL owner).
 *
 * Singleton per tenant: PK is `tenant_id` only. Manifest (type, auth, snapshot,
 * timeouts) is one jsonb document validated by Zod on every write.
 */
async function up_m20260809_000001_sandbox_provider(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('sandbox_provider')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('sandbox_provider_pkey', ['tenant_id'])
    .execute();
}

async function down_m20260809_000001_sandbox_provider(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('sandbox_provider').ifExists().cascade().execute();
}

// ---- 20260810_000001_agent.ts ----
/**
 * Agent registry + session agent binding.
 *
 * - `agent`: immutable application-generated `id` (ULID) as PK; natural lookup
 *   key is UNIQUE (tenant_id, name). Spec lives in Zod-validated `manifest` jsonb
 *   (same pattern as mcp_server).
 * - `session`: agent_id XOR agent_spec. Existing rows keep inline agent_spec with
 *   agent_id NULL.
 */
async function up_m20260810_000001_agent(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('agent')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('agent_pkey', ['id'])
    .execute();

  await db.schema.createIndex('agent_tenant_name_idx').on('agent').columns(['tenant_id', 'name']).unique().execute();

  await db.schema.alterTable('session').addColumn('agent_id', 'text').execute();

  await sql`ALTER TABLE session ALTER COLUMN agent_spec DROP NOT NULL`.execute(db);

  await sql`
    ALTER TABLE session
      ADD CONSTRAINT session_agent_xor_check
      CHECK (
        (agent_id IS NOT NULL AND agent_spec IS NULL)
        OR (agent_id IS NULL AND agent_spec IS NOT NULL)
      )
  `.execute(db);

  await sql`
    CREATE INDEX session_agent_id_idx
      ON session (tenant_id, agent_id)
      WHERE agent_id IS NOT NULL
  `.execute(db);
}

async function down_m20260810_000001_agent(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP INDEX IF EXISTS session_agent_id_idx`.execute(db);
  await sql`ALTER TABLE session DROP CONSTRAINT IF EXISTS session_agent_xor_check`.execute(db);
  await sql`
    DELETE FROM session WHERE agent_spec IS NULL
  `.execute(db);
  await sql`ALTER TABLE session ALTER COLUMN agent_spec SET NOT NULL`.execute(db);
  await db.schema.alterTable('session').dropColumn('agent_id').execute();
  await db.schema.dropTable('agent').ifExists().cascade().execute();
}

// ---- 20260811_000001_session_created_by.ts ----
/** Add immutable `created_by` identity on session. */
async function up_m20260811_000001_session_created_by(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('session')
    .addColumn('created_by', 'text', col => col.notNull().defaultTo(''))
    .execute();
}

async function down_m20260811_000001_session_created_by(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('session').dropColumn('created_by').execute();
}

// ---- 20260812_000001_session_agent_name.ts ----
/**
 * Create-time snapshot of registry agent name on named sessions.
 * Backfills from `agent.name` where `session.agent_id` still resolves;
 * orphan refs stay NULL.
 */
async function up_m20260812_000001_session_agent_name(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('session').addColumn('agent_name', 'text').execute();
  await sql`
    UPDATE session AS s
    SET agent_name = a.name
    FROM agent AS a
    WHERE s.agent_id = a.id
      AND s.tenant_id = a.tenant_id
  `.execute(db);
}

async function down_m20260812_000001_session_agent_name(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('session').dropColumn('agent_name').execute();
}

// ---- 20260813_000001_mcp_oauth_user_scoped.ts ----
/**
 * Scope MCP OAuth access/refresh tokens per harness user, and stamp `user_id` on
 * pending authorizations so the public callback can write the correct token row.
 * Drops previously shared (server-only) tokens — callers must re-authorize.
 *
 * ACCESS EXCLUSIVE before each delete blocks concurrent inserts through the
 * rest of this migration transaction.
 */
async function up_m20260813_000001_mcp_oauth_user_scoped(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await sql`LOCK TABLE oauth_token IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_token`.execute(db);
  await db.schema
    .alterTable('oauth_token')
    .addColumn('user_id', 'text', col => col.notNull())
    .execute();
  await sql`ALTER TABLE oauth_token DROP CONSTRAINT oauth_token_pkey`.execute(db);
  await sql`ALTER TABLE oauth_token ADD CONSTRAINT oauth_token_pkey PRIMARY KEY (oauth_server_id, user_id)`.execute(db);

  // In-flight pending rows cannot be attributed to a user; drop them.
  await sql`LOCK TABLE oauth_pending_authorization IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_pending_authorization`.execute(db);
  await db.schema
    .alterTable('oauth_pending_authorization')
    .addColumn('user_id', 'text', col => col.notNull())
    .execute();
}

async function down_m20260813_000001_mcp_oauth_user_scoped(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await sql`LOCK TABLE oauth_pending_authorization IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_pending_authorization`.execute(db);
  await db.schema.alterTable('oauth_pending_authorization').dropColumn('user_id').execute();

  await sql`LOCK TABLE oauth_token IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_token`.execute(db);
  await sql`ALTER TABLE oauth_token DROP CONSTRAINT oauth_token_pkey`.execute(db);
  await db.schema.alterTable('oauth_token').dropColumn('user_id').execute();
  await sql`ALTER TABLE oauth_token ADD CONSTRAINT oauth_token_pkey PRIMARY KEY (oauth_server_id)`.execute(db);
}

// ---- 20260814_000001_session_list_updated_at_idx.ts ----
/**
 * listSessions orders by `updated_at` (session_id tie-break). Keep
 * `session_list_idx` on `created_at` for start/end timestamp filters.
 */
async function up_m20260814_000001_session_list_updated_at_idx(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createIndex('session_list_updated_at_idx')
    .on('session')
    .columns(['tenant_id', 'updated_at', 'session_id'])
    .execute();
}

async function down_m20260814_000001_session_list_updated_at_idx(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropIndex('session_list_updated_at_idx').execute();
}

// ---- 20260815_000001_sandbox_provider_status.ts ----
/**
 * Persist the release sandbox image build status alongside the provider config.
 * `build_metadata` is nullable opaque jsonb (build_ref + image_uri when present).
 *
 * `status` is added with a temporary 'pending' default so the NOT NULL column can
 * be backfilled on existing rows, then the default is dropped — every upsert writes
 * status explicitly, so the DB should never silently fall back to 'pending'.
 *
 * Existing rows already have an active snapshot named in the legacy
 * `manifest.snapshot_name`; backfill them as ready with that name as build_ref.
 * The image_uri is captured as the release image at the time of this migration.
 */
const RELEASE_IMAGE_URI =
  'tfy.jfrog.io/tfy-images/truefoundry-utils-core-sandbox:029ea5ff6438cf86b79282e087bfc17528067946';

async function up_m20260815_000001_sandbox_provider_status(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('sandbox_provider')
    .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
    .addColumn('status_reason', 'text')
    .addColumn('build_metadata', 'jsonb')
    .execute();

  await sql`
    UPDATE sandbox_provider
    SET status = 'ready',
        build_metadata = jsonb_build_object(
          'build_ref', manifest ->> 'snapshot_name',
          'image_uri', ${RELEASE_IMAGE_URI}::text
        )
    WHERE manifest ->> 'snapshot_name' IS NOT NULL
  `.execute(db);

  await db.schema
    .alterTable('sandbox_provider')
    .alterColumn('status', col => col.dropDefault())
    .execute();
}

async function down_m20260815_000001_sandbox_provider_status(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('sandbox_provider')
    .dropColumn('build_metadata')
    .dropColumn('status_reason')
    .dropColumn('status')
    .execute();
}

// ---- 20260815_000002_mcp_server_description.ts ----
/**
 * Required `description` on `mcp_server.manifest`. Backfill `{name} MCP Server`
 * when the key is missing or blank so existing rows satisfy McpServerManifestSchema.
 */
async function up_m20260815_000002_mcp_server_description(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE mcp_server
    SET manifest = manifest || jsonb_build_object('description', name || ' MCP Server')
    WHERE btrim(coalesce(manifest->>'description', '')) = ''
  `.execute(db);
}

async function down_m20260815_000002_mcp_server_description(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE mcp_server
    SET manifest = manifest - 'description'
    WHERE manifest->>'description' = name || ' MCP Server'
  `.execute(db);
}

// ---- 20260818_000001_mcp_pending_auth_return_to.ts ----
/**
 * Pending-authorization `auth_data` jsonb key `redirect_url` → `return_to` (path).
 * In-flight rows are short-lived and cannot be rewritten safely; drop them so
 * callers restart authorize with the new shape.
 */
async function up_m20260818_000001_mcp_pending_auth_return_to(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`LOCK TABLE oauth_pending_authorization IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_pending_authorization`.execute(db);
}

async function down_m20260818_000001_mcp_pending_auth_return_to(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  // Rows written with `return_to` are incompatible with the prior shape; clear them.
  await sql`LOCK TABLE oauth_pending_authorization IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DELETE FROM oauth_pending_authorization`.execute(db);
}

// ---- 20260824_000001_session_approval_grants.ts ----
/** Durable exact-tool grants created by "Allow for this chat". */
async function up_m20260824_000001_session_approval_grants(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('session')
    .addColumn('approval_grants', 'jsonb', column => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
}

async function down_m20260824_000001_session_approval_grants(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('session').dropColumn('approval_grants').execute();
}

// ---- 20260824_000010_personalization_profile.ts ----
/** Local per-user assistant/user profile. No session or conversation data is copied here. */
async function up_m20260824_000010_personalization_profile(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('personalization_profile')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('assistant_name', 'text')
    .addColumn('assistant_identity', 'text')
    .addColumn('voice_guidance', 'text')
    .addColumn('user_profile', 'text')
    .addColumn('pinned_preferences', 'jsonb', col => col.notNull())
    .addColumn('revision', 'integer', col => col.notNull())
    .addColumn('digest', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_by', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('personalization_profile_pkey', ['tenant_id', 'created_by'])
    .execute();
}

async function down_m20260824_000010_personalization_profile(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('personalization_profile').ifExists().execute();
}

// ---- 20260825_000001_session_folders.ts ----
async function up_m20260825_000001_session_folders(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('session_folder')
    .addColumn('id', 'text', column => column.primaryKey())
    .addColumn('tenant_id', 'text', column => column.notNull())
    .addColumn('created_by', 'text', column => column.notNull())
    .addColumn('name', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull())
    .addColumn('updated_at', 'timestamptz', column => column.notNull())
    .execute();
  await db.schema
    .createIndex('session_folder_owner_name_idx')
    .on('session_folder')
    .columns(['tenant_id', 'created_by', 'name', 'id'])
    .execute();
  await db.schema
    .alterTable('session')
    .addColumn('folder_id', 'text', column => column.references('session_folder.id').onDelete('set null'))
    .execute();
  await db.schema
    .createIndex('session_folder_id_idx')
    .on('session')
    .column('folder_id')
    .where('folder_id', 'is not', null)
    .execute();
}

async function down_m20260825_000001_session_folders(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropIndex('session_folder_id_idx').ifExists().execute();
  await db.schema.alterTable('session').dropColumn('folder_id').execute();
  await db.schema.dropTable('session_folder').ifExists().execute();
}

// ---- 20260826_000001_session_approval_grants_repair.ts ----
/**
 * Repair rows corrupted by a session-store write bug: `approval_grants`
 * (and the createTurn merge write) bound a bare JS `string[]` directly
 * instead of going through the `json()` helper. node-pg encodes a bare
 * array as the Postgres ARRAY literal `'{}'`/`'{"a","b"}'`, which then
 * casts to the jsonb column as an empty OBJECT (or fails to parse for
 * non-empty grants) instead of a JSON array. Downstream code spreads this
 * column as `string[]` (`[...locked.approval_grants, ...]`), which threw
 * "approval_grants is not iterable" for every row written before the write
 * sites were fixed to use `json()`.
 *
 * The column's type/constraint (`jsonb NOT NULL DEFAULT '[]'::jsonb`) was
 * already correct — only previously written values are wrong — so this is
 * a data-only repair, not a schema change.
 */
async function up_m20260826_000001_session_approval_grants_repair(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE session
    SET approval_grants = '[]'::jsonb
    WHERE jsonb_typeof(approval_grants) <> 'array'
  `.execute(db);
}

/** Irreversible: the pre-repair (corrupted) values are not worth restoring. */
function down_m20260826_000001_session_approval_grants_repair(): Promise<void> {
  return Promise.reject(new Error('20260826_000001_session_approval_grants_repair is not reversible'));
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
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('persona')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('display_name', 'text', col => col.notNull())
    .addColumn('aliases', 'jsonb', col => col.notNull())
    .addColumn('instructions', 'text', col => col.notNull())
    .addColumn('model_name', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_by', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('persona_pkey', ['tenant_id', 'id'])
    .execute();
  await db.schema
    .createIndex('persona_owner_idx')
    .on('persona')
    .columns(['tenant_id', 'created_by', 'display_name'])
    .execute();

  await db.schema
    .createTable('session_persona')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('session_id', 'text', col => col.notNull())
    .addColumn('seq', 'integer', col => col.notNull())
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('turn_id', 'text')
    .addColumn('persona_id', 'text')
    .addColumn('persona_name', 'text')
    .addColumn('model_name', 'text')
    .addColumn('source', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('session_persona_pkey', ['tenant_id', 'session_id', 'seq'])
    .execute();
}

async function down_m20260827_000001_persona(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('session_persona').ifExists().execute();
  await db.schema.dropTable('persona').ifExists().execute();
}

// ---- 20260827_000001_repository_binding.ts ----
/**
 * Historical repository-binding schema.
 *
 * Keep this migration registered permanently: deployed Postgres databases may
 * already record it as applied, even while the repository surface is absent
 * from a later application build.
 */
async function up_m20260827_000001_repository_binding(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting
  // another transaction here is unsupported; all statements below share the
  // migrator-owned transaction and roll back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('repository')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('clone_url', 'text', col => col.notNull())
    .addColumn('default_branch', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('repository_pkey', ['id'])
    .execute();
  await db.schema
    .createIndex('repository_tenant_name_idx')
    .on('repository')
    .columns(['tenant_id', 'created_by', 'name'])
    .unique()
    .execute();
  await db.schema.alterTable('session').addColumn('repository_id', 'text').execute();
  await db.schema
    .createIndex('session_repository_id_idx')
    .on('session')
    .columns(['tenant_id', 'repository_id'])
    .where('repository_id', 'is not', null)
    .execute();
}

async function down_m20260827_000001_repository_binding(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP INDEX IF EXISTS session_repository_id_idx`.execute(db);
  await db.schema.alterTable('session').dropColumn('repository_id').execute();
  await db.schema.dropTable('repository').ifExists().cascade().execute();
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
  if (!isStringArray(value)) {
    throw new Error('cannot backfill persona names: persona.aliases must be an array of strings');
  }
  return value;
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
      const reservationKey = `${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`;
      const existing = reservations.get(reservationKey);
      if (existing !== undefined && existing.persona_id !== row.id) {
        const owners = collisions.get(reservationKey) ?? new Set([existing.persona_id]);
        owners.add(row.id);
        collisions.set(reservationKey, owners);
        continue;
      }
      reservations.set(reservationKey, {
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

/** Completes the persona schema introduced by 000001 for existing installations. */
async function up_m20260827_000002_persona_name_key(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  const result = await sql<PersonaRow>`
    SELECT tenant_id, id, created_by, display_name, aliases
    FROM persona
    ORDER BY tenant_id, created_by, id
  `.execute(db);
  const reservations = buildReservations(result.rows);

  await sql`ALTER TABLE persona ADD CONSTRAINT persona_owner_id_key UNIQUE (tenant_id, created_by, id)`.execute(db);
  await db.schema
    .createTable('persona_name_key')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('normalized_key', 'text', col => col.notNull())
    .addColumn('persona_id', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('persona_name_key_pkey', ['tenant_id', 'created_by', 'normalized_key'])
    .addForeignKeyConstraint(
      'persona_name_key_persona_fkey',
      ['tenant_id', 'created_by', 'persona_id'],
      'persona',
      ['tenant_id', 'created_by', 'id'],
      constraint => constraint.onDelete('cascade'),
    )
    .execute();
  await insertReservations(db, reservations);
  await db.schema
    .createIndex('persona_name_key_persona_idx')
    .on('persona_name_key')
    .columns(['tenant_id', 'persona_id'])
    .execute();
  await sql`
    ALTER TABLE session_persona
      ADD CONSTRAINT session_persona_session_fkey
      FOREIGN KEY (session_id) REFERENCES session(session_id) ON DELETE CASCADE
  `.execute(db);
  await db.schema.createIndex('session_persona_session_idx').on('session_persona').column('session_id').execute();
}

async function down_m20260827_000002_persona_name_key(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropIndex('session_persona_session_idx').ifExists().execute();
  await sql`ALTER TABLE session_persona DROP CONSTRAINT IF EXISTS session_persona_session_fkey`.execute(db);
  await db.schema.dropTable('persona_name_key').ifExists().execute();
  await sql`ALTER TABLE persona DROP CONSTRAINT IF EXISTS persona_owner_id_key`.execute(db);
}

// ---- 20260830_000001_repository_verification.ts ----
/** Completes the historical repository binding with revisioned verification metadata. */
async function up_m20260830_000001_repository_verification(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('repository')
      .addColumn('revision', 'integer', column => column.notNull().defaultTo(0))
      .execute();
    await sql`ALTER TABLE repository ADD CONSTRAINT repository_revision_check CHECK (revision >= 0)`.execute(trx);
    await trx.schema.alterTable('session').addColumn('workspace_cwd', 'text').execute();
    await sql`
    ALTER TABLE session
      ADD CONSTRAINT session_workspace_cwd_check
      CHECK (workspace_cwd IS NULL OR length(trim(workspace_cwd)) > 0)
  `.execute(trx);

    await trx.schema
      .createTable('repository_verify_command')
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('command_id', 'text', column => column.notNull())
      .addColumn('purpose', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('timeout_ms', 'integer', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addColumn('updated_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('repository_verify_command_pkey', ['repository_id', 'command_id'])
      .addForeignKeyConstraint(
        'repository_verify_command_repository_fkey',
        ['repository_id'],
        'repository',
        ['id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_purpose_check
      CHECK (purpose IN ('build', 'test', 'verify'))
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_text_check
      CHECK (length(trim(command_id)) > 0 AND length(command) > 0)
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_timeout_check
      CHECK (timeout_ms BETWEEN 1 AND 3600000)
  `.execute(trx);
    await trx.schema
      .createIndex('repository_verify_command_repository_idx')
      .on('repository_verify_command')
      .columns(['repository_id', 'purpose', 'command_id'])
      .execute();

    await trx.schema
      .createTable('repository_verify_command_proposal')
      .addColumn('id', 'text', column => column.notNull())
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('purpose', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('source_kind', 'text', column => column.notNull())
      .addColumn('source_path', 'text', column => column.notNull())
      .addColumn('source_fingerprint', 'text', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('repository_verify_command_proposal_pkey', ['repository_id', 'id'])
      .addForeignKeyConstraint(
        'repository_verify_command_proposal_repository_fkey',
        ['repository_id'],
        'repository',
        ['id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE repository_verify_command_proposal
      ADD CONSTRAINT repository_verify_command_proposal_purpose_check
      CHECK (purpose IN ('build', 'test', 'verify'))
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command_proposal
      ADD CONSTRAINT repository_verify_command_proposal_text_check
      CHECK (
        length(command) > 0
        AND source_kind IN ('agents_md', 'package_json')
        AND length(trim(source_path)) > 0
        AND length(trim(source_fingerprint)) > 0
      )
  `.execute(trx);
    await trx.schema
      .createIndex('repository_verify_command_proposal_repository_idx')
      .on('repository_verify_command_proposal')
      .columns(['repository_id', 'created_at', 'id'])
      .execute();
  });
}

async function down_m20260830_000001_repository_verification(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('repository_verify_command_proposal').ifExists().cascade().execute();
    await trx.schema.dropTable('repository_verify_command').ifExists().cascade().execute();
    await sql`ALTER TABLE session DROP CONSTRAINT IF EXISTS session_workspace_cwd_check`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('workspace_cwd').execute();
    await sql`ALTER TABLE repository DROP CONSTRAINT IF EXISTS repository_revision_check`.execute(trx);
    await trx.schema.alterTable('repository').dropColumn('revision').execute();
  });
}

// ---- 20260831_000001_task_checklist.ts ----
async function up_m20260831_000001_task_checklist(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('session')
      .addColumn('task_checklist', 'jsonb', column =>
        column.notNull().defaultTo(sql`'{"revision":0,"items":[]}'::jsonb`),
      )
      .execute();
  });
}

async function down_m20260831_000001_task_checklist(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('task_checklist').execute();
  });
}

// ---- 20260831_000002_command_execution.ts ----
/** Durable lifecycle for one registered verification command. */
async function up_m20260831_000002_command_execution(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('command_execution')
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('turn_id', 'text', column => column.notNull())
      .addColumn('thread_id', 'text', column => column.notNull())
      .addColumn('tool_call_id', 'text', column => column.notNull())
      .addColumn('tool_name', 'text', column => column.notNull())
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('repository_revision', 'integer', column => column.notNull())
      .addColumn('command_id', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('cwd', 'text', column => column.notNull())
      .addColumn('timeout_ms', 'integer', column => column.notNull())
      .addColumn('status', 'text', column => column.notNull())
      .addColumn('disposition', 'text')
      .addColumn('started_at', 'timestamptz', column => column.notNull())
      .addColumn('completed_at', 'timestamptz')
      .addPrimaryKeyConstraint('command_execution_pkey', ['session_id', 'turn_id', 'tool_call_id'])
      .addForeignKeyConstraint(
        'command_execution_turn_fkey',
        ['session_id', 'turn_id'],
        'turn',
        ['session_id', 'turn_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE command_execution
      ADD CONSTRAINT command_execution_revision_check CHECK (repository_revision >= 0),
      ADD CONSTRAINT command_execution_timeout_check CHECK (timeout_ms BETWEEN 1 AND 3600000),
      ADD CONSTRAINT command_execution_status_check CHECK (status IN ('running', 'terminal')),
      ADD CONSTRAINT command_execution_disposition_check CHECK (
        disposition IS NULL OR disposition IN (
          'denied',
          'policy_blocked',
          'executed_ok',
          'executed_nonzero',
          'never_ran',
          'outcome_unknown'
        )
      ),
      ADD CONSTRAINT command_execution_terminal_check CHECK (
        (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
        OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
      )
  `.execute(trx);
    await trx.schema
      .createIndex('command_execution_running_idx')
      .on('command_execution')
      .columns(['status', 'session_id', 'turn_id'])
      .where('status', '=', 'running')
      .execute();
  });
}

async function down_m20260831_000002_command_execution(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('command_execution').ifExists().cascade().execute();
  });
}

// ---- 20260831_000003_implementation_plan_grants.ts ----
/** Owner-scoped implementation-plan grant durability. */
async function up_m20260831_000003_implementation_plan_grants(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('implementation_plan_grant')
      .addColumn('tenant_id', 'text', column => column.notNull())
      .addColumn('created_by', 'text', column => column.notNull())
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('grant_id', 'text', column => column.notNull())
      .addColumn('grant', 'jsonb', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('implementation_plan_grant_pkey', ['session_id', 'grant_id'])
      .addForeignKeyConstraint(
        'implementation_plan_grant_session_fkey',
        ['session_id'],
        'session',
        ['session_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await trx.schema
      .createIndex('implementation_plan_grant_owner_idx')
      .on('implementation_plan_grant')
      .columns(['tenant_id', 'created_by', 'session_id', 'grant_id'])
      .execute();
  });
}

async function down_m20260831_000003_implementation_plan_grants(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('implementation_plan_grant').ifExists().cascade().execute();
  });
}

// ---- 20260831_000004_implementation_plan_dispatch_fence.ts ----
/** Durable cross-replica plan dispatch boundary and checkout binding. */
async function up_m20260831_000004_implementation_plan_dispatch_fence(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('implementation_plan_grant').addColumn('checkout_id', 'text').execute();
    await trx.schema.alterTable('implementation_plan_grant').addColumn('workspace_cwd', 'text').execute();
    await trx.schema.alterTable('implementation_plan_grant').addColumn('revoked_at', 'timestamptz').execute();
    // Grants minted before checkout identity existed are deliberately invalidated.
    await sql`
    UPDATE implementation_plan_grant
    SET revoked_at = now()
    WHERE checkout_id IS NULL OR workspace_cwd IS NULL
  `.execute(trx);
    await trx.schema
      .createTable('implementation_plan_dispatch')
      .addColumn('tenant_id', 'text', column => column.notNull())
      .addColumn('created_by', 'text', column => column.notNull())
      .addColumn('session_id', 'text', column => column.notNull())
      .addColumn('turn_id', 'text', column => column.notNull())
      .addColumn('grant_id', 'text', column => column.notNull())
      .addColumn('workspace_cwd', 'text', column => column.notNull())
      .addColumn('checkout_id', 'text', column => column.notNull())
      .addColumn('dispatch_id', 'text', column => column.notNull())
      .addColumn('state', 'text', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addColumn('completed_at', 'timestamptz')
      .addPrimaryKeyConstraint('implementation_plan_dispatch_pkey', ['session_id', 'turn_id', 'dispatch_id'])
      .addForeignKeyConstraint(
        'implementation_plan_dispatch_grant_fkey',
        ['session_id', 'grant_id'],
        'implementation_plan_grant',
        ['session_id', 'grant_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .addForeignKeyConstraint(
        'implementation_plan_dispatch_turn_fkey',
        ['session_id', 'turn_id'],
        'turn',
        ['session_id', 'turn_id'],
        constraint => constraint.onDelete('cascade'),
      )
      .addCheckConstraint('implementation_plan_dispatch_state_check', sql`state IN ('dispatching', 'completed')`)
      .execute();
    await trx.schema
      .createIndex('implementation_plan_dispatch_pending_idx')
      .on('implementation_plan_dispatch')
      .columns(['session_id', 'grant_id', 'state'])
      .execute();
  });
}

async function down_m20260831_000004_implementation_plan_dispatch_fence(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('implementation_plan_dispatch').ifExists().cascade().execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('revoked_at').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('implementation_plan_grant').dropColumn('checkout_id').execute();
  });
}

// ---- 20260901_000001_command_execution_repair.ts ----
/**
 * Converges databases that applied the original command-execution migration
 * with databases that briefly received its expanded replacement under the
 * same migration name.
 */
async function up_m20260901_000001_command_execution_repair(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS command_execution (
        session_id TEXT NOT NULL,
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
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        CONSTRAINT command_execution_pkey PRIMARY KEY (session_id, turn_id, tool_call_id),
        CONSTRAINT command_execution_turn_fkey
          FOREIGN KEY (session_id, turn_id) REFERENCES turn(session_id, turn_id) ON DELETE CASCADE,
        CONSTRAINT command_execution_terminal_check CHECK (
          (status = 'running' AND disposition IS NULL AND completed_at IS NULL)
          OR (status = 'terminal' AND disposition IS NOT NULL AND completed_at IS NOT NULL)
        )
      )
    `.execute(trx);
    await sql`
      ALTER TABLE command_execution
        ADD COLUMN IF NOT EXISTS owner_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `.execute(trx);
    await sql`
      UPDATE command_execution
      SET
        owner_id = COALESCE(owner_id, 'legacy-migration'),
        lease_id = COALESCE(
          lease_id,
          'legacy-command-execution:' || md5(
            length(session_id)::text || ':' || session_id ||
            length(turn_id)::text || ':' || turn_id ||
            length(thread_id)::text || ':' || thread_id ||
            length(tool_call_id)::text || ':' || tool_call_id
          )
        ),
        lease_expires_at = COALESCE(lease_expires_at, TIMESTAMPTZ '1970-01-01 00:00:00+00')
      WHERE owner_id IS NULL OR lease_id IS NULL OR lease_expires_at IS NULL
    `.execute(trx);
    await sql`
      ALTER TABLE command_execution
        ALTER COLUMN owner_id SET NOT NULL,
        ALTER COLUMN lease_id SET NOT NULL,
        ALTER COLUMN lease_expires_at SET NOT NULL,
        DROP CONSTRAINT IF EXISTS command_execution_pkey,
        DROP CONSTRAINT IF EXISTS command_execution_lease_key,
        ADD CONSTRAINT command_execution_pkey
          PRIMARY KEY (session_id, turn_id, thread_id, tool_call_id),
        ADD CONSTRAINT command_execution_lease_key UNIQUE (lease_id)
    `.execute(trx);
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
        mutation_epoch INTEGER NOT NULL DEFAULT 0,
        lease_owner_id TEXT,
        lease_id TEXT UNIQUE,
        lease_expires_at TIMESTAMPTZ,
        observation_pending BOOLEAN NOT NULL DEFAULT FALSE,
        receipt_state_sha256 TEXT,
        receipt_command TEXT,
        receipt_created_at TIMESTAMPTZ,
        receipt_result_session_id TEXT,
        receipt_result_turn_id TEXT,
        receipt_result_thread_id TEXT,
        receipt_result_tool_call_id TEXT,
        receipt_result_event_id TEXT,
        CONSTRAINT repository_workspace_verification_pkey PRIMARY KEY (repository_id, workspace_cwd),
        CONSTRAINT repository_workspace_verification_epoch_check CHECK (mutation_epoch >= 0),
        CONSTRAINT repository_workspace_verification_lease_check CHECK (
          (lease_id IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
          OR (lease_id IS NOT NULL AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        ),
        CONSTRAINT repository_workspace_verification_receipt_check CHECK (
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
      )
    `.execute(trx);
  });
}

/** The original three-column command key cannot represent every repaired row. */
async function down_m20260901_000001_command_execution_repair(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    throw new Error('20260901_000001_command_execution_repair is not reversible');
  });
}

// ---- 20260901_000010_personalization_learned_profile.ts ----
/**
 * Host-maintained learned profile document on the personalization profile.
 * Nullable: existing rows have learned nothing yet.
 */
async function up_m20260901_000010_personalization_learned_profile(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').addColumn('learned_profile', 'text').execute();
}

async function down_m20260901_000010_personalization_learned_profile(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('learned_profile').execute();
}

// ---- 20260902_000010_personalization_learning_enabled.ts ----
/**
 * User switch for the learned-profile distillation pass, carried on the personalization profile.
 * Defaults to false so an existing profile and a fresh deployment both start with learning off.
 */
async function up_m20260902_000010_personalization_learning_enabled(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('personalization_profile')
    .addColumn('learning_enabled', 'boolean', col => col.notNull().defaultTo(false))
    .execute();
}

async function down_m20260902_000010_personalization_learning_enabled(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('learning_enabled').execute();
}

// ---- 20260913_000001_space.ts ----
/** Durable spaces: a persistent, named, structured page the model creates and updates. */
async function up_m20260913_000001_space(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('space_aggregate')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('revision', 'integer', col => col.notNull())
      .addPrimaryKeyConstraint('space_aggregate_pkey', ['tenant_id', 'created_by'])
      .addCheckConstraint('space_aggregate_revision_check', sql`revision >= 0`)
      .execute();
    await trx.schema
      .createTable('space')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('id', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('purpose', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('body', 'text', col => col.notNull().defaultTo(''))
      .addColumn('revision', 'integer', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('space_pkey', ['tenant_id', 'created_by', 'id'])
      .addCheckConstraint('space_status_check', sql`status IN ('active', 'archived')`)
      .addCheckConstraint('space_revision_check', sql`revision >= 1`)
      .execute();
    await trx.schema
      .createIndex('space_list_idx')
      .on('space')
      .columns(['tenant_id', 'created_by', 'status', 'name', 'id'])
      .execute();
  });
}

async function down_m20260913_000001_space(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('space').execute();
    await trx.schema.dropTable('space_aggregate').execute();
  });
}

// ---- 20260914_000001_space_format.ts ----
/**
 * `format` on `space`: `markdown` (default) or `html`. `20260913_000001_space` already shipped
 * (build fe3d8653) without this column, so it is added here rather than edited in place.
 */
async function up_m20260914_000001_space_format(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('space')
      .addColumn('format', 'text', col => col.notNull().defaultTo('markdown'))
      .execute();
    await trx.schema
      .alterTable('space')
      .addCheckConstraint('space_format_check', sql`format IN ('markdown', 'html')`)
      .execute();
  });
}

async function down_m20260914_000001_space_format(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('space').dropConstraint('space_format_check').execute();
    await trx.schema.alterTable('space').dropColumn('format').execute();
  });
}

// ---- 20260914_000002_turn_artifact.ts ----
/**
 * Persisted sandbox-artifact bytes, copied from the sandbox once a turn finishes so a download
 * outlives the sandbox that produced it (the provider auto-stops and later deletes it).
 * `artifact_blob` is content-addressed and deduplicated by digest within a tenant; `turn_artifact`
 * is the per-turn, per-path index the download route looks up.
 */
async function up_m20260914_000002_turn_artifact(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('artifact_blob')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('digest', 'text', col => col.notNull())
      .addColumn('size', 'integer', col => col.notNull())
      .addColumn('mime', 'text', col => col.notNull())
      .addColumn('data', 'bytea', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('artifact_blob_pkey', ['tenant_id', 'digest'])
      .addCheckConstraint('artifact_blob_size_check', sql`size >= 0`)
      .execute();
    await trx.schema
      .createTable('turn_artifact')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('session_id', 'text', col => col.notNull())
      .addColumn('turn_id', 'text', col => col.notNull())
      .addColumn('path', 'text', col => col.notNull())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('digest', 'text')
      .addColumn('size', 'integer')
      .addColumn('mime', 'text')
      .addColumn('skip_reason', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('turn_artifact_pkey', ['tenant_id', 'session_id', 'turn_id', 'path'])
      .addCheckConstraint('turn_artifact_status_check', sql`status IN ('stored', 'skipped_size', 'skipped_missing')`)
      .execute();
    await trx.schema
      .createIndex('turn_artifact_session_idx')
      .on('turn_artifact')
      .columns(['tenant_id', 'session_id', 'turn_id'])
      .execute();
  });
}

async function down_m20260914_000002_turn_artifact(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('turn_artifact').execute();
    await trx.schema.dropTable('artifact_blob').execute();
  });
}

export const preSyncPostgresMigrations: Record<string, Migration> = {
  '20260727_000001_init': { up: up_m20260727_000001_init, down: down_m20260727_000001_init },
  '20260728_000001_session_store': { up: up_m20260728_000001_session_store, down: down_m20260728_000001_session_store },
  '20260803_000001_mcp_oauth': { up: up_m20260803_000001_mcp_oauth, down: down_m20260803_000001_mcp_oauth },
  '20260803_000001_model_provider': {
    up: up_m20260803_000001_model_provider,
    down: down_m20260803_000001_model_provider,
  },
  '20260803_000002_session_scoped_keys': {
    up: up_m20260803_000002_session_scoped_keys,
    down: down_m20260803_000002_session_scoped_keys,
  },
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
  '20260825_000001_session_folders': {
    up: up_m20260825_000001_session_folders,
    down: down_m20260825_000001_session_folders,
  },
  '20260826_000001_session_approval_grants_repair': {
    up: up_m20260826_000001_session_approval_grants_repair,
    down: down_m20260826_000001_session_approval_grants_repair,
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
