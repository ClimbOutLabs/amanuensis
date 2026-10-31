/**
 * DB-backed skill route definitions.
 * Admin routes mount at /api/v1/settings/skills; the chat list mounts at
 * /api/v1/skills.
 * Discovery catalog lives at GET /api/v1/catalogs/skills.
 */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateSkillRequestSchema,
  DeleteSkillNetworkApprovalResponseSchema,
  DeleteSkillResponseSchema,
  GetSkillNetworkApprovalResponseSchema,
  GetSkillResponseSchema,
  ListAvailableSkillsResponseSchema,
  ListSkillVersionsRequestQuerySchema,
  ListSkillVersionsResponseSchema,
  ListSkillsResponseSchema,
  SkillNameParamsSchema,
  UpdateSkillNetworkApprovalRequestSchema,
  UpdateSkillNetworkApprovalResponseSchema,
  UpdateSkillRequestSchema,
} from '../schemas/skill';
import { OpenApiTag } from './openapiTags';

/** Chat/composer read view — mounted at /api/v1/skills (not under settings). */
export const listAvailableSkillsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SKILLS],
  summary: 'List skills for chat',
  description: 'Configured skills as a slim name/description list for the composer.',
  'x-fern-sdk-group-name': ['skills'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListAvailableSkillsResponseSchema } },
      description: 'All configured skills (chat projection).',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});

/** Versions for one skill — mounted at /api/v1/skills/versions?name= (FQN or skill name). */
export const listSkillVersionsRoute = createRoute({
  method: 'get',
  path: '/versions',
  tags: [OpenApiTag.SKILLS],
  summary: 'List skill versions',
  description: 'Versions for one skill.',
  'x-fern-sdk-group-name': ['skills'],
  'x-fern-sdk-method-name': 'list_versions',
  request: {
    query: ListSkillVersionsRequestQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListSkillVersionsResponseSchema } },
      description: 'Skill versions.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
  },
});

export const listConfiguredSkillsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SKILLS],
  summary: 'List configured skills',
  description: 'All configured skills with nested manifests (settings / admin projection).',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListSkillsResponseSchema } },
      description: 'All configured skills.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the caller is authenticated but not an admin.',
    },
  },
});

export const createSkillRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.SKILLS],
  summary: 'Create a skill',
  description: 'Creates a skill keyed by `name`. Fails if `name` is already taken.',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateSkillRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetSkillResponseSchema } },
      description: 'The created skill.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'A skill with this name already exists.',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported because skills are managed by an external system.',
    },
  },
});

export const putSkillRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.SKILLS],
  summary: 'Create or replace a skill',
  description: 'Full upsert keyed by `name`: creates the skill or replaces its entire manifest.',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateSkillRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSkillResponseSchema } },
      description: 'The saved skill.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported because skills are managed by an external system.',
    },
  },
});

export const deleteSkillRoute = createRoute({
  method: 'delete',
  path: '/{name}',
  tags: [OpenApiTag.SKILLS],
  summary: 'Delete a configured skill',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: SkillNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSkillResponseSchema } },
      description: 'Skill deleted.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No skill with this name',
    },
  },
});

export const getSkillNetworkApprovalRoute = createRoute({
  method: 'get',
  path: '/{name}/network-approval',
  tags: [OpenApiTag.SKILLS],
  summary: 'Get a skill network approval',
  description: 'The sites the skill declares, the approved list in force, and whether a declared site can send.',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'get_network_approval',
  request: {
    params: SkillNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSkillNetworkApprovalResponseSchema } },
      description: 'The skill network approval state.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No skill with this name',
    },
  },
});

export const updateSkillNetworkApprovalRoute = createRoute({
  method: 'put',
  path: '/{name}/network-approval',
  tags: [OpenApiTag.SKILLS],
  summary: 'Approve a skill network site list',
  description:
    'Stores the approval for exactly the sites the skill declares. A list that differs from the declaration is refused.',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'create_or_update_network_approval',
  request: {
    params: SkillNameParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateSkillNetworkApprovalRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: UpdateSkillNetworkApprovalResponseSchema } },
      description: 'The stored approval state.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No skill with this name',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The list sent is not the list the skill declares.',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported because skills are managed by an external system.',
    },
  },
});

export const deleteSkillNetworkApprovalRoute = createRoute({
  method: 'delete',
  path: '/{name}/network-approval',
  tags: [OpenApiTag.SKILLS],
  summary: 'Remove a skill network approval',
  description: 'Clears the stored approval. The skill keeps no network access from the next run on.',
  'x-fern-sdk-group-name': ['settings', 'skills'],
  'x-fern-sdk-method-name': 'delete_network_approval',
  request: {
    params: SkillNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSkillNetworkApprovalResponseSchema } },
      description: 'Approval removed.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No skill with this name',
    },
    424: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unsupported because skills are managed by an external system.',
    },
  },
});
