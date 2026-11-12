import { TokenPaginationSchema } from '@truefoundry/trueforge-core/agent-session';
import { z } from 'zod';

export const SentinelAuditRecordSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    tier: z.number().int().min(1).max(3),
    tool_name: z.string(),
    description: z.string(),
    outcome: z.enum(['logged', 'ran', 'approved', 'denied', 'auto_denied']),
    auto_deny_reason: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('SentinelAuditRecord');

export const ListSessionAuditLogRequestQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi('ListSessionAuditLogRequestQuery');

export const ListSessionAuditLogResponseSchema = z
  .object({
    entries: z.array(SentinelAuditRecordSchema),
  })
  .openapi('ListSessionAuditLogResponse');

/**
 * A time bound in the one form the store saves times in (UTC, with milliseconds). SQLite compares saved times as
 * text, so a bound with an offset or without milliseconds would cut the log at the wrong place.
 */
const AuditTimeBoundSchema = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());

export const ListUserAuditLogRequestQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    page_token: z.string().optional().describe('Token from the previous page; omit for the newest entries.'),
    outcome: SentinelAuditRecordSchema.shape.outcome.optional().describe('Only entries with this outcome.'),
    from: AuditTimeBoundSchema.optional().describe(
      'Only entries at or after this time. The caller sends the start of a day in its own timezone.',
    ),
    to: AuditTimeBoundSchema.optional().describe(
      'Only entries before this time. The caller sends the start of the day after its last shown day.',
    ),
  })
  .refine(query => query.from === undefined || query.to === undefined || query.from < query.to, {
    message: 'The start date must be before the end date. Pick an earlier start date.',
    path: ['from'],
  })
  .openapi('ListUserAuditLogRequestQuery');

export const UserAuditRecordSchema = z
  .object({
    ...SentinelAuditRecordSchema.shape,
    chat_exists: z.boolean().describe('False once the chat the entry came from has been deleted.'),
  })
  .openapi('UserAuditRecord');

export const ListUserAuditLogResponseSchema = z
  .object({
    data: z.array(UserAuditRecordSchema).describe('Entries from every chat, newest first.'),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListUserAuditLogResponse');
