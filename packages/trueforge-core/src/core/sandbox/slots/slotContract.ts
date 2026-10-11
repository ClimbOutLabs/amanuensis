import { z } from 'zod';

/** Socket file name inside a slot's control directory. */
export const SLOT_AGENT_SOCKET_NAME = 'agent.sock';

/** The agent build and gVisor release this server was written against; a slot reporting others is refused. */
export const SLOT_AGENT_VERSION = '0.1.0';
export const SLOT_RUNSC_VERSION = 'runsc version release-20260928.0';
export const SLOT_PLATFORM = 'systrap';

/** An attestation older than this (a call can hold the lease for 10 minutes) no longer proves anything. */
export const SLOT_ATTESTATION_MAX_AGE_MS = 15 * 60_000;

/** Health probes include the agent's first runtime check, which starts a guest. */
export const SLOT_HEALTH_TIMEOUT_MS = 120_000;
/** Pause between passes while a slot is running another call. */
export const SLOT_QUEUE_POLL_MS = 250;
/** The agent stops the program slightly before the server's own timer so partial output survives. */
export const SLOT_AGENT_TIMEOUT_MARGIN_MS = 750;
export const SLOT_MIN_AGENT_TIMEOUT_MS = 1_000;

/**
 * Attestation checks the agent reports. A slot is usable only when every one is present and passing;
 * the agent refuses calls on its own when any fails, and the server refuses the slot independently.
 */
export const SLOT_REQUIRED_CHECKS = [
  'pid1',
  'identity',
  'capabilities',
  'no_new_privs',
  'seccomp',
  'read_only_root',
  'network',
  'no_docker_socket',
  'cgroup_limits',
  'apparmor',
  'proc_fs',
  'runsc',
] as const;

const SlotAttestationCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

export const SlotAttestationSchema = z.object({
  schema: z.literal(1),
  agent_version: z.string(),
  ok: z.boolean(),
  checked_at: z.string(),
  checks: z.array(SlotAttestationCheckSchema),
  facts: z.object({
    kernel: z.string(),
    arch: z.string(),
    page_size: z.number().int(),
    cgroup: z.string(),
    apparmor: z.string(),
    runsc_version: z.string(),
    platform: z.string(),
  }),
});
export type SlotAttestation = z.infer<typeof SlotAttestationSchema>;

export const SlotHealthResponseSchema = z.object({
  busy: z.boolean(),
  /** Session trees on the slot, used to place a new chat on the emptiest one. */
  sessions: z.number().int().nonnegative(),
  attestation: SlotAttestationSchema,
});
export type SlotHealthResponse = z.infer<typeof SlotHealthResponseSchema>;

export const SLOT_TERMINATIONS = [
  'completed',
  'timeout',
  'oom',
  'killed',
  'internal',
  'output_exceeded',
  'disk_exceeded',
] as const;
const SlotTerminationSchema = z.enum(SLOT_TERMINATIONS);
export type SlotTerminationName = z.infer<typeof SlotTerminationSchema>;

export const SlotRunCodeRequestSchema = z.object({
  run_id: z.string().regex(/^[0-9a-f]{32}$/),
  argv: z.array(z.string()),
  files_in: z.array(z.object({ name: z.string(), content_base64: z.string() })),
  timeout_ms: z.number().int(),
  disk_mb: z.number().int(),
});
export type SlotRunCodeRequest = z.infer<typeof SlotRunCodeRequestSchema>;

export const SlotRunCodeResponseSchema = z.object({
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  terminated_by: SlotTerminationSchema,
  internal_error: z.string(),
  files_out: z.array(z.object({ dir: z.enum(['egress', 'scratch']), name: z.string(), content_base64: z.string() })),
  warnings: z.array(z.string()),
  duration_ms: z.number().int(),
});
export type SlotRunCodeResponse = z.infer<typeof SlotRunCodeResponseSchema>;

export const SlotExecRequestSchema = z.object({
  session_id: z.string().regex(/^[0-9a-f]{32}$/),
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  timeout_ms: z.number().int(),
  disk_mb: z.number().int(),
});
export type SlotExecRequest = z.infer<typeof SlotExecRequestSchema>;

export const SlotExecResponseSchema = z.object({
  exit_code: z.number().int(),
  output: z.string(),
  terminated_by: SlotTerminationSchema,
  internal_error: z.string(),
  duration_ms: z.number().int(),
});
export type SlotExecResponse = z.infer<typeof SlotExecResponseSchema>;

export const SlotFsReadResponseSchema = z.object({
  content_base64: z.string(),
  size_bytes: z.number().int(),
});
export type SlotFsReadResponse = z.infer<typeof SlotFsReadResponseSchema>;

export const SLOT_ERROR_CODES = [
  'invalid_request',
  'busy',
  'isolation_refused',
  'internal',
  'not_found',
  'storage_full',
] as const;
export const SlotErrorBodySchema = z.object({
  error: z.object({ code: z.enum(SLOT_ERROR_CODES), message: z.string() }),
});
export type SlotErrorCode = (typeof SLOT_ERROR_CODES)[number];
