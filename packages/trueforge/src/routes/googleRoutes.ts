/**
 * Google connection routes, mounted at /api/v1/user/settings/google behind authentication. The OAuth
 * callback is a browser redirect from Google; it carries the user's session cookie, which ties it to the
 * user who started the consent.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  BeginGoogleConsentRequestSchema,
  BeginGoogleConsentResponseSchema,
  CheckGoogleClientRequestSchema,
  CheckGoogleClientResponseSchema,
  CompleteGoogleConsentRequestSchema,
  DisconnectGoogleResponseSchema,
  GetGoogleConnectionStatusResponseSchema,
  GoogleConsentCallbackQuerySchema,
  TestGoogleConnectionResponseSchema,
} from '../schemas/google';
import { OpenApiTag } from './openapiTags';

const unauthorized = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Authentication required.',
  },
};

const forbidden = {
  403: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Unavailable on a demo instance, or the request did not come from the Aman page.',
  },
};

export const getGoogleConnectionStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Google connection status',
  description: 'Whether the caller’s Google account is connected, what it may do, and how this install is set up.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoogleConnectionStatusResponseSchema } },
      description: 'Connection status.',
    },
    ...unauthorized,
  },
});

export const checkGoogleClientRoute = createRoute({
  method: 'post',
  path: '/oauth/check-client',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Check a Google OAuth client',
  description:
    'Checks the client id, secret and type, then asks Google for a dry authorization request. Nothing is stored.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'check_client',
  request: { body: { content: { 'application/json': { schema: CheckGoogleClientRequestSchema } }, required: true } },
  responses: {
    200: {
      content: { 'application/json': { schema: CheckGoogleClientResponseSchema } },
      description: 'Problems found, if any.',
    },
    ...unauthorized,
    ...forbidden,
  },
});

export const beginGoogleConsentRoute = createRoute({
  method: 'post',
  path: '/oauth/begin',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Start connecting Google',
  description: 'Starts a consent with PKCE for the features asked for and returns the Google address to open.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'begin_consent',
  request: { body: { content: { 'application/json': { schema: BeginGoogleConsentRequestSchema } }, required: true } },
  responses: {
    201: {
      content: { 'application/json': { schema: BeginGoogleConsentResponseSchema } },
      description: 'The consent address.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The client cannot be used, no saved client exists to reuse, or sending was asked for without reading.',
    },
    ...unauthorized,
    ...forbidden,
  },
});

export const googleConsentCallbackRoute = createRoute({
  method: 'get',
  path: '/oauth/callback',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Google consent callback',
  description: 'Browser redirect target for the consent. The browser lands here and sees a short page.',
  'x-fern-ignore': true,
  'x-excluded': true,
  request: { query: GoogleConsentCallbackQuerySchema },
  responses: {
    200: { content: { 'text/html': { schema: z.string() } }, description: 'Result page.' },
    400: { content: { 'text/html': { schema: z.string() } }, description: 'Declined, expired or mismatched.' },
  },
});

export const completeGoogleConsentRoute = createRoute({
  method: 'post',
  path: '/oauth/complete',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Finish connecting Google with a pasted address',
  description: 'For a browser that cannot reach this server: reads the code and state from the pasted address.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'complete_consent',
  request: {
    body: { content: { 'application/json': { schema: CompleteGoogleConsentRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetGoogleConnectionStatusResponseSchema } },
      description: 'Connection status after consent.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The address has no code, or the consent expired or does not match.',
    },
    ...unauthorized,
    ...forbidden,
  },
});

export const testGoogleConnectionRoute = createRoute({
  method: 'post',
  path: '/test',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Test the Google connection',
  description: 'Checks the stored login against Google and names the account.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'test_connection',
  responses: {
    200: {
      content: { 'application/json': { schema: TestGoogleConnectionResponseSchema } },
      description: 'Test outcome.',
    },
    ...unauthorized,
    ...forbidden,
  },
});

export const disconnectGoogleRoute = createRoute({
  method: 'post',
  path: '/disconnect',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Disconnect Google',
  description:
    'Revokes Aman’s access at Google, then deletes the stored login. The login is deleted even when Google cannot confirm.',
  'x-fern-sdk-group-name': ['settings', 'google'],
  'x-fern-sdk-method-name': 'disconnect',
  responses: {
    200: {
      content: { 'application/json': { schema: DisconnectGoogleResponseSchema } },
      description: 'The login was removed; says whether Google confirmed the revocation.',
    },
    ...unauthorized,
    ...forbidden,
  },
});
