/**
 * Privacy product surface route definitions (mounted at /api/v1/privacy).
 * Handlers live in apis/privacy.ts.
 */
import { createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetDataFlowManifestResponseSchema,
  GetOfflineModeResponseSchema,
  UpdateOfflineModeRequestSchema,
} from '../schemas/privacy';
import { OpenApiTag } from './openapiTags';

export const getPrivacyExportRoute = createRoute({
  method: 'get',
  path: '/export',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Export all of the caller data as a zip archive',
  description:
    'One-click full export: chats, memory files, settings, personas, and schedules for the caller, as a zip download. Credential-shaped values in chats, personas, schedules, and settings are redacted; memory files ship verbatim.',
  'x-fern-sdk-group-name': ['privacy'],
  'x-fern-sdk-method-name': 'export_data',
  responses: {
    200: {
      content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } },
      description: 'The export zip archive.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});

export const getDataFlowManifestRoute = createRoute({
  method: 'get',
  path: '/data-flow',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the machine-readable data-flow manifest',
  description:
    'Every external connection the system can make: what data is sent, where, and why. Powers the Settings > Privacy data-flow viewer.',
  'x-fern-sdk-group-name': ['privacy'],
  'x-fern-sdk-method-name': 'get_data_flow',
  responses: {
    200: {
      content: { 'application/json': { schema: GetDataFlowManifestResponseSchema } },
      description: 'The data-flow manifest.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});

export const getOfflineModeRoute = createRoute({
  method: 'get',
  path: '/offline-mode',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the offline-mode state',
  description: 'Whether the server currently refuses all non-local network calls.',
  'x-fern-sdk-group-name': ['privacy'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetOfflineModeResponseSchema } },
      description: 'The offline-mode state.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});

export const putOfflineModeRoute = createRoute({
  method: 'put',
  path: '/offline-mode',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Turn offline mode on or off',
  description:
    'When on, the server process refuses every fetch call except to localhost and the local network. Applies immediately; persisted across restarts. Sandbox-internal traffic (such as git skill updates) is outside this boundary.',
  'x-fern-sdk-group-name': ['privacy'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateOfflineModeRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetOfflineModeResponseSchema } },
      description: 'The offline-mode state after the update.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});
