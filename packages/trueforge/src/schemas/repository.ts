import { z } from '@hono/zod-openapi';
import { VERIFY_COMMAND_PROPOSAL_SOURCE_KINDS, VERIFY_COMMAND_PURPOSES } from '../db/repositoryStore';

export const RepositoryIdSchema = z.string().min(1).max(64).describe('Stable repository identifier.');
export const RepositoryRevisionSchema = z.number().int().nonnegative().describe('Optimistic-concurrency revision.');
export const VerifyCommandPurposeSchema = z.enum(VERIFY_COMMAND_PURPOSES).openapi('VerifyCommandPurpose');
export const VerifyCommandProposalSourceKindSchema = z
  .enum(VERIFY_COMMAND_PROPOSAL_SOURCE_KINDS)
  .openapi('VerifyCommandProposalSourceKind');

const RepositoryNameSchema = z.string().trim().min(1).max(120);
const CloneUrlSchema = z.string().trim().min(1).max(2_048);
const DefaultBranchSchema = z.string().trim().min(1).max(255).nullable();
const WorkspaceCwdSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe('Absolute checkout path inside the configured sandbox provider.');
const CommandIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const RepositoryParamsSchema = z.object({ repository_id: RepositoryIdSchema }).openapi('RepositoryParams');
export const VerifyCommandParamsSchema = z
  .object({ repository_id: RepositoryIdSchema, command_id: CommandIdSchema })
  .openapi('VerifyCommandParams');
export const VerifyCommandProposalParamsSchema = z
  .object({ repository_id: RepositoryIdSchema, proposal_id: z.string().min(1).max(128) })
  .openapi('VerifyCommandProposalParams');
const OptionalRepositoryRevisionQueryParamSchema = z
  .preprocess(
    value => (value === null || value === '' ? undefined : value),
    z.coerce.number().int().nonnegative().optional(),
  )
  .openapi({ type: 'integer', minimum: 0 });
export const DeleteVerifyCommandsRequestQuerySchema = z
  .object({ expected_revision: OptionalRepositoryRevisionQueryParamSchema })
  .openapi('DeleteVerifyCommandsRequestQuery');
export const DeleteSessionRepositoryRequestQuerySchema = z
  .object({ expected_revision: OptionalRepositoryRevisionQueryParamSchema })
  .openapi('DeleteSessionRepositoryRequestQuery');

export const RepositorySchema = z
  .object({
    id: RepositoryIdSchema,
    name: RepositoryNameSchema,
    clone_url: CloneUrlSchema,
    default_branch: DefaultBranchSchema,
    revision: RepositoryRevisionSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict()
  .openapi('Repository');

export const CreateRepositoryPayloadSchema = z
  .object({
    name: RepositoryNameSchema,
    clone_url: CloneUrlSchema,
    default_branch: DefaultBranchSchema.default(null),
  })
  .strict()
  .openapi('CreateRepositoryPayload');

export const CreateRepositoryRequestSchema = z
  .object({ repository: CreateRepositoryPayloadSchema })
  .strict()
  .openapi('CreateRepositoryRequest');

export const VerifyCommandSchema = z
  .object({
    command_id: CommandIdSchema,
    purpose: VerifyCommandPurposeSchema,
    command: z.string().trim().min(1).max(8_192),
    timeout_ms: z.number().int().positive(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict()
  .openapi('VerifyCommand');

export const UpsertVerifyCommandRequestSchema = z
  .object({
    purpose: VerifyCommandPurposeSchema,
    command: z.string().trim().min(1).max(8_192),
    timeout_ms: z.number().int().positive(),
    expected_revision: RepositoryRevisionSchema.optional(),
  })
  .strict()
  .openapi('UpsertVerifyCommandRequest');

export const VerifyCommandProposalSchema = z
  .object({
    id: z.string().min(1).max(128),
    purpose: VerifyCommandPurposeSchema,
    command: z.string().min(1).max(8_192),
    source_kind: VerifyCommandProposalSourceKindSchema,
    source_path: z.string().min(1).max(4_096),
    source_fingerprint: z.string().min(1).max(256),
    created_at: z.iso.datetime(),
  })
  .strict()
  .openapi('VerifyCommandProposal');

export const ConfirmVerifyCommandProposalRequestSchema = z
  .object({
    command_id: CommandIdSchema,
    timeout_ms: z.number().int().positive(),
    expected_revision: RepositoryRevisionSchema.optional(),
  })
  .strict()
  .openapi('ConfirmVerifyCommandProposalRequest');

export const BindSessionRepositoryRequestSchema = z
  .object({
    repository_id: RepositoryIdSchema,
    workspace_cwd: WorkspaceCwdSchema,
    expected_revision: RepositoryRevisionSchema.optional(),
  })
  .strict()
  .openapi('BindSessionRepositoryRequest');

export const SessionRepositoryBindingSchema = z
  .object({
    session_id: z.string().min(1),
    repository_id: RepositoryIdSchema.nullable(),
    workspace_cwd: WorkspaceCwdSchema.nullable(),
  })
  .strict()
  .openapi('SessionRepositoryBinding');

export const GetRepositoryResponseSchema = z.object({ data: RepositorySchema }).openapi('GetRepositoryResponse');
export const ListRepositoriesResponseSchema = z
  .object({ data: z.array(RepositorySchema) })
  .openapi('ListRepositoriesResponse');
export const VerifyCommandsDataSchema = z
  .object({ commands: z.array(VerifyCommandSchema), repository_revision: RepositoryRevisionSchema })
  .strict()
  .openapi('VerifyCommandsData');
export const VerifyCommandDataSchema = z
  .object({ ...VerifyCommandSchema.shape, repository_revision: RepositoryRevisionSchema })
  .strict()
  .openapi('VerifyCommandData');
export const VerifyCommandProposalsDataSchema = z
  .object({ proposals: z.array(VerifyCommandProposalSchema), repository_revision: RepositoryRevisionSchema })
  .strict()
  .openapi('VerifyCommandProposalsData');

export const ListVerifyCommandsResponseSchema = z
  .object({ data: VerifyCommandsDataSchema })
  .strict()
  .openapi('ListVerifyCommandsResponse');
export const GetVerifyCommandResponseSchema = z
  .object({ data: VerifyCommandDataSchema })
  .strict()
  .openapi('GetVerifyCommandResponse');
export const ListVerifyCommandProposalsResponseSchema = z
  .object({ data: VerifyCommandProposalsDataSchema })
  .strict()
  .openapi('ListVerifyCommandProposalsResponse');
export const GetSessionRepositoryBindingResponseSchema = z
  .object({ data: SessionRepositoryBindingSchema })
  .openapi('GetSessionRepositoryBindingResponse');
export const DeleteSessionRepositoryBindingResponseSchema = z
  .object({})
  .openapi('DeleteSessionRepositoryBindingResponse');
export const DeleteVerifyCommandResponseSchema = z.object({}).openapi('DeleteVerifyCommandResponse');
export const DeleteVerifyCommandProposalResponseSchema = z.object({}).openapi('DeleteVerifyCommandProposalResponse');

export type RepositoryWire = z.infer<typeof RepositorySchema>;
export type VerifyCommandWire = z.infer<typeof VerifyCommandSchema>;
export type VerifyCommandProposalWire = z.infer<typeof VerifyCommandProposalSchema>;
