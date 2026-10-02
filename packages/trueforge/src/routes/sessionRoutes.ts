/**
 * Session route definitions.
 * Public DB-backed routes mount at /api/v1/sessions; internal operations mount
 * at /api/internal/sessions.
 * Handlers are registered in apis/sessions.ts.
 */
import { createRoute } from '@hono/zod-openapi';
import { CreateSessionBugReportRequestSchema, CreateSessionBugReportResponseSchema } from '../schemas/bugReport';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { ListSessionEventsRequestQuerySchema, ListSessionEventsResponseSchema } from '../schemas/events';
import {
  ImplementationPlanGrantParamsSchema,
  ListImplementationPlanGrantsResponseSchema,
  RevokeImplementationPlanGrantResponseSchema,
} from '../schemas/implementationPlanGrant';
import {
  CreateSessionRequestSchema,
  GetOrCreateSessionByExternalIdRequestSchema,
  GetSessionResponseSchema,
  ListSessionsRequestQuerySchema,
  ListSessionsResponseSchema,
  SessionIdParamsSchema,
  UpdateSessionRequestSchema,
} from '../schemas/session';
import {
  ListSessionAuditLogRequestQuerySchema,
  ListSessionAuditLogResponseSchema,
} from '../schemas/sentinelAudit';
import { CancelSessionRequestSchema, CancelSessionResponseSchema } from '../schemas/turn';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

export const createSessionRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Create a session',
  description:
    'Create a session with `agent` as either `{ name }` (named registry binding) or `{ spec: AgentSpec }` (inline). Named sessions snapshot the agent name at create and resolve the live agent on each turn. Responses use `{ type: "reference", name, id }` or `{ type: "inline", spec }`.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateSessionRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetSessionResponseSchema } },
      description: 'Session created.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Named agent not found.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The agent spec is valid but references a resource this server does not provide (e.g. model, MCP server, skill, or sandbox).',
    },
  },
});

/**
 * Idempotent get-or-create by tenant-scoped `external_id`. Internal callers
 * (schedule dispatch) use this so a retried run reuses the same session.
 */
export const getOrCreateSessionByExternalIdRoute = createRoute({
  method: 'post',
  path: '/get-or-create-by-external-id',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Get or create a session by external id',
  description: 'Idempotent get-or-create: returns the existing session for this `external_id`, or creates one',
  'x-fern-sdk-group-name': ['internal', 'sessions'],
  'x-fern-sdk-method-name': 'get_or_create_by_external_id',
  request: {
    body: {
      content: { 'application/json': { schema: GetOrCreateSessionByExternalIdRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionResponseSchema } },
      description: 'Session already existed for this external id.',
    },
    201: {
      content: { 'application/json': { schema: GetSessionResponseSchema } },
      description: 'Session created.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Named agent not found.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The agent spec is valid but references a resource this server does not provide (e.g. model, MCP server, skill, or sandbox).',
    },
  },
});

export const getSessionRoute = createRoute({
  method: 'get',
  path: '/{session_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Get a session',
  description: 'Fetch a session by ID. Only the session creator may fetch it.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'get',
  request: {
    params: SessionIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionResponseSchema } },
      description: 'Session data.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});

export const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/{session_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Delete a session',
  description:
    'Delete a session and all related turns, events, and internal state. Only the session creator may delete it. Idempotent if already gone.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: SessionIdParamsSchema,
  },
  responses: {
    204: {
      description: 'Session and all related data deleted.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
  },
});

export const updateSessionRoute = createRoute({
  method: 'patch',
  path: '/{session_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Update a session',
  description:
    'Update a session by replacing `agent` with `{ spec: AgentSpec }`. Named (reference) sessions reject agent updates. An empty body is a valid no-op that refreshes `updated_at`. Only the session creator may update it.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: SessionIdParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateSessionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionResponseSchema } },
      description: 'Session updated.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'Named session rejected an agent update, or the agent spec references a resource this server does not provide (e.g. model, MCP server, skill, or sandbox).',
    },
  },
});

export const listSessionsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'List sessions',
  description: 'List the sessions (newest first by default).',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: {
    query: ListSessionsRequestQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListSessionsResponseSchema } },
      description: 'Paginated sessions.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
  },
});

export const cancelSessionRoute = createRoute({
  method: 'post',
  path: '/{session_id}/cancel',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Cancel a running turn in a session',
  description: 'Cancel the running last turn for a session. Only the session creator may cancel.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'cancel',
  request: {
    params: SessionIdParamsSchema,
    body: {
      content: { 'application/json': { schema: CancelSessionRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CancelSessionResponseSchema } },
      description: 'Turn cancelled.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
    412: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'Requested action cannot be performed on the session because it is no longer usable, or the executor owning the running turn is unreachable.',
    },
  },
});

export const listSessionEventsRoute = createRoute({
  method: 'get',
  path: '/{session_id}/events',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'List session events',
  description:
    'List session events as `{ turn_id, event }` across the active turn branch (newest first), including persisted events from a running tip. Each turn contributes turn.created, content events (model.message, tool.call, …), and turn.done when terminal; streaming deltas are not included. Use `page_token` to paginate backward toward older events while retaining the original branch anchor. Only the session creator may list events.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'list_events',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: {
    params: SessionIdParamsSchema,
    query: ListSessionEventsRequestQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListSessionEventsResponseSchema } },
      description: 'Paginated session events.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid page token.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});

export const createSessionBugReportRoute = createRoute({
  method: 'post',
  path: '/{session_id}/bug-report',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Generate a redacted bug-report bundle for a session',
  description:
    'Assembles a redacted diagnostic bundle for this session: build identity, a structural per-turn event trace ' +
    '(event types, tool names/effects/outcomes, durations, counts), recent errors, non-secret config flags, and ' +
    'the optional description supplied in the request body, included verbatim. Message text, memory-recall ' +
    'content, learned-profile text, tool-call arguments/results, and any credential or token value are never ' +
    'included — see the response `redaction` field — unless the request sets `include_chat`, which adds the ' +
    "user and assistant message text under `chat` at the reporter's request. Only the session creator " +
    '(`created_by`) may generate it.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'create_bug_report',
  request: {
    params: SessionIdParamsSchema,
    body: {
      content: { 'application/json': { schema: CreateSessionBugReportRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateSessionBugReportResponseSchema } },
      description: 'Redacted bug-report bundle.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});

export const listImplementationPlanGrantsRoute = createRoute({
  method: 'get',
  path: '/{session_id}/implementation-plan-grants',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'List active implementation-plan grants',
  description:
    'List active durable implementation-plan grants for this session and its current repository binding, including between turns. Only the session creator may list them.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'list_implementation_plan_grants',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListImplementationPlanGrantsResponseSchema } },
      description: 'Active implementation-plan grants.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});

export const revokeImplementationPlanGrantRoute = createRoute({
  method: 'delete',
  path: '/{session_id}/implementation-plan-grants/{grant_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Revoke an implementation-plan grant',
  description:
    'Durably revoke one implementation-plan grant for the session, including between turns. A conflict response means an already-admitted dispatch remains pending. Only the session creator may revoke it.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'revoke_implementation_plan_grant',
  request: { params: ImplementationPlanGrantParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: RevokeImplementationPlanGrantResponseSchema } },
      description: 'Grant revoked or already absent.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An admitted dispatch has not reached a terminal outcome.',
    },
  },
});

export const getSessionAuditLogRoute = createRoute({
  method: 'get',
  path: '/{session_id}/audit-log',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'List Sentinel audit log for a session',
  description:
    'List the Sentinel permission audit log for a session (newest first): tiered tool-call decisions with outcomes. Only the session creator may list it.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'get_audit_log',
  request: {
    params: SessionIdParamsSchema,
    query: ListSessionAuditLogRequestQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListSessionAuditLogResponseSchema } },
      description: 'Audit log entries.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});
