/** Google connection API under /api/v1/user/settings/google: one login per user, on the user's own client. */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import {
  GoogleClientError,
  GoogleConnectService,
  GoogleConsentError,
  GoogleFeatureError,
  type GoogleClientInput,
} from '@truefoundry/trueforge-core/core/google/GoogleConnectService';
import { GOOGLE_FEATURES, googleFeatureLabel, grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { GoogleSetupInfo } from '@truefoundry/trueforge-core/core/google/setupMode';
import { parsePastedAddress, resolveGoogleSetup } from '@truefoundry/trueforge-core/core/google/setupMode';
import type { MiddlewareHandler } from 'hono';
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

interface GoogleRouterDeps {
  googleConnectionStore: IGoogleConnectionStore;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Replaceable so tests never reach Google. */
  fetchImpl: typeof fetch | undefined;
}

const RESULT_PAGE_STYLE = 'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resultPage(lines: string[]): string {
  const body = lines.map(line => `<p>${escapeHtml(line)}</p>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google</title><body style="${RESULT_PAGE_STYLE}">${body}`;
}

const START_AGAIN = 'Go back to Aman and start again.';

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
    available: !configuration.DEMO_MODE,
    setup: input.setup,
  };
}

/**
 * The address the browser used. A proxy in front of Aman may have rewritten it, so the forwarded host and
 * protocol count only when the host is the public address itself; any other forwarded value is ignored.
 */
function browserUrlOf(c: Parameters<ResolveRequestContext>[0]): string {
  const url = new URL(c.req.url);
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost === undefined || forwardedHost === '') {
    return url.toString();
  }
  let publicHost: string;
  try {
    publicHost = new URL(configuration.PUBLIC_BASE_URL).host;
  } catch {
    return url.toString();
  }
  if (forwardedHost.toLowerCase() !== publicHost.toLowerCase()) {
    return url.toString();
  }
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : url.protocol.slice(0, -1);
  try {
    return new URL(`${url.pathname}${url.search}`, `${proto}://${forwardedHost}`).toString();
  } catch {
    return url.toString();
  }
}

const NOT_FROM_AMAN = 'That request did not come from Aman, so nothing was done.';

/**
 * Blocks a cross-site form from firing a state-changing call that has no body. A page on another site can
 * submit a form but cannot send JSON or a same-origin Origin header; Aman's own pages do at least one.
 */
function requireJsonOrSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType === 'application/json') {
      return next();
    }
    const origin = c.req.header('origin');
    const allowed = new Set([new URL(browserUrlOf(c)).origin]);
    try {
      allowed.add(new URL(configuration.PUBLIC_BASE_URL).origin);
    } catch {
      // No usable public address configured; the request's own address is the only one.
    }
    if (origin !== undefined && allowed.has(origin)) {
      return next();
    }
    return c.json({ error: { message: NOT_FROM_AMAN, type: 'cross_site_request' } }, 403);
  };
}

/** A demo instance never connects Google; only the status read, which says so, is answered. */
const refuseOnDemo: MiddlewareHandler = async (c, next) => {
  if (configuration.DEMO_MODE) {
    return c.json({ error: { message: 'Google cannot be connected on a demo instance.', type: 'unavailable' } }, 403);
  }
  return next();
};

function toClientInput(body: {
  client_id: string;
  client_secret: string;
  client_type?: GoogleClientInput['client_type'] | undefined;
}): GoogleClientInput {
  return {
    client_id: body.client_id.trim(),
    client_secret: body.client_secret.trim(),
    client_type: body.client_type ?? null,
  };
}

export function createGoogleRouter(deps: GoogleRouterDeps) {
  const service = new GoogleConnectService({
    now: undefined,
    connections: deps.googleConnectionStore,
    pending: deps.googleConnectionStore,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });

  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const requestContext = deps.resolveRequestContext(c);
    return { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
  };
  const setupFor = (c: Parameters<ResolveRequestContext>[0]) =>
    resolveGoogleSetup({ public_base_url: configuration.PUBLIC_BASE_URL, request_url: browserUrlOf(c) });

  const statusHandler: RouteHandler<typeof getGoogleConnectionStatusRoute> = async c => {
    const record = await deps.googleConnectionStore.get(ownerOf(c));
    return c.json({ data: statusBody({ record, setup: setupFor(c) }) }, 200);
  };

  const checkHandler: RouteHandler<typeof checkGoogleClientRoute> = async c => {
    const body = c.req.valid('json');
    const problems = await service.checkClient({
      client: toClientInput(body.client),
      registered_redirect_uris: body.registered_redirect_uris,
      setup: setupFor(c),
    });
    return c.json({ data: { ok: problems.length === 0, problems } }, 200);
  };

  const beginHandler: RouteHandler<typeof beginGoogleConsentRoute> = async c => {
    const body = c.req.valid('json');
    const setup = setupFor(c);
    try {
      const { authorization_url } = await service.begin({
        owner: ownerOf(c),
        setup,
        client: body.client === undefined ? null : toClientInput(body.client),
        features: body.features,
      });
      return c.json({ data: { authorization_url, setup } }, 201);
    } catch (error) {
      if (error instanceof GoogleClientError) {
        return c.json({ error: { message: error.message, type: 'invalid_client' } }, 400);
      }
      if (error instanceof GoogleFeatureError) {
        return c.json({ error: { message: error.message, type: 'invalid_features' } }, 400);
      }
      throw error;
    }
  };

  const callbackHandler: RouteHandler<typeof googleConsentCallbackRoute> = async c => {
    const { code, state, error } = c.req.valid('query');
    if (error !== undefined) {
      return c.html(resultPage(['Access was not granted, so Google was not connected.', START_AGAIN]), 400);
    }
    if (code === undefined || state === undefined) {
      return c.html(resultPage(['The response from Google was incomplete.', START_AGAIN]), 400);
    }
    try {
      await service.complete({ owner: ownerOf(c), state, code });
      return c.html(resultPage(['Google is connected. You can close this window and go back to Aman.']), 200);
    } catch (caught) {
      if (caught instanceof GoogleConsentError) {
        deps.logger.warn('Google consent callback refused', extractErrorLogFields(caught));
        return c.html(resultPage([caught.message, START_AGAIN]), 400);
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
      return c.json({ data: statusBody({ record, setup: setupFor(c) }) }, 200);
    } catch (caught) {
      if (caught instanceof GoogleConsentError) {
        deps.logger.warn('Google consent completion refused', extractErrorLogFields(caught));
        return c.json({ error: { message: caught.message, type: 'consent_failed' } }, 400);
      }
      throw caught;
    }
  };

  const testHandler: RouteHandler<typeof testGoogleConnectionRoute> = async c => {
    return c.json({ data: await service.test(ownerOf(c)) }, 200);
  };

  const disconnectHandler: RouteHandler<typeof disconnectGoogleRoute> = async c => {
    const outcome = await service.disconnect(ownerOf(c));
    return c.json({ data: { revocation_confirmed: outcome === 'revoked' } }, 200);
  };

  const router = new OpenAPIHono();
  // Registered first so they guard the routes below; the status read stays open to say Google is unavailable.
  router.use('/oauth/*', refuseOnDemo);
  router.use('/test', refuseOnDemo, requireJsonOrSameOrigin());
  router.use('/disconnect', refuseOnDemo, requireJsonOrSameOrigin());
  router.openapi(getGoogleConnectionStatusRoute, statusHandler);
  router.openapi(checkGoogleClientRoute, checkHandler);
  router.openapi(beginGoogleConsentRoute, beginHandler);
  router.openapi(googleConsentCallbackRoute, callbackHandler);
  router.openapi(completeGoogleConsentRoute, completeHandler);
  router.openapi(testGoogleConnectionRoute, testHandler);
  router.openapi(disconnectGoogleRoute, disconnectHandler);
  return router;
}
