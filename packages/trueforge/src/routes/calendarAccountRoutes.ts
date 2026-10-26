import { createRoute } from '@hono/zod-openapi';
import {
  GetCalendarAccountResponseSchema,
  RemoveCalendarAccountResponseSchema,
  SaveCalendarAccountRequestSchema,
  SaveCalendarAccountResponseSchema,
} from '../schemas/calendarAccount';
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
    description: 'The request did not come from this app, so nothing was done.',
  },
};

export const getCalendarAccountStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get the calendar account status',
  description:
    'Returns whether a calendar account is connected, its email and provider, and the provider table for the picker. The app password is never returned.',
  'x-fern-sdk-group-name': ['settings', 'calendar'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: GetCalendarAccountResponseSchema } },
      description: 'The account status and the provider table.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The calendar connector could not be reached.',
    },
    ...unauthorized,
  },
});

export const saveCalendarAccountRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Connect a calendar account',
  description:
    'Checks the sign-in with the calendar server first and saves the account only when it passes. The password goes to the sidecar only and is never stored by the app or returned.',
  'x-fern-sdk-group-name': ['settings', 'calendar'],
  'x-fern-sdk-method-name': 'save_account',
  request: {
    body: { content: { 'application/json': { schema: SaveCalendarAccountRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: SaveCalendarAccountResponseSchema } },
      description: 'The account is connected.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The details could not be used, the address is not allowed, the password was refused, or the server could not be reached.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The calendar connector could not be reached.',
    },
    ...unauthorized,
    ...refused,
  },
});

export const removeCalendarAccountRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Remove the calendar account',
  description: 'Deletes the saved account and its app password from the sidecar for good.',
  'x-fern-sdk-group-name': ['settings', 'calendar'],
  'x-fern-sdk-method-name': 'remove_account',
  responses: {
    200: {
      content: { 'application/json': { schema: RemoveCalendarAccountResponseSchema } },
      description: 'The account is removed.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The calendar connector could not be reached.',
    },
    ...unauthorized,
    ...refused,
  },
});
