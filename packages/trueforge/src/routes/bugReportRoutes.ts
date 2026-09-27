/**
 * App-level bug-report route definitions.
 * Mounted at /api/v1/bug-reports; handlers are registered in apis/bugReportApp.ts.
 *
 * Plural kebab per the OpenAPI naming convention (`packages/trueforge/AGENTS.md`): bug reports
 * are not a persisted resource, so POST generates a freshly redacted bundle on demand and
 * GET /handoff is a collection-level action returning the configured issue-tracker target.
 */
import { createRoute } from '@hono/zod-openapi';

import {
  CreateAppBugReportRequestSchema,
  CreateAppBugReportResponseSchema,
  GetBugReportHandoffResponseSchema,
} from '../schemas/bugReport';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const createAppBugReportRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Generate a redacted app-level bug-report bundle',
  description:
    'Assembles a redacted diagnostic bundle without a session: build identity, non-secret config flags, ' +
    'and the optional description supplied in the request body, included verbatim. No session, trace, or ' +
    'chat data is collected, so there is nothing session-bound to redact — see the response `redaction` ' +
    'field. Usable wherever a session-based report is not available (e.g. outside a chat).',
  'x-fern-sdk-group-name': ['bug_reports'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateAppBugReportRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateAppBugReportResponseSchema } },
      description: 'Redacted app-level bug-report bundle.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
  },
});

export const getBugReportHandoffRoute = createRoute({
  method: 'get',
  path: '/handoff',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Get the bug-report issue-tracker handoff target',
  description:
    'Returns the host-configured issue-tracker URL bug reports hand off to (the bug_report.yml ' +
    'template), or null when the host disabled the handoff via BUG_REPORT_HANDOFF_URL.',
  'x-fern-sdk-group-name': ['bug_reports'],
  'x-fern-sdk-method-name': 'get_handoff',
  responses: {
    200: {
      content: { 'application/json': { schema: GetBugReportHandoffResponseSchema } },
      description: 'The handoff target, or null when unconfigured.',
    },
  },
});
