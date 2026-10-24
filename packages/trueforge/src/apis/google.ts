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
import configuration, { getAllowedOrigins } from '../config';
import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import {
  beginGoogleConsentRoute,
  checkGoogleClientRoute,
  completeGoogleConsentRoute,
  disconnectGoogleRoute,
  getGoogleConnectionStatusRoute,
  GOOGLE_CALLBACK_PATH,
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

function statusBody(input: { record: GoogleConnectionRecord | null; setup: GoogleSetupInfo; locked: boolean }) {
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
    locked: input.locked,
    setup: input.setup,
  };
}

/**
 * The addresses the installer serves this instance on, as recorded origins: the public address plus the
 * recorded origins. These are the only addresses a request may name as its own; anything else is not Aman's.
 */
function instanceOrigins(): string[] {
  const origins = [...getAllowedOrigins()];
  try {
    const publicOrigin = new URL(configuration.PUBLIC_BASE_URL).origin;
    if (!origins.includes(publicOrigin)) {
      origins.unshift(publicOrigin);
    }
  } catch {
    // No usable public address configured; the recorded origins are the whole list.
  }
  return origins;
}

/**
 * The address the browser used. A proxy in front of Aman may have rewritten it, so the forwarded host counts
 * only when it names an address the installer serves this instance on: the public address, or one of the
 * recorded origins, whose own address is then the browser's. Any other forwarded value is ignored.
 */
function browserUrlOf(c: Parameters<ResolveRequestContext>[0]): string {
  const url = new URL(c.req.url);
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost === undefined || forwardedHost === '') {
    return url.toString();
  }
  for (const origin of getAllowedOrigins()) {
    let recorded: URL;
    try {
      recorded = new URL(origin);
    } catch {
      continue;
    }
    if (recorded.host.toLowerCase() === forwardedHost.toLowerCase()) {
      try {
        return new URL(`${url.pathname}${url.search}`, recorded.origin).toString();
      } catch {
        return url.toString();
      }
    }
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
    const allowed = new Set([new URL(browserUrlOf(c)).origin, ...instanceOrigins()]);
    if (origin !== undefined && allowed.has(origin)) {
      return next();
    }
    return c.json({ error: { message: NOT_FROM_AMAN, type: 'cross_site_request' } }, 403);
  };
}

const DEMO_LOCKED_MESSAGE = "This demo's Google account is already set up and cannot be changed.";
const DEMO_NOT_NAMED_MESSAGE =
  "Google cannot be connected on this demo until its owner names the demo's Google account.";

/**
 * Whether Settings may start or finish a Google connection on a demo instance: only when the owner has named
 * the demo's account, and no working login with every feature is saved for it yet. A saved login that is for
 * another account, that Google stopped accepting, or that lacks a feature can be replaced by the named account.
 */
function demoMayConnect(input: { record: GoogleConnectionRecord | null; account: string }): boolean {
  const { record, account } = input;
  if (account === '') {
    return false;
  }
  if (record === null || record.status === 'needs_reconnect' || record.account_email?.toLowerCase() !== account) {
    return true;
  }
  const granted = grantedFeatures(record.granted_scopes);
  return GOOGLE_FEATURES.some(feature => !granted.includes(feature));
}

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
  const demoAccount = () => (configuration.DEMO_MODE ? configuration.DEMO_GOOGLE_ACCOUNT : '');
  // Built per request so the demo's pinned account is read when it is used.
  const serviceNow = () =>
    new GoogleConnectService({
      now: undefined,
      connections: deps.googleConnectionStore,
      pending: deps.googleConnectionStore,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
      only_account_email: configuration.DEMO_MODE ? demoAccount() : null,
    });
  const lockedFor = (record: GoogleConnectionRecord | null) =>
    configuration.DEMO_MODE && !demoMayConnect({ record, account: demoAccount() });

  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const requestContext = deps.resolveRequestContext(c);
    return { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
  };
  const setupFor = (c: Parameters<ResolveRequestContext>[0]) =>
    resolveGoogleSetup({
      public_base_url: configuration.PUBLIC_BASE_URL,
      request_url: browserUrlOf(c),
      callback_path: GOOGLE_CALLBACK_PATH,
    });

  const statusHandler: RouteHandler<typeof getGoogleConnectionStatusRoute> = async c => {
    const record = await deps.googleConnectionStore.get(ownerOf(c));
    return c.json({ data: statusBody({ record, setup: setupFor(c), locked: lockedFor(record) }) }, 200);
  };

  const checkHandler: RouteHandler<typeof checkGoogleClientRoute> = async c => {
    const body = c.req.valid('json');
    const problems = await serviceNow().checkClient({
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
      const { authorization_url } = await serviceNow().begin({
        owner: ownerOf(c),
        setup,
        client: body.client === undefined ? null : toClientInput(body.client),
        // A demo locks once every feature is granted, so its one consent asks for all of them.
        features: configuration.DEMO_MODE ? GOOGLE_FEATURES : body.features,
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
      await serviceNow().complete({ owner: ownerOf(c), state, code });
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
      const record = await serviceNow().complete({ owner, state: parsed.state, code: parsed.code });
      return c.json({ data: statusBody({ record, setup: setupFor(c), locked: lockedFor(record) }) }, 200);
    } catch (caught) {
      if (caught instanceof GoogleConsentError) {
        deps.logger.warn('Google consent completion refused', extractErrorLogFields(caught));
        return c.json({ error: { message: caught.message, type: 'consent_failed' } }, 400);
      }
      throw caught;
    }
  };

  const testHandler: RouteHandler<typeof testGoogleConnectionRoute> = async c => {
    return c.json({ data: await serviceNow().test(ownerOf(c)) }, 200);
  };

  const disconnectHandler: RouteHandler<typeof disconnectGoogleRoute> = async c => {
    const outcome = await serviceNow().disconnect(ownerOf(c));
    return c.json({ data: { revocation_confirmed: outcome === 'revoked' } }, 200);
  };

  const refuseOnDemo = (c: Parameters<MiddlewareHandler>[0], message: string) =>
    c.json({ error: { message, type: 'unavailable' } }, 403);

  /**
   * On a demo instance only the demo's named Google account can be connected, once, before visitors arrive.
   * Registered first so it guards the routes below.
   */
  const lockConnectionOnDemo: MiddlewareHandler = async (c, next) => {
    if (!configuration.DEMO_MODE) {
      return next();
    }
    const account = demoAccount();
    if (account === '') {
      return refuseOnDemo(c, DEMO_NOT_NAMED_MESSAGE);
    }
    const record = await deps.googleConnectionStore.get(ownerOf(c));
    return demoMayConnect({ record, account }) ? next() : refuseOnDemo(c, DEMO_LOCKED_MESSAGE);
  };
  const refuseDisconnectOnDemo: MiddlewareHandler = async (c, next) =>
    configuration.DEMO_MODE ? refuseOnDemo(c, DEMO_LOCKED_MESSAGE) : next();

  const router = new OpenAPIHono();
  router.use('/oauth/*', lockConnectionOnDemo);
  router.use('/test', requireJsonOrSameOrigin());
  router.use('/disconnect', refuseDisconnectOnDemo, requireJsonOrSameOrigin());
  router.openapi(getGoogleConnectionStatusRoute, statusHandler);
  router.openapi(checkGoogleClientRoute, checkHandler);
  router.openapi(beginGoogleConsentRoute, beginHandler);
  router.openapi(googleConsentCallbackRoute, callbackHandler);
  router.openapi(completeGoogleConsentRoute, completeHandler);
  router.openapi(testGoogleConnectionRoute, testHandler);
  router.openapi(disconnectGoogleRoute, disconnectHandler);
  return router;
}
