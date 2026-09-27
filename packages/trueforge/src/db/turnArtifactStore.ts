/**
 * Sandbox artifacts a turn declared in its final `sandbox_artifacts` block, persisted to host
 * storage once the turn finishes. The sandbox itself is ephemeral (the provider auto-stops it
 * minutes after the turn ends and later deletes it), so this is what makes a download still work
 * hours later. Content-addressed by sha256 digest within a tenant, so the same bytes produced by
 * two different turns (or the same turn retried) are stored once.
 */

export interface TenantScopedInput {
  tenant_id: string;
}

export interface TurnArtifactIdentityInput extends TenantScopedInput {
  session_id: string;
  turn_id: string;
  path: string;
}

export type TurnArtifactStatus = 'stored' | 'skipped_size' | 'skipped_missing';

/** Persisted index row. `digest`/`size`/`mime` are set only when `status` is `stored`. */
export interface TurnArtifactRecord {
  tenant_id: string;
  session_id: string;
  turn_id: string;
  path: string;
  name: string;
  status: TurnArtifactStatus;
  digest: string | null;
  size: number | null;
  mime: string | null;
  skip_reason: string | null;
  created_at: string;
}

export interface RecordStoredArtifactInput extends TurnArtifactIdentityInput {
  name: string;
  data: Buffer;
  mime: string;
}

export interface RecordSkippedArtifactInput extends TurnArtifactIdentityInput {
  name: string;
  status: Extract<TurnArtifactStatus, 'skipped_size' | 'skipped_missing'>;
  skip_reason: string;
  /** The file's actual size, when known (e.g. `skipped_size`); undefined when unknown. */
  size?: number | undefined;
}

/**
 * Durable turn-artifact persistence. Every write is idempotent on
 * `(tenant_id, session_id, turn_id, path)`: a retried persistence pass (e.g. after a host
 * restart mid-drain) overwrites its own prior row rather than conflicting with it.
 */
export interface ITurnArtifactStore<TTransaction = never> {
  /** Writes the blob (deduplicated by digest) and the index row in one unit; returns the index row. */
  recordStoredArtifact(input: RecordStoredArtifactInput, transaction?: TTransaction): Promise<TurnArtifactRecord>;
  /** Writes an index row with no blob, recording why the file was not kept. */
  recordSkippedArtifact(input: RecordSkippedArtifactInput, transaction?: TTransaction): Promise<TurnArtifactRecord>;
  /** The index row for one turn/path, or undefined when no persistence has happened for it yet. */
  getArtifact(input: TurnArtifactIdentityInput, transaction?: TTransaction): Promise<TurnArtifactRecord | undefined>;
  /** The stored bytes for a digest, or undefined if somehow absent (index row would say `stored` regardless). */
  getBlob(input: TenantScopedInput & { digest: string }, transaction?: TTransaction): Promise<Buffer | undefined>;
  /**
   * Every artifact index row for one turn, newest first. The UI lists these
   * without parsing assistant prose; run_code harvests appear under their
   * `run_code/` paths alongside exec-sandbox `sandbox_artifacts` rows.
   */
  listArtifacts(
    input: TenantScopedInput & { session_id: string; turn_id: string },
    transaction?: TTransaction,
  ): Promise<TurnArtifactRecord[]>;
  /**
   * Retention sweep: deletes index rows older than `older_than` (ISO 8601)
   * across all tenants, then deletes blobs no remaining row references.
   * Blobs shared with a surviving row are kept. Returns the deleted row count.
   */
  deleteArtifactsOlderThan(
    input: { older_than: string },
    transaction?: TTransaction,
  ): Promise<number>;
}
