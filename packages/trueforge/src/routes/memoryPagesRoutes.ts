/**
 * Memory pages route definitions (mounted at /api/v1/memory/pages).
 * Handlers are registered in apis/memoryPages.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PageKindSchema } from '../runtime/memory/memoryPages';
import { PAGE_COMMIT_ID_PATTERN } from '../runtime/memory/vaultGit';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  ConfirmMemoryPageLineRequestSchema,
  DeleteMemoryPageResponseSchema,
  GetMemoryPageResponseSchema,
  ListMemoryPageChangesResponseSchema,
  ListMemoryPagesResponseSchema,
  UndoMemoryPageChangeResponseSchema,
  UpdateMemoryPageRequestSchema,
} from '../schemas/memoryPages';
import { OpenApiTag } from './openapiTags';

export const MemoryPagesQuerySchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .max(128)
      .optional()
      .describe('Vault namespace: omit for the shared vault, `persona:<name>` for a persona vault.'),
  })
  .openapi('MemoryPagesQuery');

export const MemoryPageParamsSchema = z.object({
  kind: PageKindSchema,
  slug: z.string().min(1).max(200),
});

export const MemoryPageLineParamsSchema = z.object({
  kind: PageKindSchema,
  slug: z.string().min(1).max(200),
  fact_id: z.string().min(1).max(32),
});

export const MemoryPageChangeParamsSchema = z.object({
  change_id: z.string().regex(PAGE_COMMIT_ID_PATTERN),
});

export const MemoryPageDisagreementParamsSchema = z.object({
  kind: PageKindSchema,
  slug: z.string().min(1).max(200),
  disagreement_id: z.string().min(1).max(64),
});

const FAILURE = (description: string) => ({
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description,
});

const COMMON_ERRORS = {
  400: FAILURE('The request cannot be done as asked. The message says what to change.'),
  404: FAILURE('No such page, line or change.'),
  409: FAILURE('The page changed after it was opened, a later change must be undone first, or no history is kept.'),
  401: FAILURE('Authentication required.'),
  500: FAILURE('The page operation failed.'),
};

const FERN_GROUP = ['memory', 'pages'];

export const listMemoryPagesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'List memory pages',
  description: 'List the pages for people and matters, with the files that could not be read as pages.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'list',
  request: { query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListMemoryPagesResponseSchema } },
      description: 'The pages.',
    },
    ...COMMON_ERRORS,
  },
});

export const listMemoryPageChangesRoute = createRoute({
  method: 'get',
  path: '/changes',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'List recent page changes',
  description: 'List the last changes to pages, newest first, and whether each can be undone.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'list_changes',
  request: { query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListMemoryPageChangesResponseSchema } },
      description: 'The recent changes.',
    },
    ...COMMON_ERRORS,
  },
});

export const undoMemoryPageChangeRoute = createRoute({
  method: 'post',
  path: '/changes/{change_id}/undo',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Undo a page change',
  description:
    'Put the pages a change touched back as they were before it, as a new change. Refused while a later change left those pages different.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'undo_change',
  request: { params: MemoryPageChangeParamsSchema, query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: UndoMemoryPageChangeResponseSchema } },
      description: 'The change was undone.',
    },
    ...COMMON_ERRORS,
  },
});

export const getMemoryPageRoute = createRoute({
  method: 'get',
  path: '/{kind}/{slug}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get a memory page',
  description: 'Get one page: its sections in order, where each line came from, and its Markdown text.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'get',
  request: { params: MemoryPageParamsSchema, query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageResponseSchema } },
      description: 'The page.',
    },
    ...COMMON_ERRORS,
  },
});

export const updateMemoryPageRoute = createRoute({
  method: 'put',
  path: '/{kind}/{slug}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Save a page edit',
  description:
    'Replace a page with the person’s Markdown. New or changed lines become their own. Refused when the page changed since the version sent, or the text is not a page.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'update',
  request: {
    params: MemoryPageParamsSchema,
    query: MemoryPagesQuerySchema,
    body: { content: { 'application/json': { schema: UpdateMemoryPageRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageResponseSchema } },
      description: 'The saved page.',
    },
    ...COMMON_ERRORS,
  },
});

export const deleteMemoryPageRoute = createRoute({
  method: 'delete',
  path: '/{kind}/{slug}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Delete a memory page',
  description: 'Delete a page file. The history keeps it, so the delete can be undone.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'delete',
  request: { params: MemoryPageParamsSchema, query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteMemoryPageResponseSchema } },
      description: 'Page deleted.',
    },
    ...COMMON_ERRORS,
  },
});

export const confirmMemoryPageLineRoute = createRoute({
  method: 'post',
  path: '/{kind}/{slug}/lines/{fact_id}/confirm',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Confirm an unconfirmed line',
  description: 'Move a line from Unconfirmed to a section of the page as the person’s own words.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'confirm_line',
  request: {
    params: MemoryPageLineParamsSchema,
    query: MemoryPagesQuerySchema,
    body: { content: { 'application/json': { schema: ConfirmMemoryPageLineRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageResponseSchema } },
      description: 'The page after the line moved.',
    },
    ...COMMON_ERRORS,
  },
});

export const dismissMemoryPageLineRoute = createRoute({
  method: 'post',
  path: '/{kind}/{slug}/lines/{fact_id}/dismiss',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Dismiss an unconfirmed line',
  description: 'Remove a line from Unconfirmed.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'dismiss_line',
  request: { params: MemoryPageLineParamsSchema, query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageResponseSchema } },
      description: 'The page after the line was removed.',
    },
    ...COMMON_ERRORS,
  },
});

export const dismissMemoryPageDisagreementRoute = createRoute({
  method: 'post',
  path: '/{kind}/{slug}/disagreements/{disagreement_id}/dismiss',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Dismiss a pair of lines that disagree',
  description: 'Mark a pair as not a problem. The same two lines are not listed again. No line on the page changes.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'dismiss_disagreement',
  request: { params: MemoryPageDisagreementParamsSchema, query: MemoryPagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageResponseSchema } },
      description: 'The page without the dismissed pair.',
    },
    ...COMMON_ERRORS,
  },
});
