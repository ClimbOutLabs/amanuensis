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

export const HelpSetupStepSchema = z
  .object({
    id: z
      .enum(['model', 'about_you'])
      .describe('model: a default model is chosen. about_you: your name is saved in Personalization.'),
    done: z.boolean().describe('Whether this setup step is done.'),
  })
  .openapi('HelpSetupStep');

export const HelpConnectorStateSchema = z
  .object({
    name: z.string().describe('The connector name. Never a token or address.'),
    connected: z.boolean().describe('Whether the connector answered this check with its tools.'),
    last_error: z.string().nullable().describe('One plain sentence on why it did not answer this check, or null.'),
  })
  .openapi('HelpConnectorState');

export const HelpGoogleLoginStateSchema = z
  .enum(['answered', 'needs_reconnect', 'no_answer', 'not_set_up'])
  .describe('The built-in Google login: answered, needs connecting again, did not answer, or not set up.')
  .openapi('HelpGoogleLoginState');

export const HelpStateSchema = z
  .object({
    setup_steps: z.array(HelpSetupStepSchema).describe('The first-run setup steps and whether each is done.'),
    connectors: z.array(HelpConnectorStateSchema).describe('Each connector, whether it answered, and why not.'),
    google_login: HelpGoogleLoginStateSchema,
    sandbox_ready: z.boolean().describe('Whether the sandbox that reads files and runs code is ready.'),
    app_version: z.string().describe('The version of Aman this server runs.'),
    build_ref: z.string().nullable().describe('The build this server runs, or null when the build was not stamped.'),
  })
  .openapi('HelpState');

export const HelpHealthCheckSchema = z
  .object({
    checked_at: z.string().describe('When this check ran, in UTC ISO 8601.'),
    model_ready: z.boolean().describe('Whether the default model answered the test call.'),
    items: z
      .array(HelpHealthItemSchema)
      .describe('Every live check with the model first, then failed or warned lines from the last full check.'),
    host_report: HelpHostReportSchema,
    state: HelpStateSchema,
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
export type HelpConnectorState = z.infer<typeof HelpConnectorStateSchema>;
export type HelpState = z.infer<typeof HelpStateSchema>;

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
