import { z } from '@hono/zod-openapi';
import { OUTBOUND_EVENT_KINDS } from '@truefoundry/trueforge-core/core';

/** Largest number of events one list call returns. */
export const OUTBOUND_EVENTS_MAX_LIMIT = 500;

export const OutboundEventSchema = z
  .object({
    id: z.string(),
    kind: z
      .enum(OUTBOUND_EVENT_KINDS)
      .describe('What was sent: a model request, an email, a web search, a map lookup or another connector call.'),
    host: z.string().describe('Host of the service that received the request.'),
    model: z.string().nullable().describe('Model name for model requests; null otherwise.'),
    tool_name: z.string().nullable().describe('Connector tool called; null for model requests and map lookups.'),
    request_bytes: z.number().int().nullable().describe('Size of the request body in bytes, when measured.'),
    recipient_count: z
      .number()
      .int()
      .nullable()
      .describe('Recipients named in an email; null when the call names none.'),
    subject: z.string().nullable().describe('Email subject, shortened; null for other kinds.'),
    conversation_id: z.string().nullable().describe('Chat the request belongs to, when it came from one.'),
    created_at: z.string().describe('When the request was sent, ISO-8601 UTC.'),
  })
  .openapi('OutboundEvent');

export const ListOutboundEventsRequestQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(OUTBOUND_EVENTS_MAX_LIMIT).optional().default(OUTBOUND_EVENTS_MAX_LIMIT),
  })
  .openapi('ListOutboundEventsRequestQuery');

export const ListOutboundEventsResponseSchema = z
  .object({
    data: z.array(OutboundEventSchema).describe('Requests from the last 24 hours, newest first.'),
    window_start: z.string().describe('Start of the 24-hour window, ISO-8601 UTC.'),
    truncated: z.boolean().describe('True when more requests exist in the window than `limit` returned.'),
  })
  .openapi('ListOutboundEventsResponse');

export const DATA_LOCATION_IDS = ['chats', 'memory', 'personas', 'files_from_runs', 'settings', 'backups'] as const;

export const DataLocationSchema = z
  .object({
    id: z.enum(DATA_LOCATION_IDS),
    name: z.string().describe('Plain name shown to the owner.'),
    where: z.string().describe('Where it lives on this computer, in plain words, with the real path.'),
    size_bytes: z.number().int().nullable().describe('Size on disk, or null when it is not measured.'),
    size_covers: z.string().nullable().describe('What the size includes when several kinds share one location.'),
  })
  .openapi('DataLocation');

export const ListDataLocationsResponseSchema = z
  .object({ data: z.array(DataLocationSchema) })
  .openapi('ListDataLocationsResponse');

export type OutboundEvent = z.infer<typeof OutboundEventSchema>;
export type ListOutboundEventsRequestQuery = z.infer<typeof ListOutboundEventsRequestQuerySchema>;
export type DataLocation = z.infer<typeof DataLocationSchema>;
