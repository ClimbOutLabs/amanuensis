import type {
  WorkspaceVerificationCoordinator,
  WorkspaceVerificationLeaseInput,
} from '../../../src/core/sandbox/Sandbox';

interface WorkspaceRow {
  mutationEpoch: number;
  leaseId: string | undefined;
  leaseExpiresAt: Date | undefined;
  observationPending: boolean;
  receiptState: string | undefined;
}

/** Test double with shared state and the same ownership predicates as the SQL stores. */
export class TestDurableWorkspaceCoordinator implements WorkspaceVerificationCoordinator {
  readonly #rows = new Map<string, WorkspaceRow>();

  seedReceipt(input: { repository_id: string; workspace_cwd: string; state_sha256: string }): void {
    this.#rows.set(this.#key(input), {
      mutationEpoch: 0,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      observationPending: false,
      receiptState: input.state_sha256,
    });
  }

  hasReceipt(input: { repository_id: string; workspace_cwd: string }): boolean {
    return this.#rows.get(this.#key(input))?.receiptState !== undefined;
  }

  async acquireLease(input: WorkspaceVerificationLeaseInput): Promise<{ mutation_epoch: number } | undefined> {
    await Promise.resolve();
    const key = this.#key(input);
    const row = this.#rows.get(key) ?? {
      mutationEpoch: 0,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      observationPending: false,
      receiptState: undefined,
    };
    if (row.leaseId !== undefined && (row.leaseExpiresAt?.getTime() ?? 0) > Date.now()) {
      return undefined;
    }
    if (row.observationPending) {
      row.mutationEpoch += 1;
      row.receiptState = undefined;
      row.observationPending = false;
    }
    row.leaseId = input.lease_id;
    row.leaseExpiresAt = input.lease_expires_at;
    this.#rows.set(key, row);
    return { mutation_epoch: row.mutationEpoch };
  }

  async renewLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id' | 'lease_expires_at'>,
  ): Promise<boolean> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (row?.leaseId !== input.lease_id) {
      return false;
    }
    if ((row.leaseExpiresAt?.getTime() ?? 0) < input.lease_expires_at.getTime()) {
      row.leaseExpiresAt = input.lease_expires_at;
    }
    return true;
  }

  async releaseLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'>,
  ): Promise<void> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (row?.leaseId === input.lease_id) {
      row.leaseId = undefined;
      row.leaseExpiresAt = undefined;
    }
  }

  async beginStateObservation(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'> & {
      invalidate_receipt: boolean;
    },
  ): Promise<boolean> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (row?.leaseId !== input.lease_id || (row.leaseExpiresAt?.getTime() ?? 0) <= Date.now()) {
      return false;
    }
    row.observationPending = true;
    if (input.invalidate_receipt) {
      row.receiptState = undefined;
    }
    return true;
  }

  async observeState(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    before_state_sha256: string;
    after_state_sha256: string | null;
  }): Promise<number | undefined> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (row?.leaseId !== input.lease_id || !row.observationPending) {
      return undefined;
    }
    if (input.after_state_sha256 === null || input.after_state_sha256 !== input.before_state_sha256) {
      row.mutationEpoch += 1;
      row.receiptState = undefined;
    }
    row.observationPending = false;
    return row.mutationEpoch;
  }

  async activateReceipt(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    mutation_epoch: number;
    state_sha256: string;
    command: string;
    created_at: Date;
    result_event_id: string;
    result_thread_id: string;
    result_tool_call_id: string;
  }): Promise<boolean> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (
      row?.leaseId !== input.lease_id ||
      (row.leaseExpiresAt?.getTime() ?? 0) <= Date.now() ||
      row.observationPending ||
      row.mutationEpoch !== input.mutation_epoch
    ) {
      return false;
    }
    row.receiptState = input.state_sha256;
    return true;
  }

  async consumeReceipt(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    mutation_epoch: number;
    state_sha256: string;
  }): Promise<boolean> {
    await Promise.resolve();
    const row = this.#rows.get(this.#key(input));
    if (
      row?.leaseId !== input.lease_id ||
      (row.leaseExpiresAt?.getTime() ?? 0) <= Date.now() ||
      row.observationPending ||
      row.mutationEpoch !== input.mutation_epoch ||
      row.receiptState !== input.state_sha256
    ) {
      return false;
    }
    row.receiptState = undefined;
    return true;
  }

  #key(input: { repository_id: string; workspace_cwd: string }): string {
    return `${input.repository_id}\u0000${input.workspace_cwd}`;
  }
}
