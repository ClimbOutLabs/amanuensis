import { z } from '@hono/zod-openapi';

/** One line of the help check. `not_set_up` means the feature is not configured here, which is not a fault. */
export const HelpHealthStatusSchema = z
  .enum(['pass', 'warn', 'fail', 'not_set_up'])
  .describe('Result of one check: pass, warn, fail, or not_set_up when the feature is not configured.')
  .openapi('HelpHealthStatus');

export const HelpHealthItemSchema = z
  .object({
    id: z.string().describe('Stable snake_case id of the check.'),
    name: z.string().describe('Plain name of the check.'),
    status: HelpHealthStatusSchema,
    message: z.string().describe('One plain sentence on what was found.'),
    next_step: z.string().nullable().describe('One plain sentence on what to do next, or null.'),
  })
  .openapi('HelpHealthItem');

export const HelpHostReportStateSchema = z
  .enum(['ok', 'missing', 'invalid', 'stale'])
  .describe('Whether the last full check from the computer can be read and is recent.')
  .openapi('HelpHostReportState');

export const HelpHostReportSchema = z
  .object({
    state: HelpHostReportStateSchema,
    checked_at: z.string().nullable().describe('When the last full check ran, in UTC ISO 8601, or null.'),
    message: z.string().nullable().describe('One plain sentence when the report needs attention, else null.'),
    next_step: z.string().nullable().describe('One plain sentence on what to do next, or null.'),
  })
  .openapi('HelpHostReport');

export const HelpHealthCheckSchema = z
  .object({
    checked_at: z.string().describe('When this check ran, in UTC ISO 8601.'),
    model_ready: z.boolean().describe('Whether the default model answered the test call.'),
    items: z
      .array(HelpHealthItemSchema)
      .describe('Every live check with the model first, then failed or warned lines from the last full check.'),
    host_report: HelpHostReportSchema,
  })
  .openapi('HelpHealthCheck');

export const GetHelpHealthCheckResponseSchema = z
  .object({ data: HelpHealthCheckSchema })
  .openapi('GetHelpHealthCheckResponse');

export type HelpHealthStatus = z.infer<typeof HelpHealthStatusSchema>;
export type HelpHealthItem = z.infer<typeof HelpHealthItemSchema>;
export type HelpHostReportState = z.infer<typeof HelpHostReportStateSchema>;
export type HelpHostReport = z.infer<typeof HelpHostReportSchema>;
export type HelpHealthCheck = z.infer<typeof HelpHealthCheckSchema>;

/**
 * The file the installer writes after `aman doctor`, install, upgrade and refresh. Its shape is
 * fixed by the installer; an unknown `schema_version` is refused rather than guessed at.
 */
export const HostReportCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
  next_step: z.string().nullable(),
});

export const HostReportFileSchema = z.object({
  schema_version: z.literal(1),
  command: z.enum(['doctor', 'install', 'upgrade', 'refresh']),
  checked_at: z.string(),
  overall: z.enum(['pass', 'warn', 'fail']),
  checks: z.array(HostReportCheckSchema),
});

export type HostReportCheck = z.infer<typeof HostReportCheckSchema>;
export type HostReportFile = z.infer<typeof HostReportFileSchema>;
