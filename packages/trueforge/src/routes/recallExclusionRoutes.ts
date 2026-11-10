/** Recall exclusion route (mounted at /api/v1/sessions). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { CreateRecallExclusionRequestSchema, CreateRecallExclusionResponseSchema } from '../schemas/recallExclusions';
import { SessionIdParamsSchema } from '../schemas/session';
import { OpenApiTag } from './openapiTags';

export const createRecallExclusionRoute = createRoute({
  method: 'post',
  path: '/{session_id}/recall-exclusions',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: "Pull a fact out of one chat's memory recall",
  description:
    'Stops one recalled fact from being recalled again in this chat. The memory itself is not ' +
    'changed or deleted, and other chats still recall it.',
  'x-fern-sdk-group-name': ['sessions', 'recallExclusions'],
  'x-fern-sdk-method-name': 'create',
  request: {
    params: SessionIdParamsSchema,
    body: {
      content: { 'application/json': { schema: CreateRecallExclusionRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateRecallExclusionResponseSchema } },
      description: 'The exclusion as recorded.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or the chat is private and keeps nothing.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
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
