/** Server-only turn wire schemas (SSE resume / cancel / list). Core turn schemas live in agent-session. */
import { z } from '@hono/zod-openapi';
import { TokenPaginationSchema, TurnSchema } from '@truefoundry/trueforge-core/agent-session';
import { EVENTS_PAGE_LIMIT, PAGE_LIMIT } from './common';
import { SessionEventWithPassthroughSchema } from './events';
import { SessionIdParamsSchema } from './session';

export { CreateTurnRequestSchema, TurnSchema } from '@truefoundry/trueforge-core/agent-session';
export type { Turn } from '@truefoundry/trueforge-core/agent-session';

export const TurnIdParamsSchema = z
  .object({
    ...SessionIdParamsSchema.shape,
    turn_id: z.string().min(1).describe('Turn identifier.'),
  })
  .openapi('TurnIDParams');

export const SubscribeTurnQuerySchema = z
  .object({
    // Query strings need coerce; map null/'' to undefined first so Number(null)→0
    // cannot silently become a resume cursor (and so OpenAPI does not advertise null).
    after_sequence_number: z.preprocess(
      val => (val === null || val === '' ? undefined : val),
      z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Exclusive resume cursor: replay only events with a sequence number greater than this value. Omit to start from the beginning of the live buffer.',
        ),
    ),
  })
  .openapi('SubscribeTurnQuery');

/** Intentionally empty — cancel takes no body fields. */
export const CancelSessionRequestSchema = z
  .object({})
  .describe('Empty request body. Cancel identifies the session via the path only.')
  .openapi('CancelSessionRequest');
/** Intentionally empty — success is signaled by HTTP 200 with `{}`. */
export const CancelSessionResponseSchema = z
  .object({})
  .describe('Empty success body. HTTP 200 means the cancel request was accepted (or nothing was running).')
  .openapi('CancelSessionResponse');

export const ListTurnsRequestQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT)
      .optional()
      .default(PAGE_LIMIT)
      .describe(`Page size. Defaults to ${String(PAGE_LIMIT)}, max ${String(PAGE_LIMIT)}.`),
    page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
  })
  .openapi('ListTurnsRequestQuery');

export const GetTurnResponseSchema = z
  .object({
    data: TurnSchema,
  })
  .openapi('GetTurnResponse');

export const ListTurnsResponseSchema = z
  .object({
    data: z.array(TurnSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListTurnsResponse');

export const ListTurnEventsRequestQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(EVENTS_PAGE_LIMIT)
      .optional()
      .default(EVENTS_PAGE_LIMIT)
      .describe(`Page size. Defaults to ${String(EVENTS_PAGE_LIMIT)}, max ${String(EVENTS_PAGE_LIMIT)}.`),
    page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .default('asc')
      .describe('Sort events by insertion order. Defaults to "asc".')
      .openapi('ListTurnEventsOrder'),
  })
  .openapi('ListTurnEventsRequestQuery');

export const ListTurnEventsResponseSchema = z
  .object({
    // SessionEventSchema (agent-session, core) excludes passthrough events by design;
    // aman.memory.recall and aman.profile.learned are passthrough events this package registers
    // (see runtime/memory/memoryEvents.ts, runtime/profileLearning.ts), so the persisted stream
    // this route lists can include them.
    data: z.array(SessionEventWithPassthroughSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListTurnEventsResponse');

export const DownloadSandboxFileRequestQuerySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Absolute or sandbox-working-directory-relative file path, as listed in the assistant's `sandbox_artifacts` block.",
      ),
  })
  .openapi('DownloadSandboxFileRequestQuery');
