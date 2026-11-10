import { createRoute } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CancelTelegramPairingResponseSchema,
  ConfirmTelegramPairingRequestSchema,
  ConfirmTelegramPairingResponseSchema,
  ConnectTelegramRequestSchema,
  ConnectTelegramResponseSchema,
  GetTelegramAccountResponseSchema,
  ProcessTelegramUpdateRequestSchema,
  RemoveTelegramResponseSchema,
  TelegramWebhookUpdateSchema,
} from '../schemas/telegram';
import { OpenApiTag } from './openapiTags';

const unauthorized = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

const refused = {
  403: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The caller is not an admin, or the request did not come from this app, so nothing was done.',
  },
};

export const getTelegramStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get the Telegram bot status',
  description:
    'Returns whether a bot is connected, its name, where pairing stands, and the name of the person waiting to pair while one waits. The bot token and the pairing code are never returned: the code is shown only in Telegram.',
  'x-fern-sdk-group-name': ['settings', 'telegram'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: GetTelegramAccountResponseSchema } },
      description: 'The Telegram status.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const connectTelegramRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Connect a Telegram bot',
  description:
    'Checks the bot token with Telegram first and saves the connection only when it passes. The token is stored with the connection and never returned.',
  'x-fern-sdk-group-name': ['settings', 'telegram'],
  'x-fern-sdk-method-name': 'connect',
  request: {
    body: { content: { 'application/json': { schema: ConnectTelegramRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: ConnectTelegramResponseSchema } },
      description: 'The bot is connected and waiting to be paired.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Telegram refused the token.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Telegram could not be reached.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const confirmTelegramPairingRoute = createRoute({
  method: 'post',
  path: '/confirm',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Confirm a Telegram pairing',
  description:
    'Pairs the person who sent /start to the bot, when the code they type matches the code the bot sent them in Telegram. Only that person can then talk to the bot.',
  'x-fern-sdk-group-name': ['settings', 'telegram'],
  'x-fern-sdk-method-name': 'confirm_pairing',
  request: {
    body: { content: { 'application/json': { schema: ConfirmTelegramPairingRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ConfirmTelegramPairingResponseSchema } },
      description: 'The pairing is confirmed.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No code is waiting, it has expired, or the code does not match.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const cancelTelegramPairingRoute = createRoute({
  method: 'post',
  path: '/cancel-pairing',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Cancel a waiting Telegram pairing',
  description:
    'Drops the pairing that is waiting, without pairing anyone, so a /start from someone else can be refused. The person can send /start again to start over.',
  'x-fern-sdk-group-name': ['settings', 'telegram'],
  'x-fern-sdk-method-name': 'cancel_pairing',
  responses: {
    200: {
      content: { 'application/json': { schema: CancelTelegramPairingResponseSchema } },
      description: 'No pairing is waiting now.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No bot is connected.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const removeTelegramRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Disconnect the Telegram bot',
  description: 'Removes the bot, its token and its pairing for good. Messages to the bot are no longer answered.',
  'x-fern-sdk-group-name': ['settings', 'telegram'],
  'x-fern-sdk-method-name': 'remove',
  responses: {
    200: {
      content: { 'application/json': { schema: RemoveTelegramResponseSchema } },
      description: 'The bot is disconnected.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const processTelegramUpdateRoute = createRoute({
  method: 'post',
  path: '/updates',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Process one Telegram update',
  description:
    'Handles one update the controller polled for a connection: a message becomes a turn, a button tap answers an approval. Called only with the service credential.',
  'x-fern-sdk-group-name': ['internal', 'telegram'],
  'x-fern-sdk-method-name': 'process_update',
  request: {
    body: { content: { 'application/json': { schema: ProcessTelegramUpdateRequestSchema } }, required: true },
  },
  responses: {
    204: { description: 'The update was handled, or there was nothing in it to handle.' },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid service credential.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The connection is not there.',
    },
  },
});

export const telegramWebhookRoute = createRoute({
  method: 'post',
  path: '/webhook',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Receive one Telegram webhook update',
  description:
    'The address Telegram posts updates to when a public https address is configured. The secret Telegram was given at setup must ride the call, or it is refused. An update in a shape this build cannot read is dropped with the same success answer, so Telegram does not keep retrying it.',
  'x-fern-sdk-group-name': ['telegram'],
  'x-fern-sdk-method-name': 'webhook',
  request: {
    body: { content: { 'application/json': { schema: TelegramWebhookUpdateSchema } }, required: true },
  },
  responses: {
    204: { description: 'The update was handled, dropped as unreadable, or there was nothing in it to handle.' },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The call did not carry the webhook secret.',
    },
  },
});
