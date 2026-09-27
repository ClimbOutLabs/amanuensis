import { z } from 'zod';

/** Why a turn stopped before it could provide its ordinary final response. */
export const AbnormalHandoffCauseSchema = z
  .enum([
    'client_cancelled',
    'server_cancelled',
    'iteration_limit',
    'fatal_error',
    'model_stream_fault',
    'model_response_timeout',
    'loop_detected',
  ])
  .describe('Host-classified reason the turn produced an abnormal handoff.');

export const HandoffChangedFileSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const HandoffRepositoryBindingSchema = z.object({
  repository_id: z.string(),
  revision: z.number().int().nonnegative().nullable(),
  workspace_cwd: z.string(),
});

export const HandoffRepositoryEvidenceSchema = HandoffRepositoryBindingSchema.extend({
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
  changed_files: z.array(HandoffChangedFileSchema),
  changed_file_count: z.number().int().nonnegative(),
  changed_files_truncated: z.boolean(),
  diffstat: z.array(z.string()),
  diffstat_truncated: z.boolean(),
  overflow_artifact: z.string().nullable(),
});

export const HandoffVerificationReceiptSchema = z.object({
  status: z.enum(['available', 'not_available']),
  command: z.string().nullable(),
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
  state_sha256: z.string().nullable(),
});

/** Host-computed evidence attached to every abnormal terminal state. */
export const AbnormalHandoffEvidenceSchema = z.object({
  repository: HandoffRepositoryEvidenceSchema.nullable(),
  verification_receipt: HandoffVerificationReceiptSchema,
});

/** A durable handoff. `summary` is null when model recovery is unavailable. */
export const AbnormalHandoffSchema = z.object({
  cause: AbnormalHandoffCauseSchema,
  summary: z.string().nullable(),
  evidence: AbnormalHandoffEvidenceSchema,
});

export type AbnormalHandoffCause = z.infer<typeof AbnormalHandoffCauseSchema>;
export type AbnormalHandoffEvidence = z.infer<typeof AbnormalHandoffEvidenceSchema>;
export type AbnormalHandoff = z.infer<typeof AbnormalHandoffSchema>;
export type HandoffRepositoryBinding = z.infer<typeof HandoffRepositoryBindingSchema>;

/** Bounded evidence used when no live runtime can safely inspect the checkout. */
export function unavailableAbnormalHandoffEvidence(
  repository: HandoffRepositoryBinding | undefined,
): AbnormalHandoffEvidence {
  return {
    repository:
      repository === undefined
        ? null
        : {
            ...repository,
            branch: null,
            head_sha: null,
            changed_files: [],
            changed_file_count: 0,
            changed_files_truncated: false,
            diffstat: [],
            diffstat_truncated: false,
            overflow_artifact: null,
          },
    verification_receipt: {
      status: 'not_available',
      command: null,
      branch: null,
      head_sha: null,
      state_sha256: null,
    },
  };
}

/** Model-free abnormal handoff. Repository values come only from host-owned bindings. */
export function mechanicalAbnormalHandoff(input: {
  cause: AbnormalHandoffCause;
  repository: HandoffRepositoryBinding | undefined;
}): AbnormalHandoff {
  return {
    cause: input.cause,
    summary: null,
    evidence: unavailableAbnormalHandoffEvidence(input.repository),
  };
}
