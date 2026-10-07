import { z } from 'zod';

/** Model-visible error codes. One taxonomy for both drivers. */
export const RUN_CODE_ERROR_CODES = [
  'timeout',
  'memory_exceeded',
  'disk_exceeded',
  'output_exceeded',
  'image_unavailable',
  'daemon_unavailable',
  'concurrency_exceeded',
  'invalid_input',
  'internal',
] as const;

export type RunCodeErrorCode = (typeof RUN_CODE_ERROR_CODES)[number];

/** Basename-only: no separators, no traversal, 1-256 chars. */
const FILE_BASENAME_PATTERN = /^([^./\\]|\.[^./\\]|\.\.[^/\\])[^/\\]{0,255}$/;

export const RunCodeLanguageSchema = z.enum(['python', 'node']);

const RunCodeFileInSchema = z.object({
  name: z.string().min(1).max(256).regex(FILE_BASENAME_PATTERN, 'must be a basename (no separators or traversal)'),
  content_base64: z.string().min(1),
});

export const RunCodeInputSchema = z.object({
  language: RunCodeLanguageSchema,
  code: z
    .string()
    .min(1)
    .max(512 * 1024),
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
