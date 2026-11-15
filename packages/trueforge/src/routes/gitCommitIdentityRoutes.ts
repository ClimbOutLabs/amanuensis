/** Commit name routes (mounted at /api/v1/settings/git-commit-identity). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetGitCommitIdentityResponseSchema, UpdateGitCommitIdentityRequestSchema } from '../schemas/gitCommitIdentity';
import { OpenApiTag } from './openapiTags';

const AUTH_RESPONSES = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Authentication required.',
  },
  403: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Admin access required.',
  },
};

export const getGitCommitIdentityRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Get the name on Git commits',
  description:
    'The name and email written on Git commits made in the sandbox. A `null` part means the person chose none and the default shown beside it is used.',
  'x-fern-sdk-group-name': ['settings', 'gitCommitIdentity'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetGitCommitIdentityResponseSchema } },
      description: 'The chosen name and email, with the defaults.',
    },
    ...AUTH_RESPONSES,
  },
});

export const putGitCommitIdentityRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Set or clear the name on Git commits',
  description:
    'Sets the name and email written on Git commits made in the sandbox. `null` for a part goes back to its default. New commits use the change from the next message.',
  'x-fern-sdk-group-name': ['settings', 'gitCommitIdentity'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateGitCommitIdentityRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGitCommitIdentityResponseSchema } },
      description: 'The chosen name and email after the update, with the defaults.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    ...AUTH_RESPONSES,
  },
});
