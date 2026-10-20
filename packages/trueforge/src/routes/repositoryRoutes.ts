import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  BindSessionRepositoryRequestSchema,
  ConfirmVerifyCommandProposalRequestSchema,
  CreateRepositoryRequestSchema,
  DeleteSessionRepositoryBindingResponseSchema,
  DeleteSessionRepositoryRequestQuerySchema,
  DeleteVerifyCommandProposalResponseSchema,
  DeleteVerifyCommandResponseSchema,
  DeleteVerifyCommandsRequestQuerySchema,
  GetGithubRepositoryDetailsResponseSchema,
  GetRepositoryResponseSchema,
  GetSessionRepositoryBindingResponseSchema,
  GetVerifyCommandResponseSchema,
  GithubRepositoryQuerySchema,
  ListGithubRepositoriesResponseSchema,
  ListRepositoriesResponseSchema,
  ListVerifyCommandProposalsResponseSchema,
  ListVerifyCommandsResponseSchema,
  RepositoryParamsSchema,
  SetPackageDownloadsRequestSchema,
  StartRepositoryWorkRequestSchema,
  StartRepositoryWorkResponseSchema,
  UpsertVerifyCommandRequestSchema,
  VerifyCommandParamsSchema,
  VerifyCommandProposalParamsSchema,
} from '../schemas/repository';
import { SessionIdParamsSchema } from '../schemas/session';
import { OpenApiTag } from './openapiTags';

const protectedResponses = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};
const forbiddenResponse = {
  403: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Not the owner.' },
};
const notFoundResponse = {
  404: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'No such repository, session, command, or proposal for this user.',
  },
};
const conflictResponse = {
  409: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Repository name or revision conflict.',
  },
};
const invalidResponse = {
  400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid request.' },
};

export const listRepositoriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'List repositories',
  'x-fern-sdk-group-name': ['repositories'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: { content: { 'application/json': { schema: ListRepositoriesResponseSchema } }, description: 'Repositories.' },
    ...protectedResponses,
  },
});

export const createRepositoryRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Register a repository',
  description: 'Registers repository identity only. It does not clone, execute, or bind a chat.',
  'x-fern-sdk-group-name': ['repositories'],
  'x-fern-sdk-method-name': 'create',
  request: { body: { content: { 'application/json': { schema: CreateRepositoryRequestSchema } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: GetRepositoryResponseSchema } }, description: 'Repository.' },
    ...invalidResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const getRepositoryRoute = createRoute({
  method: 'get',
  path: '/{repository_id}',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Get a repository',
  'x-fern-sdk-group-name': ['repositories'],
  'x-fern-sdk-method-name': 'get',
  request: { params: RepositoryParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetRepositoryResponseSchema } }, description: 'Repository.' },
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const setPackageDownloadsRoute = createRoute({
  method: 'post',
  path: '/{repository_id}/package-downloads',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Allow or stop package downloads for a repository',
  description:
    "When allowed, the sandbox may download this repo's packages from the public package sites through download-only mirrors. Nothing can be published back.",
  'x-fern-sdk-group-name': ['repositories'],
  'x-fern-sdk-method-name': 'set_package_downloads',
  request: {
    params: RepositoryParamsSchema,
    body: { content: { 'application/json': { schema: SetPackageDownloadsRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: GetRepositoryResponseSchema } }, description: 'Repository.' },
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const listVerifyCommandsRoute = createRoute({
  method: 'get',
  path: '/{repository_id}/commands',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'List confirmed repository commands',
  description: 'Only these host-confirmed commands can be invoked through run_registered_command.',
  'x-fern-sdk-group-name': ['repository-commands'],
  'x-fern-sdk-method-name': 'list',
  request: { params: RepositoryParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListVerifyCommandsResponseSchema } },
      description: 'Confirmed commands and current repository revision.',
    },
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const upsertVerifyCommandRoute = createRoute({
  method: 'put',
  path: '/{repository_id}/commands/{command_id}',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Confirm or replace a repository command',
  'x-fern-sdk-group-name': ['repository-commands'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    params: VerifyCommandParamsSchema,
    body: { content: { 'application/json': { schema: UpsertVerifyCommandRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: GetVerifyCommandResponseSchema } }, description: 'Command.' },
    ...invalidResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const deleteVerifyCommandRoute = createRoute({
  method: 'delete',
  path: '/{repository_id}/commands/{command_id}',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Remove a confirmed repository command',
  'x-fern-sdk-group-name': ['repository-commands'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: VerifyCommandParamsSchema, query: DeleteVerifyCommandsRequestQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: DeleteVerifyCommandResponseSchema } }, description: 'Removed.' },
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const listVerifyCommandProposalsRoute = createRoute({
  method: 'get',
  path: '/{repository_id}/command-proposals',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'List unconfirmed repository command proposals',
  'x-fern-sdk-group-name': ['repository-command-proposals'],
  'x-fern-sdk-method-name': 'list',
  request: { params: RepositoryParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListVerifyCommandProposalsResponseSchema } },
      description: 'Proposals that cannot execute until explicitly confirmed.',
    },
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const confirmVerifyCommandProposalRoute = createRoute({
  method: 'post',
  path: '/{repository_id}/command-proposals/{proposal_id}/confirm',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Confirm a proposed repository command',
  'x-fern-sdk-group-name': ['repository-command-proposals'],
  'x-fern-sdk-method-name': 'confirm',
  request: {
    params: VerifyCommandProposalParamsSchema,
    body: { content: { 'application/json': { schema: ConfirmVerifyCommandProposalRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetVerifyCommandResponseSchema } },
      description: 'Confirmed command.',
    },
    ...invalidResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const deleteVerifyCommandProposalRoute = createRoute({
  method: 'delete',
  path: '/{repository_id}/command-proposals/{proposal_id}',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Dismiss a repository command proposal',
  'x-fern-sdk-group-name': ['repository-command-proposals'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: VerifyCommandProposalParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteVerifyCommandProposalResponseSchema } },
      description: 'Dismissed.',
    },
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const getSessionRepositoryRoute = createRoute({
  method: 'get',
  path: '/{session_id}/repository',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Get the repository bound to a chat',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'get',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionRepositoryBindingResponseSchema } },
      description: 'Current binding, including an unbound null state.',
    },
    ...forbiddenResponse,
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const bindSessionRepositoryRoute = createRoute({
  method: 'put',
  path: '/{session_id}/repository',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Bind a chat to a repository checkout',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    params: SessionIdParamsSchema,
    body: { content: { 'application/json': { schema: BindSessionRepositoryRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionRepositoryBindingResponseSchema } },
      description: 'Bound repository checkout.',
    },
    ...invalidResponse,
    ...forbiddenResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

const unprocessableResponse = {
  422: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The repo cannot be opened yet, with the reason and the next step.',
  },
};
const upstreamResponse = {
  502: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'GitHub could not be reached.',
  },
};

export const getGithubRepositoryDetailsRoute = createRoute({
  method: 'get',
  path: '/github/metadata',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Look up a public GitHub repo',
  description: 'Reads one public GitHub repo and its branches, for the repo picker. Private repos need the chat route.',
  'x-fern-sdk-group-name': ['repositories'],
  'x-fern-sdk-method-name': 'get_github_metadata',
  request: { query: GithubRepositoryQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGithubRepositoryDetailsResponseSchema } },
      description: 'Repo details and branches.',
    },
    ...invalidResponse,
    ...notFoundResponse,
    ...upstreamResponse,
    ...protectedResponses,
  },
});

export const listSessionGithubRepositoriesRoute = createRoute({
  method: 'get',
  path: '/{session_id}/repository/github-repositories',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'List the GitHub repos this chat can open',
  description: 'Uses the GitHub connector attached to this chat. Without one, the answer says to connect GitHub.',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'list_github_repositories',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGithubRepositoriesResponseSchema } },
      description: 'Repos the person can pick from.',
    },
    ...forbiddenResponse,
    ...notFoundResponse,
    ...unprocessableResponse,
    ...upstreamResponse,
    ...protectedResponses,
  },
});

export const getSessionGithubRepositoryRoute = createRoute({
  method: 'get',
  path: '/{session_id}/repository/github-repository',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Look up one GitHub repo for this chat',
  description: 'Reads one GitHub repo and its branches, using this chat GitHub connector when one is attached.',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'get_github_repository',
  request: { params: SessionIdParamsSchema, query: GithubRepositoryQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGithubRepositoryDetailsResponseSchema } },
      description: 'Repo details and branches.',
    },
    ...invalidResponse,
    ...forbiddenResponse,
    ...notFoundResponse,
    ...upstreamResponse,
    ...protectedResponses,
  },
});

export const startSessionRepositoryWorkRoute = createRoute({
  method: 'post',
  path: '/{session_id}/repository/start-work',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Register a GitHub repo and bind this chat to its checkout',
  description:
    'Checks the repo size and branch on GitHub, registers the repo, and binds the chat to the checkout path the clone will use.',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'start_work',
  request: {
    params: SessionIdParamsSchema,
    body: { content: { 'application/json': { schema: StartRepositoryWorkRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: StartRepositoryWorkResponseSchema } },
      description: 'The registered repo, the bound checkout path, and the chosen branch.',
    },
    ...invalidResponse,
    ...forbiddenResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...unprocessableResponse,
    ...upstreamResponse,
    ...protectedResponses,
  },
});

export const unbindSessionRepositoryRoute = createRoute({
  method: 'delete',
  path: '/{session_id}/repository',
  tags: [OpenApiTag.REPOSITORIES],
  summary: 'Unbind a chat from its repository checkout',
  'x-fern-sdk-group-name': ['session-repository'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: SessionIdParamsSchema, query: DeleteSessionRepositoryRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSessionRepositoryBindingResponseSchema } },
      description: 'Repository binding removed.',
    },
    ...forbiddenResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});
