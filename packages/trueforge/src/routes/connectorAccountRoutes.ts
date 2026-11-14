import { createRoute, type z } from '@hono/zod-openapi';
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
    description: 'The caller is not an admin, or the request did not come from this app, so nothing was done.',
  },
};

/**
 * The routes of an account card (status, connect, remove, set default), the same for Email and
 * Calendar. Each kind supplies its names, its sentences and its own schemas; the shape of the
 * contract is written once.
 */
export function createConnectorAccountRoutes<
  TGet extends z.ZodType,
  TSaveRequest extends z.ZodType,
  TSave extends z.ZodType,
  TRemoveRequest extends z.ZodType,
  TRemove extends z.ZodType,
  TSetDefaultRequest extends z.ZodType,
  TSetDefault extends z.ZodType,
>({
  group,
  noun,
  provider,
  statusSentence,
  saveFailureSentence,
  schemas,
}: {
  /** The Fern group and path name, such as email. */
  group: string;
  /** What the account is called in summaries, such as email account. */
  noun: string;
  /** What the sign-in is checked with, such as the mail server. */
  provider: string;
  /** What the status carries besides the state, such as its address and provider. */
  statusSentence: string;
  /** The ways a save can fail, as one sentence. */
  saveFailureSentence: string;
  schemas: {
    get: TGet;
    saveRequest: TSaveRequest;
    save: TSave;
    removeRequest: TRemoveRequest;
    remove: TRemove;
    setDefaultRequest: TSetDefaultRequest;
    setDefault: TSetDefault;
  };
}) {
  const nounWithArticle = `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
  const connectorUnreachable = {
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: `The ${group} connector could not be reached.`,
    },
  };
  return {
    status: createRoute({
      method: 'get',
      path: '/status',
      tags: [OpenApiTag.PERSONALIZATION],
      summary: `Get the ${noun} status`,
      description: `Returns whether ${nounWithArticle} is connected, ${statusSentence}, and the provider table for the picker. The app password is never returned.`,
      'x-fern-sdk-group-name': ['settings', group],
      'x-fern-sdk-method-name': 'get_status',
      responses: {
        200: {
          content: { 'application/json': { schema: schemas.get } },
          description: 'The account status and the provider table.',
        },
        ...connectorUnreachable,
        ...unauthorized,
        ...refused,
      },
    }),
    save: createRoute({
      method: 'post',
      path: '/',
      tags: [OpenApiTag.PERSONALIZATION],
      summary: `Connect ${nounWithArticle}`,
      description: `Checks the sign-in with ${provider} first and saves the account only when it passes. The password goes to the sidecar only and is never stored by the app or returned.`,
      'x-fern-sdk-group-name': ['settings', group],
      'x-fern-sdk-method-name': 'save_account',
      request: {
        body: { content: { 'application/json': { schema: schemas.saveRequest } }, required: true },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: schemas.save } },
          description: 'The account is connected.',
        },
        400: {
          content: { 'application/json': { schema: RequestErrorResponseSchema } },
          description: saveFailureSentence,
        },
        ...connectorUnreachable,
        ...unauthorized,
        ...refused,
      },
    }),
    remove: createRoute({
      method: 'delete',
      path: '/',
      tags: [OpenApiTag.PERSONALIZATION],
      summary: `Remove the ${noun}`,
      description:
        'Deletes the named account and its app password from the sidecar for good, or every account when the body names none.',
      'x-fern-sdk-group-name': ['settings', group],
      'x-fern-sdk-method-name': 'remove_account',
      request: {
        body: { content: { 'application/json': { schema: schemas.removeRequest } }, required: false },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: schemas.remove } },
          description: 'The account is removed.',
        },
        ...connectorUnreachable,
        ...unauthorized,
        ...refused,
      },
    }),
    setDefault: createRoute({
      method: 'post',
      path: '/default',
      tags: [OpenApiTag.PERSONALIZATION],
      summary: `Set the default ${noun}`,
      description: `Makes the named connected account the default. Naming an account that is not connected changes nothing.`,
      'x-fern-sdk-group-name': ['settings', group],
      'x-fern-sdk-method-name': 'set_default_account',
      request: {
        body: { content: { 'application/json': { schema: schemas.setDefaultRequest } }, required: true },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: schemas.setDefault } },
          description: 'The default account is set.',
        },
        400: {
          content: { 'application/json': { schema: RequestErrorResponseSchema } },
          description: 'The named account is not connected.',
        },
        ...connectorUnreachable,
        ...unauthorized,
        ...refused,
      },
    }),
  };
}
