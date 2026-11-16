import { createRoute } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CompleteTerminalPairingRequestSchema,
  CompleteTerminalPairingResponseSchema,
  ConfirmTerminalPairingRequestSchema,
  ConfirmTerminalPairingResponseSchema,
  DeleteTerminalKeyResponseSchema,
  GetTerminalKeysResponseSchema,
  LookupTerminalPairingRequestSchema,
  LookupTerminalPairingResponseSchema,
  RevokeCurrentTerminalKeyResponseSchema,
  StartTerminalPairingRequestSchema,
  StartTerminalPairingResponseSchema,
  TerminalKeyParamsSchema,
} from '../schemas/terminalPairing';
import { OpenApiTag } from './openapiTags';

/** Pairing routes (mounted at /api/v1/terminal-pairings). Start and completion are public and rate limited. */

export const startTerminalPairingRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.AUTH],
  summary: 'Start pairing a terminal',
  description:
    'Begins a terminal pairing and returns a one-time code, the address the person opens to confirm it, and when the code expires. The code works once.',
  'x-fern-sdk-group-name': ['terminalPairings'],
  'x-fern-sdk-method-name': 'start',
  request: {
    body: {
      content: { 'application/json': { schema: StartTerminalPairingRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: StartTerminalPairingResponseSchema } },
      description: 'The pairing code and the address to confirm it at.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    429: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Too many pairing starts from this address.',
    },
  },
});

export const confirmTerminalPairingRoute = createRoute({
  method: 'post',
  path: '/confirm',
  tags: [OpenApiTag.AUTH],
  summary: 'Confirm a terminal pairing',
  description:
    'Approves a pairing code for the signed-in person and pairs the terminal that started it. The terminal key itself goes only to the waiting terminal.',
  'x-fern-sdk-group-name': ['terminalPairings'],
  'x-fern-sdk-method-name': 'confirm',
  request: {
    body: {
      content: { 'application/json': { schema: ConfirmTerminalPairingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ConfirmTerminalPairingResponseSchema } },
      description: 'The terminal that was paired.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The code is not right, has expired, or was already used.',
    },
    429: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Too many pairing attempts.',
    },
  },
});

export const lookupTerminalPairingRoute = createRoute({
  method: 'post',
  path: '/lookup',
  tags: [OpenApiTag.AUTH],
  summary: 'Look up the terminal waiting on a pairing code',
  description:
    'Names the terminal waiting on a pairing code, for the signed-in person, before they confirm it. A code that is not right, has expired, or was already used answers the same refusal, so the lookup cannot be used to test codes.',
  'x-fern-sdk-group-name': ['terminalPairings'],
  'x-fern-sdk-method-name': 'lookup',
  request: {
    body: {
      content: { 'application/json': { schema: LookupTerminalPairingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: LookupTerminalPairingResponseSchema } },
      description: 'The terminal waiting on the code.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The code is not right, has expired, or was already used.',
    },
    429: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Too many pairing attempts.',
    },
  },
});

export const completeTerminalPairingRoute = createRoute({
  method: 'post',
  path: '/complete',
  tags: [OpenApiTag.AUTH],
  summary: 'Claim the key of a confirmed pairing',
  description:
    'The waiting terminal polls with its pairing id and code. While nobody has confirmed it answers waiting. Once confirmed it hands the terminal key over, exactly once.',
  'x-fern-sdk-group-name': ['terminalPairings'],
  'x-fern-sdk-method-name': 'complete',
  request: {
    body: {
      content: { 'application/json': { schema: CompleteTerminalPairingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CompleteTerminalPairingResponseSchema } },
      description: 'Whether the pairing is still waiting, or the terminal key when it was claimed.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The pairing is unknown, expired, or already claimed.',
    },
  },
});

export const revokeCurrentTerminalKeyRoute = createRoute({
  method: 'post',
  path: '/revoke-current',
  tags: [OpenApiTag.AUTH],
  summary: 'Revoke the terminal key this request carries',
  description:
    'A paired terminal revokes its own key, as it does when the person signs out on the terminal. The key stops working on the next request.',
  'x-fern-sdk-group-name': ['terminalPairings'],
  'x-fern-sdk-method-name': 'revoke_current',
  responses: {
    200: {
      content: { 'application/json': { schema: RevokeCurrentTerminalKeyResponseSchema } },
      description: 'The key was revoked.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The request did not carry a terminal key.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
  },
});

/** Paired terminal routes for Settings (mounted at /api/v1/settings/terminal-keys). */

export const listTerminalKeysRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'List paired terminals',
  description: 'Every terminal the person paired, newest first, with when it was paired, last used, and revoked.',
  'x-fern-sdk-group-name': ['settings', 'terminalKeys'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: GetTerminalKeysResponseSchema } },
      description: 'The paired terminals.',
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

export const deleteTerminalKeyRoute = createRoute({
  method: 'delete',
  path: '/{terminal_key_id}',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Revoke a paired terminal',
  description: 'Revokes one paired terminal key. The key stops working on the next request the terminal makes.',
  'x-fern-sdk-group-name': ['settings', 'terminalKeys'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: TerminalKeyParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteTerminalKeyResponseSchema } },
      description: 'The key was revoked.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No paired terminal has that id.',
    },
  },
});
