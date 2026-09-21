/**
 * Wire shapes for the memory-provider connection check: the result returned by
 * POST /mcp-servers/{name}/memory-check and the failure classification the runtime's
 * Hindsight client stamps on every failed call.
 *
 * The check exercises the Hindsight REST API that host-enforced memory actually calls, which is
 * a different surface from the MCP endpoint a connector's `auth_status` reflects.
 */
import { z } from '@hono/zod-openapi';

export const MemoryProviderFailureCodeSchema = z
  .enum([
    'invalid_url',
    'auth_required',
    'header_resolution_failed',
    'timeout',
    'request_failed',
    'http_error',
    'invalid_response',
  ])
  .describe(
    'Why the memory provider could not be reached: `invalid_url` (not an `{apiBase}/mcp/{bank}` URL), ' +
      '`auth_required` (the connector still needs authorization), `header_resolution_failed` (a `${env:}` / ' +
      '`${file:}` header reference did not resolve), `timeout`, `request_failed` (the host could not reach it), ' +
      '`http_error` (it answered with a non-2xx status), or `invalid_response` (its answer was unreadable).',
  )
  .openapi('MemoryProviderFailureCode');

const MemoryProviderCheckOkSchema = z
  .object({
    status: z.literal('ok').describe('The provider answered a real recall request over its REST API.'),
  })
  .strict();

const MemoryProviderCheckFailedSchema = z
  .object({
    status: z.literal('failed').describe('The provider did not answer a real recall request.'),
    code: MemoryProviderFailureCodeSchema,
    reason: z.string().describe('Human-readable failure line, including the upstream detail when there is one.'),
    http_status: z.number().int().optional().describe('Status the provider answered with, when it answered at all.'),
    detail: z.string().optional().describe("The provider's own error message, when it sent one."),
  })
  .strict();

export const MemoryProviderCheckResultSchema = z
  .discriminatedUnion('status', [MemoryProviderCheckOkSchema, MemoryProviderCheckFailedSchema])
  .describe('Outcome of one live recall against the memory provider REST API.')
  .openapi('MemoryProviderCheckResult');

export const MemoryProviderCheckResponseSchema = z
  .object({ data: MemoryProviderCheckResultSchema })
  .openapi('MemoryProviderCheckResponse');

export type MemoryProviderFailureCode = z.infer<typeof MemoryProviderFailureCodeSchema>;
export type MemoryProviderCheckResult = z.infer<typeof MemoryProviderCheckResultSchema>;
