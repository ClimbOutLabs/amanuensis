import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { ListSandboxWorkspacesResponseSchema } from '../schemas/sandboxWorkspace';
import { OpenApiTag } from './openapiTags';

export const listSandboxWorkspacesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'List the chat workspaces on the sandbox slots',
  description:
    'Asks every sandbox slot which chat workspaces it holds and joins them to their chats, with the space each takes and the room left on each slot. Read-only: nothing is created, moved or removed.',
  'x-fern-sdk-group-name': ['settings', 'sandboxWorkspaces'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListSandboxWorkspacesResponseSchema } },
      description: 'The chat workspaces on every slot, with one summary per slot.',
    },
    500: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'A sandbox slot could not be asked, so no list was returned.',
    },
  },
});
