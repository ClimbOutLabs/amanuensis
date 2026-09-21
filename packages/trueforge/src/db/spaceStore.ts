import type { SpaceContent, SpaceStatus } from '../schemas/space';

/** Persisted record. Host-owned tenant/user scope stays explicit even though it is not a wire field. */
export interface SpaceRecord extends SpaceContent, OwnerScopedInput {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SpaceAggregate extends OwnerScopedInput {
  revision: number;
}

export interface SpaceMutationResult {
  record: SpaceRecord;
  aggregate_revision: number;
}

export interface OwnerScopedInput {
  tenant_id: string;
  created_by: string;
}

export interface SpaceIdentityInput extends OwnerScopedInput {
  space_id: string;
}

export interface ListSpacesInput extends OwnerScopedInput {
  status: SpaceStatus | undefined;
  /** Model- and UI-visible reads must stay bounded so a large account cannot overflow either surface. */
  limit: number;
  /** Records to skip before applying `limit`, in the same stable name/ID ordering. Defaults to 0. */
  offset?: number | undefined;
}

export interface CreateSpaceInput extends OwnerScopedInput, SpaceContent {
  id: string;
  expected_aggregate_revision: number;
}

export interface UpdateSpaceInput extends SpaceIdentityInput, SpaceContent {
  expected_revision: number;
  expected_aggregate_revision: number;
}

/**
 * Unlike create/update, delete does not take `expected_aggregate_revision`: the aggregate still
 * advances (so a racing paginated list read is fenced the same as any other write), but nothing
 * about deleting a space depends on the aggregate's prior value the way a create/update's field
 * changes do. `expected_revision` alone is enough to guard against deleting a space the caller no
 * longer has the current view of.
 */
export interface DeleteSpaceInput extends SpaceIdentityInput {
  expected_revision: number;
}

/** Identifies one historical revision of a space. */
export interface GetSpaceRevisionInput extends SpaceIdentityInput {
  revision: number;
}

/**
 * Restores a historical revision's content as the new current revision. `revision` is the
 * historical revision to restore; `expected_revision` fences the write against the caller's last
 * observed current revision, exactly like `updateSpace`.
 */
export interface RevertSpaceInput extends SpaceIdentityInput {
  revision: number;
  expected_revision: number;
  expected_aggregate_revision: number;
}

export interface SpaceDeleteResult {
  aggregate_revision: number;
}

export interface SpaceListResult {
  records: SpaceRecord[];
  aggregate_revision: number;
  /** True when more owner-scoped records exist beyond the requested `limit`/`offset` window. */
  has_more: boolean;
  /** Pass back as `offset` to read the next page. Null when `has_more` is false. */
  next_offset: number | null;
}

export class SpaceNotFoundError extends Error {
  readonly id: string;

  constructor(input: { id: string }) {
    super(`Space not found: ${input.id}`);
    this.name = 'SpaceNotFoundError';
    this.id = input.id;
  }
}

export class SpaceRevisionConflictError extends Error {
  readonly id: string;
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(input: { id: string; expected_revision: number; actual_revision: number }) {
    super(`Stale space revision: ${input.id}`);
    this.name = 'SpaceRevisionConflictError';
    this.id = input.id;
    this.expected_revision = input.expected_revision;
    this.actual_revision = input.actual_revision;
  }
}

export class SpaceAggregateRevisionConflictError extends Error {
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(input: { expected_revision: number; actual_revision: number }) {
    super('Stale space aggregate revision');
    this.name = 'SpaceAggregateRevisionConflictError';
    this.expected_revision = input.expected_revision;
    this.actual_revision = input.actual_revision;
  }
}

export class SpaceRevisionNotFoundError extends Error {
  readonly id: string;
  readonly revision: number;

  constructor(input: { id: string; revision: number }) {
    super(`Space revision not found: ${input.id} at revision ${String(input.revision)}`);
    this.name = 'SpaceRevisionNotFoundError';
    this.id = input.id;
    this.revision = input.revision;
  }
}

/**
 * Durable spaces. Every mutation is fenced by a per-owner aggregate revision (`chief_of_staff`'s
 * design, kept here for spaces alone): the caller must present the aggregate revision it last
 * observed, so two racing create/update tool calls cannot silently overwrite one another.
 */
export interface ISpaceStore<TTransaction = never> {
  getAggregate(input: OwnerScopedInput, transaction?: TTransaction): Promise<SpaceAggregate>;
  listSpaces(input: ListSpacesInput, transaction?: TTransaction): Promise<SpaceRecord[]>;
  listSpacesWithAggregate(input: ListSpacesInput, transaction?: TTransaction): Promise<SpaceListResult>;
  getSpace(input: SpaceIdentityInput, transaction?: TTransaction): Promise<SpaceRecord | undefined>;
  /**
   * Reads one revision of a space: the current row when `revision` matches it, otherwise the
   * retained historical snapshot. Returns undefined when the space — or that revision of it —
   * does not exist.
   */
  getSpaceRevision(input: GetSpaceRevisionInput, transaction?: TTransaction): Promise<SpaceRecord | undefined>;
  createSpace(input: CreateSpaceInput, transaction?: TTransaction): Promise<SpaceMutationResult>;
  updateSpace(input: UpdateSpaceInput, transaction?: TTransaction): Promise<SpaceMutationResult>;
  /**
   * Restores a historical revision's content as a new current revision, fenced by
   * `expected_revision` exactly like `updateSpace`. The pre-revert content is snapshotted into
   * history like any other update, so a revert is itself revertible.
   */
  revertSpace(input: RevertSpaceInput, transaction?: TTransaction): Promise<SpaceMutationResult>;
  deleteSpace(input: DeleteSpaceInput, transaction?: TTransaction): Promise<SpaceDeleteResult>;
}
