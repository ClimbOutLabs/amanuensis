/**
 * Goal route definitions (mounted at /api/v1/goals).
 * Handlers are registered in apis/goals.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { AGENTS_PAGE_DEFAULT, AGENTS_PAGE_LIMIT } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  ActivateGoalRequestSchema,
  CreateGoalRequestSchema,
  GetActivationPreviewResponseSchema,
  GetGoalResponseSchema,
  GoalCheckResponseSchema,
  GoalIdParamsSchema,
  GoalLifecycleSchema,
  GoalRevisionRequestSchema,
  GoalSetupChangedResponseSchema,
  GoalStepParamsSchema,
  ListGoalApprovalsResponseSchema,
  ListGoalEventsResponseSchema,
  ListGoalEvidenceResponseSchema,
  ListGoalsResponseSchema,
  UpdateGoalRequestSchema,
} from '../schemas/goal';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

function pageQuery() {
  return z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGENTS_PAGE_LIMIT)
      .optional()
      .default(AGENTS_PAGE_DEFAULT)
      .describe(`Page size. Defaults to ${String(AGENTS_PAGE_DEFAULT)}, max ${String(AGENTS_PAGE_LIMIT)}.`),
    page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
  });
}

export const ListGoalsQuerySchema = pageQuery()
  .extend({
    lifecycle: GoalLifecycleSchema.optional().describe('Only goals in this state.'),
  })
  .openapi('ListGoalsQuery');

export const ListGoalEvidenceQuerySchema = pageQuery().openapi('ListGoalEvidenceQuery');
export const ListGoalEventsQuerySchema = pageQuery().openapi('ListGoalEventsQuery');
export const ListGoalApprovalsQuerySchema = pageQuery().openapi('ListGoalApprovalsQuery');

const notFound = {
  404: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Goal not found.',
  },
};

const revisionConflict = {
  409: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The goal changed since it was read. Read it again, then retry.',
  },
};

export const listGoalsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.GOALS],
  summary: 'List goals',
  description: "List the caller's goals, newest first. Optional `lifecycle` keeps only goals in that state.",
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { query: ListGoalsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGoalsResponseSchema } },
      description: 'Paginated matching goals.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
  },
});

export const createGoalRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.GOALS],
  summary: 'Create a goal draft',
  description:
    'Creates a goal in draft. Nothing is checked or watched until the owner reviews the activation card and activates it.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateGoalRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The created draft, with its plan.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
  },
});

export const getGoalRoute = createRoute({
  method: 'get',
  path: '/{goal_id}',
  tags: [OpenApiTag.GOALS],
  summary: 'Get a goal',
  description: 'Fetch one goal with its plan and the step work turns to next.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'get',
  request: { params: GoalIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The goal and its plan.',
    },
    ...notFound,
  },
});

export const updateGoalRoute = createRoute({
  method: 'put',
  path: '/{goal_id}',
  tags: [OpenApiTag.GOALS],
  summary: 'Update a goal',
  description:
    'Edit a goal, checked against `expected_revision`. Once a goal is active, changes to its outcome, criteria, or sources need a new activation card instead.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: GoalIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateGoalRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The saved goal.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The edit is not allowed in the goal\u2019s current state.',
    },
    ...notFound,
    ...revisionConflict,
  },
});

export const getActivationPreviewRoute = createRoute({
  method: 'get',
  path: '/{goal_id}/activation-preview',
  tags: [OpenApiTag.GOALS],
  summary: 'Preview an activation',
  description:
    'What the activation card shows: the goal, its plan, and the agent setup resolved right now, with the digest activation binds to.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'get_activation_preview',
  request: { params: GoalIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetActivationPreviewResponseSchema } },
      description: 'The card contents.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal has no agent to pin, or its setup cannot be resolved.',
    },
    ...notFound,
  },
});

export const activateGoalRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/activate',
  tags: [OpenApiTag.GOALS],
  summary: 'Activate a goal',
  description:
    'Activates the goal against the setup digest the card showed. When the setup changed since the card, activation refuses and returns the updated card.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'activate',
  request: {
    params: GoalIdParamsSchema,
    body: { content: { 'application/json': { schema: ActivateGoalRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The activated goal.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal cannot be activated in its current state.',
    },
    ...notFound,
    409: {
      content: { 'application/json': { schema: GoalSetupChangedResponseSchema } },
      description: 'The agent setup changed since the card was shown. The response carries the updated card.',
    },
  },
});

export const pauseGoalRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/pause',
  tags: [OpenApiTag.GOALS],
  summary: 'Pause a goal',
  description: 'Pauses an active goal. New checks and dispatch stop, and its waiting approvals are invalidated.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'pause',
  request: {
    params: GoalIdParamsSchema,
    body: { content: { 'application/json': { schema: GoalRevisionRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The paused goal.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal is not active.',
    },
    ...notFound,
    ...revisionConflict,
  },
});

export const resumeGoalRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/resume',
  tags: [OpenApiTag.GOALS],
  summary: 'Resume a goal',
  description: 'Resumes a paused goal, so checks run again from the next scheduled time.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'resume',
  request: {
    params: GoalIdParamsSchema,
    body: { content: { 'application/json': { schema: GoalRevisionRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The resumed goal.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal is not paused.',
    },
    ...notFound,
    ...revisionConflict,
  },
});

export const endGoalRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/end',
  tags: [OpenApiTag.GOALS],
  summary: 'End a goal',
  description: 'Ends a goal. Its history is kept for reference, and its waiting approvals are invalidated.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'end',
  request: {
    params: GoalIdParamsSchema,
    body: { content: { 'application/json': { schema: GoalRevisionRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The ended goal.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal is already finished.',
    },
    ...notFound,
    ...revisionConflict,
  },
});

export const checkGoalRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/check',
  tags: [OpenApiTag.GOALS],
  summary: 'Check a goal now',
  description:
    'Runs one check now: reads the goal\u2019s selected sources, records new evidence against the plan, and reports the next step.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'check_now',
  request: { params: GoalIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GoalCheckResponseSchema } },
      description: 'What the check recorded.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal is a draft, paused, or finished, so it cannot be checked.',
    },
    ...notFound,
    409: {
      content: { 'application/json': { schema: GoalSetupChangedResponseSchema } },
      description: 'The agent setup changed since activation. The response carries the updated card to confirm.',
    },
  },
});

export const confirmGoalStepRoute = createRoute({
  method: 'post',
  path: '/{goal_id}/steps/{step_id}/confirm',
  tags: [OpenApiTag.GOALS],
  summary: 'Confirm a goal step',
  description:
    'Records the owner confirming a step as done, and steps waiting on it become ready. The goal itself stays open. Finishing it is a separate decision.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'confirm_step',
  request: { params: GoalStepParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoalResponseSchema } },
      description: 'The goal with the confirmed step.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The goal is a draft or finished, or the step is already confirmed or verified.',
    },
    ...notFound,
    ...revisionConflict,
  },
});

export const listGoalEvidenceRoute = createRoute({
  method: 'get',
  path: '/{goal_id}/evidence',
  tags: [OpenApiTag.GOALS],
  summary: 'List goal evidence',
  description: 'Page through the evidence recorded for a goal, newest first.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'list_evidence',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { params: GoalIdParamsSchema, query: ListGoalEvidenceQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGoalEvidenceResponseSchema } },
      description: 'Paginated evidence.',
    },
    ...notFound,
  },
});

export const listGoalEventsRoute = createRoute({
  method: 'get',
  path: '/{goal_id}/events',
  tags: [OpenApiTag.GOALS],
  summary: 'List goal events',
  description: 'Page through what changed on a goal, in the order it happened.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'list_events',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { params: GoalIdParamsSchema, query: ListGoalEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGoalEventsResponseSchema } },
      description: 'Paginated events.',
    },
    ...notFound,
  },
});

export const listGoalApprovalsRoute = createRoute({
  method: 'get',
  path: '/{goal_id}/approvals',
  tags: [OpenApiTag.GOALS],
  summary: 'List waiting goal approvals',
  description: 'The decisions still waiting for the owner on this goal, oldest first.',
  'x-fern-sdk-group-name': ['goals'],
  'x-fern-sdk-method-name': 'list_approvals',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { params: GoalIdParamsSchema, query: ListGoalApprovalsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGoalApprovalsResponseSchema } },
      description: 'Paginated waiting approvals.',
    },
    ...notFound,
  },
});
