export const VERIFY_COMMAND_PURPOSES = ['build', 'test', 'verify'] as const;
export type VerifyCommandPurpose = (typeof VERIFY_COMMAND_PURPOSES)[number];
export const VERIFY_COMMAND_PROPOSAL_SOURCE_KINDS = ['agents_md', 'package_json'] as const;
export type VerifyCommandProposalSourceKind = (typeof VERIFY_COMMAND_PROPOSAL_SOURCE_KINDS)[number];

/** The database constraint and both stores use this same bounded timeout. */
export const MAX_VERIFY_COMMAND_TIMEOUT_MS = 3_600_000;

export interface RepositoryRecord {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CreateRepositoryInput {
  tenant_id: string;
  created_by: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
}

export interface RepositoryOwnerInput {
  tenant_id: string;
  created_by: string;
}

export interface GetRepositoryInput extends RepositoryOwnerInput {
  repository_id: string;
}

export interface SessionBindingRecord {
  tenant_id: string;
  session_id: string;
  created_by: string;
  repository_id: string | null;
  workspace_cwd: string | null;
}

export interface BindSessionInput extends GetRepositoryInput {
  session_id: string;
  workspace_cwd: string;
  expected_revision: number | undefined;
}

export interface UnbindSessionInput extends RepositoryOwnerInput {
  session_id: string;
  expected_revision: number | undefined;
}

export interface VerifyCommandRecord {
  repository_id: string;
  command_id: string;
  purpose: VerifyCommandPurpose;
  command: string;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

export interface VerifyCommandMutationResult {
  command: VerifyCommandRecord;
  repository_revision: number;
}

export interface VerifyCommandInput extends GetRepositoryInput {
  command_id: string;
  purpose: VerifyCommandPurpose;
  command: string;
  timeout_ms: number;
  expected_revision: number | undefined;
}

export interface DeleteVerifyCommandInput extends GetRepositoryInput {
  command_id: string;
  expected_revision: number | undefined;
}

export interface VerifyCommandProposalRecord {
  id: string;
  repository_id: string;
  purpose: VerifyCommandPurpose;
  command: string;
  source_kind: VerifyCommandProposalSourceKind;
  source_path: string;
  source_fingerprint: string;
  created_at: string;
}

export interface VerifyCommandProposalWrite {
  id: string;
  purpose: VerifyCommandPurpose;
  command: string;
  source_kind: VerifyCommandProposalSourceKind;
  source_path: string;
  source_fingerprint: string;
}

export type VerifyCommandProposalInput = GetRepositoryInput & VerifyCommandProposalWrite;

export interface VerifyCommandProposalSource {
  source_kind: VerifyCommandProposalSourceKind;
  source_path: string;
}

export interface ReplaceVerifyCommandProposalsInput extends GetRepositoryInput {
  expected_revision: number;
  observed_sources: readonly VerifyCommandProposalSource[];
  proposals: readonly VerifyCommandProposalWrite[];
}

export interface DeleteVerifyCommandProposalInput extends GetRepositoryInput {
  proposal_id: string;
}

export interface ConfirmVerifyCommandProposalInput extends GetRepositoryInput {
  proposal_id: string;
  command_id: string;
  timeout_ms: number;
  expected_revision: number | undefined;
}

export interface WorkspaceVerificationLeaseInput {
  repository_id: string;
  workspace_cwd: string;
  owner_id: string;
  lease_id: string;
  lease_expires_at: Date;
}

export interface ObserveWorkspaceVerificationStateInput {
  repository_id: string;
  workspace_cwd: string;
  lease_id: string;
  before_state_sha256: string;
  after_state_sha256: string | null;
}

export interface ActivateWorkspaceVerificationReceiptInput {
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
}

export interface ConsumeWorkspaceVerificationReceiptInput {
  repository_id: string;
  workspace_cwd: string;
  lease_id: string;
  mutation_epoch: number;
  state_sha256: string;
}

export class RepositoryNameConflictError extends Error {
  readonly tenant_id: string;
  readonly created_by: string;
  readonly repository_name: string;

  constructor(input: { tenant_id: string; created_by: string; name: string }, options?: ErrorOptions) {
    super(`Repository name already exists: ${input.name}`, options);
    this.name = 'RepositoryNameConflictError';
    this.tenant_id = input.tenant_id;
    this.created_by = input.created_by;
    this.repository_name = input.name;
  }
}

export class RepositoryRevisionConflictError extends Error {
  readonly repository_id: string;
  readonly expected_revision: number;
  readonly actual_revision: number;

  constructor(input: { repository_id: string; expected_revision: number; actual_revision: number }) {
    super(`Repository revision conflict: ${input.repository_id}`);
    this.name = 'RepositoryRevisionConflictError';
    this.repository_id = input.repository_id;
    this.expected_revision = input.expected_revision;
    this.actual_revision = input.actual_revision;
  }
}

export class VerifyCommandTimeoutError extends Error {
  readonly timeout_ms: number;

  constructor(timeoutMs: number) {
    super(`Verification command timeout must be between 1 and ${String(MAX_VERIFY_COMMAND_TIMEOUT_MS)} milliseconds`);
    this.name = 'VerifyCommandTimeoutError';
    this.timeout_ms = timeoutMs;
  }
}

export class RepositoryWorkspaceCwdError extends Error {
  constructor() {
    super('Repository workspace cwd must be a non-empty absolute checkout path');
    this.name = 'RepositoryWorkspaceCwdError';
  }
}

export interface IRepositoryStore<TTransaction = never> {
  createRepository(input: CreateRepositoryInput, transaction?: TTransaction): Promise<RepositoryRecord>;
  getRepository(input: GetRepositoryInput, transaction?: TTransaction): Promise<RepositoryRecord | undefined>;
  listRepositories(input: RepositoryOwnerInput, transaction?: TTransaction): Promise<RepositoryRecord[]>;
  bindSession(input: BindSessionInput, transaction?: TTransaction): Promise<SessionBindingRecord | undefined>;
  unbindSession(input: UnbindSessionInput, transaction?: TTransaction): Promise<SessionBindingRecord | undefined>;
  listVerifyCommands(input: GetRepositoryInput, transaction?: TTransaction): Promise<VerifyCommandRecord[]>;
  upsertVerifyCommand(
    input: VerifyCommandInput,
    transaction?: TTransaction,
  ): Promise<VerifyCommandMutationResult | undefined>;
  deleteVerifyCommand(input: DeleteVerifyCommandInput, transaction?: TTransaction): Promise<void>;
  listVerifyCommandProposals(
    input: GetRepositoryInput,
    transaction?: TTransaction,
  ): Promise<VerifyCommandProposalRecord[]>;
  upsertVerifyCommandProposal(
    input: VerifyCommandProposalInput,
    transaction?: TTransaction,
  ): Promise<VerifyCommandProposalRecord | undefined>;
  replaceVerifyCommandProposals(input: ReplaceVerifyCommandProposalsInput, transaction?: TTransaction): Promise<void>;
  deleteVerifyCommandProposal(input: DeleteVerifyCommandProposalInput, transaction?: TTransaction): Promise<void>;
  confirmVerifyCommandProposal(
    input: ConfirmVerifyCommandProposalInput,
    transaction?: TTransaction,
  ): Promise<VerifyCommandMutationResult | undefined>;
  acquireLease(input: WorkspaceVerificationLeaseInput): Promise<{ mutation_epoch: number } | undefined>;
  renewLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id' | 'lease_expires_at'>,
  ): Promise<boolean>;
  releaseLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'>,
  ): Promise<void>;
  beginStateObservation(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'> & {
      invalidate_receipt: boolean;
    },
  ): Promise<boolean>;
  observeState(input: ObserveWorkspaceVerificationStateInput): Promise<number | undefined>;
  activateReceipt(input: ActivateWorkspaceVerificationReceiptInput): Promise<boolean>;
  consumeReceipt(input: ConsumeWorkspaceVerificationReceiptInput): Promise<boolean>;
}
