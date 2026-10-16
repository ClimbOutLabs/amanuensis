import { z } from 'zod';

/** Model-visible error codes. One taxonomy for both drivers. */
export const RUN_CODE_ERROR_CODES = [
  'timeout',
  'memory_exceeded',
  'disk_exceeded',
  'output_exceeded',
  'image_unavailable',
  'daemon_unavailable',
  /** Docker socket not detected: user-actionable install message, surfaced verbatim. */
  'docker_unavailable',
  /** Created container failed isolation verification: refused, surfaced verbatim. */
  'isolation_refused',
  'concurrency_exceeded',
  'invalid_input',
  'internal',
] as const;

export type RunCodeErrorCode = (typeof RUN_CODE_ERROR_CODES)[number];

/**
 * Failures where the sandbox could not start, so no code ran. Their `error` text is written for
 * the user (what to install or repair), unlike the model-directed text of the other codes, and
 * must be shown to the user verbatim.
 */
export const RUN_CODE_SETUP_ERROR_CODES = [
  'image_unavailable',
  'daemon_unavailable',
  'docker_unavailable',
  'isolation_refused',
] as const satisfies readonly RunCodeErrorCode[];

/**
 * Length caps are enforced with `refine`, which the emitted JSON Schema omits: xgrammar (vLLM's
 * grammar compiler) asserts on any bounded repetition above 128, and `.max()` on a string is
 * emitted as `maxLength`, which compiles to one.
 */
const FILE_NAME_MAX_LENGTH = 256;
const CODE_MAX_LENGTH = 512 * 1024;

/**
 * Basename-only: no separators, no `.`/`..`. The alternatives reject `.`/`..` without
 * lookahead, which xgrammar cannot compile, and carry no length bound for the reason above.
 */
const FILE_BASENAME_PATTERN = /^([^./\\][^/\\]*|\.[^./\\][^/\\]*|\.\.[^/\\][^/\\]*)$/;

export const RunCodeFileNameSchema = z
  .string()
  .min(1)
  .regex(FILE_BASENAME_PATTERN, 'must be a basename (no separators or traversal)')
  .refine(name => name.length <= FILE_NAME_MAX_LENGTH, `must be at most ${String(FILE_NAME_MAX_LENGTH)} characters`);

export const RunCodeLanguageSchema = z.enum(['python', 'node']);

const RunCodeFileInSchema = z.object({
  name: RunCodeFileNameSchema,
  content_base64: z.string().min(1),
});

export const RunCodeInputSchema = z.object({
  language: RunCodeLanguageSchema,
  code: z
    .string()
    .min(1)
    .refine(code => code.length <= CODE_MAX_LENGTH, `must be at most ${String(CODE_MAX_LENGTH)} characters`),
  // Model-authored content only (e.g. CSV text the model composes). Conversation
  // attachments are staged into ingress automatically by the harness and
  // advertised in the tool description — the model never base64-encodes them.
  files_in: z.array(RunCodeFileInSchema).max(32).default([]),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
});

export type RunCodeInput = z.infer<typeof RunCodeInputSchema>;

const RunCodeFileOutSchema = z.object({
  name: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

const RunCodeResultBaseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  files_out: z.array(RunCodeFileOutSchema),
  harvest_warnings: z.array(z.string()),
});

/** Always this shape, success or failure. Only `ok` carries `exit_code`. */
export const RunCodeResultSchema = z.discriminatedUnion('status', [
  RunCodeResultBaseSchema.extend({ status: z.literal('ok'), exit_code: z.number().int() }),
  RunCodeResultBaseSchema.extend({
    status: z.literal('failed'),
    error_code: z.enum(RUN_CODE_ERROR_CODES),
    error: z.string(),
  }),
]);

export type RunCodeResult = z.infer<typeof RunCodeResultSchema>;

/** The part of a failed result that identifies a setup failure, for readers of persisted tool output. */
export const RunCodeSetupFailureSchema = z.object({
  status: z.literal('failed'),
  error_code: z.enum(RUN_CODE_SETUP_ERROR_CODES),
  error: z.string().min(1),
});

export type RunCodeSetupFailure = z.infer<typeof RunCodeSetupFailureSchema>;

/** Why the run_code sandbox can or cannot run code right now, as Settings reports it. */
export const RUN_CODE_STATUS_STATES = [
  'ready',
  'not_configured',
  'disabled',
  'docker_unavailable',
  'daemon_unavailable',
  'image_missing',
  'signature_unverified',
  'image_unavailable',
  'isolation_refused',
  'unsupported_platform',
  'slots_unavailable',
] as const;

/** Which backend executes code; absent means Docker, as older servers report. */
export const RUN_CODE_BACKENDS = ['docker', 'slots'] as const;

export const RunCodeStatusSchema = z.object({
  state: z.enum(RUN_CODE_STATUS_STATES).describe('Whether run_code can execute code, or the reason it cannot.'),
  detail: z.string().optional().describe('Technical detail from the sandbox check. Absent when the state says it all.'),
  backend: z
    .enum(RUN_CODE_BACKENDS)
    .optional()
    .describe('Which backend runs code: docker, or the isolated sandbox slots.'),
  instance: z
    .string()
    .optional()
    .describe('Installer instance name, present for the disabled state when the server knows it.'),
});

export type RunCodeStatus = z.infer<typeof RunCodeStatusSchema>;
