import { createRoute } from '@hono/zod-openapi';
import {
  GetEmailAccountResponseSchema,
  RemoveEmailAccountResponseSchema,
  SaveEmailAccountRequestSchema,
  SaveEmailAccountResponseSchema,
} from '../schemas/emailAccount';
import { RequestErrorResponseSchema } from '../schemas/errors';
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
    description: 'The request did not come from Aman, so nothing was done.',
  },
};

export const getEmailAccountStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get the email account status',
  description:
    'Returns whether an email account is connected, its address and provider, and the provider table for the picker. The app password is never returned.',
  'x-fern-sdk-group-name': ['settings', 'email'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: GetEmailAccountResponseSchema } },
      description: 'The account status and the provider table.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The email connector could not be reached.',
    },
    ...unauthorized,
  },
});

export const saveEmailAccountRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Connect an email account',
  description:
    'Checks the sign-in with the mail server first and saves the account only when it passes. The password goes to the sidecar only and is never stored by the app or returned.',
  'x-fern-sdk-group-name': ['settings', 'email'],
  'x-fern-sdk-method-name': 'save_account',
  request: {
    body: { content: { 'application/json': { schema: SaveEmailAccountRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: SaveEmailAccountResponseSchema } },
      description: 'The account is connected.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The details could not be used, the password was refused, or the server could not be reached.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The email connector could not be reached.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const removeEmailAccountRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Remove the email account',
  description: 'Deletes the saved account and its app password from the sidecar for good.',
  'x-fern-sdk-group-name': ['settings', 'email'],
  'x-fern-sdk-method-name': 'remove_account',
  responses: {
    200: {
      content: { 'application/json': { schema: RemoveEmailAccountResponseSchema } },
      description: 'The account is removed.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The email connector could not be reached.',
    },
    ...unauthorized,
    ...refused,
  },
});
