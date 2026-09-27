/**
 * Memory vault route definitions (mounted at /api/v1/memory/vault).
 * Handlers are registered in apis/memoryVault.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  DeleteMemoryVaultEntryResponseSchema,
  ExportMemoryVaultResponseSchema,
  GetMemoryVaultEntryResponseSchema,
  GetMemoryVaultSharingResponseSchema,
  ImportMemoryVaultRequestSchema,
  ImportMemoryVaultResponseSchema,
  ListMemoryVaultEntriesResponseSchema,
  UpdateMemoryVaultEntryRequestSchema,
  UpdateMemoryVaultSharingRequestSchema,
} from '../schemas/memoryVault';
import { OpenApiTag } from './openapiTags';

export const MemoryVaultEntryIdParamsSchema = z.object({
  entry_id: z
    .string()
    .min(1)
    .max(256)
    .describe('URL-encoded vault entry id (`md:{namespace}:{file}#{index}`).'),
});

export const ListMemoryVaultEntriesQuerySchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .max(128)
      .optional()
      .describe('Vault namespace: omit for the shared vault, `persona:<name>` for a persona vault, else a topic name.'),
  })
  .openapi('ListMemoryVaultEntriesQuery');

export const ExportMemoryVaultQuerySchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .max(128)
      .optional()
      .describe('Vault namespace to export: omit for the shared vault.'),
  })
  .openapi('ExportMemoryVaultQuery');

const UNAUTHENTICATED = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Authentication required.',
  },
};

const SERVER_ERROR = {
  500: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The vault operation failed.',
  },
};

export const listMemoryVaultEntriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'List memory vault entries',
  description: 'List the effective entries of one vault namespace. Vault edits and deletes are applied.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'list',
  request: {
    query: ListMemoryVaultEntriesQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListMemoryVaultEntriesResponseSchema } },
      description: 'Vault entries for the namespace.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid namespace.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const exportMemoryVaultRoute = createRoute({
  method: 'get',
  path: '/export',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Export a memory vault',
  description: 'Export one vault namespace as JSON: the namespace, the export time, and every effective entry.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'export_entries',
  request: {
    query: ExportMemoryVaultQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ExportMemoryVaultResponseSchema } },
      description: 'The vault export.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid namespace.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const importMemoryVaultRoute = createRoute({
  method: 'post',
  path: '/import',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Import into a memory vault',
  description: 'Append imported entries to one vault namespace as new daily-log entries.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'import_entries',
  request: {
    body: {
      content: { 'application/json': { schema: ImportMemoryVaultRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: ImportMemoryVaultResponseSchema } },
      description: 'Entries imported.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid import payload.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const getMemoryVaultSharingRoute = createRoute({
  method: 'get',
  path: '/sharing',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get memory vault sharing',
  description: 'Get the per-persona sharing config: which vault namespaces each persona may read.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'get_sharing',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryVaultSharingResponseSchema } },
      description: 'The stored sharing config.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const putMemoryVaultSharingRoute = createRoute({
  method: 'put',
  path: '/sharing',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Replace memory vault sharing',
  description: 'Replace the whole per-persona sharing config. An omitted persona loses its shares.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'update_sharing',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryVaultSharingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryVaultSharingResponseSchema } },
      description: 'The stored sharing config after the update.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid sharing config.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const updateMemoryVaultEntryRoute = createRoute({
  method: 'put',
  path: '/{entry_id}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Update a memory vault entry',
  description:
    'Replace one entry\u2019s text. The daily log is append-only, so the old entry stays and a supersede marker records the new text.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: MemoryVaultEntryIdParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateMemoryVaultEntryRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryVaultEntryResponseSchema } },
      description: 'The entry with its replacement text.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid entry id or text.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No vault entry with that id.',
    },
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});

export const deleteMemoryVaultEntryRoute = createRoute({
  method: 'delete',
  path: '/{entry_id}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Delete a memory vault entry',
  description:
    'Delete one entry. The daily log is append-only, so the old entry stays and a delete marker hides it from listings and recall.',
  'x-fern-sdk-group-name': ['memory', 'vault'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: MemoryVaultEntryIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteMemoryVaultEntryResponseSchema } },
      description: 'Entry deleted.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid entry id.',
    },
    ...UNAUTHENTICATED,
    ...SERVER_ERROR,
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No vault entry with that id.',
    },
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The server does not run the markdown memory backend.',
    },
  },
});
