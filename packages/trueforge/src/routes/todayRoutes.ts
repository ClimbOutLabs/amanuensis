/** The right rail's Home view route (mounted at /api/v1/today). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetTodayRequestQuerySchema, GetTodayResponseSchema } from '../schemas/today';
import { OpenApiTag } from './openapiTags';

export const getTodayRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: "Get the day for the right rail's Home view",
  description:
    "The person's day read from stored state: calendar events, free time, due reminders, held actions " +
    'and how many schedules are on. Nothing here asks the assistant anything, and no model is called.',
  'x-fern-sdk-group-name': ['today'],
  'x-fern-sdk-method-name': 'get',
  request: {
    query: GetTodayRequestQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetTodayResponseSchema } },
      description: "The day, as the person's own records give it.",
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
  },
});
