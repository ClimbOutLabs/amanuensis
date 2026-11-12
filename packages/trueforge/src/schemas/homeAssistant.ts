/**
 * Wire shapes for the Home Assistant connection check: the result returned by
 * POST /mcp-servers/{name}/home-assistant-check. The check runs the MCP handshake against the
 * saved connector, lists its tools, and reads the live-context tool once, so the answer can say
 * how much of the home Aman can see, or the one thing to fix.
 */
import { z } from '@hono/zod-openapi';

export const HomeAssistantCheckFailureCodeSchema = z
  .enum(['unreachable', 'token_refused', 'integration_missing', 'certificate', 'error'])
  .describe(
    'Why Home Assistant could not be connected: `unreachable` (nothing answered at the address), ' +
      '`token_refused` (Home Assistant refused the token), `integration_missing` (the Model Context ' +
      'Protocol Server integration is not installed), `certificate` (the address uses a certificate ' +
      'that cannot be checked), or `error` (anything else).',
  )
  .openapi('HomeAssistantCheckFailureCode');

const HomeAssistantCheckOkSchema = z
  .object({
    status: z.literal('ok').describe('Home Assistant answered the handshake and the live-context read.'),
    tool_count: z.number().int().describe('How many tools the server offers.'),
    entity_count: z
      .number()
      .int()
      .nullable()
      .describe('How many exposed entities the live-context tool named, or null when it is not offered.'),
  })
  .strict();

const HomeAssistantCheckFailedSchema = z
  .object({
    status: z.literal('failed').describe('Home Assistant could not be connected.'),
    code: HomeAssistantCheckFailureCodeSchema,
    reason: z.string().describe('One plain line saying what to fix.'),
  })
  .strict();

export const HomeAssistantCheckResultSchema = z
  .discriminatedUnion('status', [HomeAssistantCheckOkSchema, HomeAssistantCheckFailedSchema])
  .describe('Outcome of one Home Assistant connection check.')
  .openapi('HomeAssistantCheckResult');

export const HomeAssistantCheckResponseSchema = z
  .object({ data: HomeAssistantCheckResultSchema })
  .openapi('HomeAssistantCheckResponse');

export type HomeAssistantCheckFailureCode = z.infer<typeof HomeAssistantCheckFailureCodeSchema>;
export type HomeAssistantCheckResult = z.infer<typeof HomeAssistantCheckResultSchema>;
