/** Google connection API under /api/v1/user/settings/google: one login per user, on the user's own client. */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import {
  GoogleClientError,
  GoogleConnectService,
  GoogleConsentError,
  type GoogleClientInput,
} from '@truefoundry/trueforge-core/core/google/GoogleConnectService';
import { GOOGLE_FEATURES, googleFeatureLabel, grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { GoogleSetupInfo } from '@truefoundry/trueforge-core/core/google/setupMode';
import { parsePastedAddress, resolveGoogleSetup } from '@truefoundry/trueforge-core/core/google/setupMode';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import {
  beginGoogleConsentRoute,
  checkGoogleClientRoute,
  completeGoogleConsentRoute,
  disconnectGoogleRoute,
  getGoogleConnectionStatusRoute,
  googleConsentCallbackRoute,
  testGoogleConnectionRoute,
} from '../routes/googleRoutes';

export interface GoogleRouterDeps {
  googleConnectionStore: IGoogleConnectionStore;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Replaceable so tests never reach Google. */
  fetchImpl?: typeof fetch | undefined;
}

const RESULT_PAGE_STYLE = 'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem';

function resultPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Google</title><body style="${RESULT_PAGE_STYLE}"><p>${message}</p>`;
}

function statusBody(input: { record: GoogleConnectionRecord | null; setup: GoogleSetupInfo }) {
  const { record } = input;
  const granted = record === null ? [] : grantedFeatures(record.granted_scopes);
  return {
    state: record === null ? ('not_connected' as const) : record.status,
    account_email: record?.account_email ?? null,
    features: GOOGLE_FEATURES.map(feature => ({
      feature,
      label: googleFeatureLabel(feature),
      granted: granted.includes(feature),
    })),
    has_saved_client: record !== null,
    setup: input.setup,
  };
}

function toClientInput(body: {
  client_id: string;
  client_secret: string;
  client_type: GoogleClientInput['client_type'];
}) {
  return { client_id: body.client_id.trim(), client_secret: body.client_secret.trim(), client_type: body.client_type };
}

export function createGoogleRouter(deps: GoogleRouterDeps) {
  const service = new GoogleConnectService({
    connections: deps.googleConnectionStore,
    pending: deps.googleConnectionStore,
    fetchImpl: deps.fetchImpl,
  });

  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const requestContext = deps.resolveRequestContext(c);
    return { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
  };
  const setupFor = (requestUrl: string) =>
    resolveGoogleSetup({ public_base_url: configuration.PUBLIC_BASE_URL, request_url: requestUrl });

  const statusHandler: RouteHandler<typeof getGoogleConnectionStatusRoute> = async c => {
    const record = await deps.googleConnectionStore.get(ownerOf(c));
    return c.json({ data: statusBody({ record, setup: setupFor(c.req.url) }) }, 200);
  };

  const checkHandler: RouteHandler<typeof checkGoogleClientRoute> = async c => {
    const body = c.req.valid('json');
    const problems = await service.checkClient({
      client: toClientInput(body.client),
      registered_redirect_uris: body.registered_redirect_uris,
      setup: setupFor(c.req.url),
    });
    return c.json({ data: { ok: problems.length === 0, problems } }, 200);
  };

  const beginHandler: RouteHandler<typeof beginGoogleConsentRoute> = async c => {
    const body = c.req.valid('json');
    const setup = setupFor(c.req.url);
    try {
      const { authorization_url } = await service.begin({
        owner: ownerOf(c),
        setup,
        client: body.client === null ? null : toClientInput(body.client),
        features: body.features,
      });
      return c.json({ data: { authorization_url, setup } }, 201);
    } catch (error) {
      if (error instanceof GoogleClientError) {
        return c.json({ error: { message: error.message, type: 'invalid_client' } }, 400);
      }
      throw error;
    }
  };

  const callbackHandler: RouteHandler<typeof googleConsentCallbackRoute> = async c => {
    const { code, state, error } = c.req.valid('query');
    if (error !== undefined) {
      return c.html(
        resultPage('Google was not connected because access was not granted. You can close this window.'),
        400,
      );
    }
    if (code === undefined || state === undefined) {
      return c.html(resultPage('The response from Google was incomplete. Close this window and try again.'), 400);
    }
    try {
      await service.complete({ owner: ownerOf(c), state, code });
      return c.html(resultPage('Google is connected. You can close this window and return to Aman.'), 200);
    } catch (caught) {
      if (caught instanceof GoogleConsentError) {
        deps.logger.warn('Google consent callback refused', extractErrorLogFields(caught));
        return c.html(resultPage(`Google was not connected. ${caught.message}`), 400);
      }
      throw caught;
    }
  };

  const completeHandler: RouteHandler<typeof completeGoogleConsentRoute> = async c => {
    const { address } = c.req.valid('json');
    const parsed = parsePastedAddress(address);
    if (!parsed.ok) {
      return c.json({ error: { message: parsed.message, type: 'invalid_address' } }, 400);
    }
    const owner = ownerOf(c);
    try {
      const record = await service.complete({ owner, state: parsed.state, code: parsed.code });
      return c.json({ data: statusBody({ record, setup: setupFor(c.req.url) }) }, 200);
    } catch (caught) {
      if (caught instanceof GoogleConsentError) {
        deps.logger.warn('Google consent completion refused', extractErrorLogFields(caught));
        return c.json({ error: { message: caught.message, type: 'consent_failed' } }, 400);
      }
      throw caught;
    }
  };

  const testHandler: RouteHandler<typeof testGoogleConnectionRoute> = async c => {
    const outcome = await service.test(ownerOf(c));
    return c.json(
      {
        data: outcome.ok
          ? { result: 'ok' as const, account_email: outcome.account_email }
          : { result: outcome.reason, account_email: null },
      },
      200,
    );
  };

  const disconnectHandler: RouteHandler<typeof disconnectGoogleRoute> = async c => {
    const outcome = await service.disconnect(ownerOf(c));
    return c.json({ data: { disconnected: outcome === 'disconnected' } }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getGoogleConnectionStatusRoute, statusHandler);
  router.openapi(checkGoogleClientRoute, checkHandler);
  router.openapi(beginGoogleConsentRoute, beginHandler);
  router.openapi(googleConsentCallbackRoute, callbackHandler);
  router.openapi(completeGoogleConsentRoute, completeHandler);
  router.openapi(testGoogleConnectionRoute, testHandler);
  router.openapi(disconnectGoogleRoute, disconnectHandler);
  return router;
}
