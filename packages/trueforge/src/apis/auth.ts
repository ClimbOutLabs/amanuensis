import { OpenAPIHono } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import { ADDRESS_NOT_LISTED_MESSAGE, requestAllowedOrigin } from '../auth/allowedOrigins';
import {
  ID_TOKEN_COOKIE,
  OAUTH_STATE_COOKIE,
  clearAuthCookie,
  readIdTokenCookie,
  readOAuthStateCookie,
  setAuthCookie,
} from '../auth/cookies';
import { EmailNotAllowedError } from '../auth/emailAllowlist';
import { resolveRequestContext } from '../auth/identity';
import { LOCAL_LOGIN_PAGE_HEADERS, localCreateAccountPage, localSignInPage } from '../auth/localLoginPage';
import {
  LOCAL_SESSION_MAX_AGE_SECONDS,
  getOrCreateLocalSessionSecret,
  issueLocalSessionToken,
  verifyLocalSessionToken,
} from '../auth/localSession';
import {
  LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE,
  LOCAL_SIGN_IN_EXISTS_MESSAGE,
  LOCAL_WRONG_CREDENTIALS_MESSAGE,
  changeLocalUserPassword,
  createLocalUser,
  verifyLocalSignIn,
} from '../auth/localSignIn';
import { clientKeyFor, tooManyText } from '../auth/loginProxy';
import { LoginAttemptLimiter } from '../auth/loginRateLimit';
import { resolveOidcRequestContext } from '../auth/middleware';
import { buildLoginAuthorization, exchangeAuthorizationCode, type OidcDiscoveryHandle } from '../auth/oidc';
import { safeReturnTo } from '../auth/safeReturnTo';
import configuration, { getAllowedOrigins, getPublicUiBasePath, isTrueFoundryModeEnabled } from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ILocalUserStore, LocalUserRecord } from '../db/localUserStore';
import {
  authLoginRoute,
  authLogoutRoute,
  changePasswordRoute,
  meRoute,
  oAuthCallbackRoute,
} from '../routes/authRoutes';
import type { GetMeResponse } from '../schemas/auth';
import { buildTrueFoundryExternalLoginHref, resolveTrueFoundryLoginReturnTo } from '../truefoundry/externalLogin';

/** The only reasons a failed sign-in is given. The sign-in page holds the wording, so text from outside never shows there. */
type LoginErrorCode = 'login_failed' | 'owner_only';

/** Login / OIDC failures land on the public UI home with `?error=<code>`. */
function oauthErrorRedirect(code: LoginErrorCode): string {
  return `${getPublicUiBasePath()}?error=${code}`;
}

const LOGIN_RETRY_SECONDS = 5;

/** Plain page (no script) shown while the identity provider is unreachable; it refreshes itself. */
const LOGIN_UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${String(LOGIN_RETRY_SECONDS)}">
<title>Login unavailable</title>
</head>
<body>
<h1>Login unavailable, retrying</h1>
<p>The sign-in service is not reachable yet. This page refreshes automatically.</p>
</body>
</html>
`;

/**
 * Soft-success probe for callback: a usable session → redirect; a leftover cookie
 * with unusable claims (allowlist, missing user ref, etc.) → clear it and continue
 * so the caller can show a generic login failure without leaking why.
 */
async function redirectIfAlreadyAuthenticated(params: {
  context: Context;
  whenAuthenticated: string;
}): Promise<Response | undefined> {
  try {
    if (await resolveOidcRequestContext(params.context)) {
      return params.context.redirect(params.whenAuthenticated, 302);
    }
  } catch {
    // Valid JWT but unusable claims — drop the stale cookie; treat as unauthenticated.
    clearAuthCookie({ context: params.context, name: ID_TOKEN_COOKIE });
  }
  return undefined;
}

/** The stores local sign-in reads and writes; present only in local mode. */
export interface LocalSignInDeps {
  localUserStore: ILocalUserStore;
  globalSettingsStore: IGlobalSettingsStore;
}

/** String fields of a posted form; files and anything else are dropped. */
async function formFields(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Auth surfaces mounted at /api/v1/auth: login, callback, logout, me.
 * Login, callback, and logout stay public; me requires the injected {@link authMiddleware}.
 * In local mode the login page is Aman's own form (the create form while no user exists,
 * the sign-in form after), and the two form posts live beside the OIDC routes.
 */
export function createAuthRouter(params: {
  /** Undefined when no OIDC provider is configured. */
  oidcDiscovery: OidcDiscoveryHandle | undefined;
  logger: Logger;
  authMiddleware: MiddlewareHandler;
  /** Present only in local sign-in mode. */
  localSignIn?: LocalSignInDeps;
}) {
  const router = new OpenAPIHono();
  const local = params.localSignIn;
  const localLimiter = local === undefined ? undefined : new LoginAttemptLimiter();
  const localClientKey = clientKeyFor(configuration.TRUSTED_PROXY_ADDRESSES);

  // An address the instance was not set up for gets a plain page, never a redirect, so sign-in cannot be steered there.
  const requireListedAddress: MiddlewareHandler = async (c, next) => {
    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.length > 0 && requestAllowedOrigin({ context: c, allowedOrigins }) === undefined) {
      return c.text(ADDRESS_NOT_LISTED_MESSAGE, 400);
    }
    return next();
  };
  router.use('/login', requireListedAddress);
  router.use('/callback', requireListedAddress);
  if (local !== undefined) {
    router.use('/create-account', requireListedAddress);
  }

  /** Signs the person in: a fresh session token in the same cookie the OIDC callback sets. */
  const issueLocalSession = async (c: Context, user: LocalUserRecord): Promise<void> => {
    if (local === undefined) {
      return;
    }
    const secret = await getOrCreateLocalSessionSecret(local.globalSettingsStore);
    const token = await issueLocalSessionToken({ user, secret });
    setAuthCookie({ context: c, name: ID_TOKEN_COOKIE, value: token, maxAgeSeconds: LOCAL_SESSION_MAX_AGE_SECONDS });
  };

  /** The live local session's user, for sending a signed-in person past the form; undefined otherwise. */
  const localSessionUser = async (c: Context): Promise<LocalUserRecord | undefined> => {
    if (local === undefined) {
      return undefined;
    }
    const token = readIdTokenCookie({ context: c });
    if (token === undefined) {
      return undefined;
    }
    const secret = await getOrCreateLocalSessionSecret(local.globalSettingsStore);
    const claims = await verifyLocalSessionToken({ token, secret });
    if (claims === undefined) {
      return undefined;
    }
    const user = await local.localUserStore.getUser();
    return user?.id === claims.user_id && user.session_version === claims.session_version ? user : undefined;
  };

  if (local !== undefined && localLimiter !== undefined) {
    // The form itself, served ahead of the login route like the retry page: the create form while
    // no user exists, the sign-in form after, and a signed-in person is sent straight through.
    const localLoginPage: MiddlewareHandler = async (c, next) => {
      if (c.req.method !== 'GET') {
        return next();
      }
      const pageStart = localLimiter.allowPageStart(localClientKey(c));
      if (!pageStart.allowed) {
        return c.text(tooManyText(pageStart.retryAfterSeconds, 'address'), 429, {
          'Retry-After': String(pageStart.retryAfterSeconds),
        });
      }
      const returnTo = c.req.query('return_to');
      if ((await localSessionUser(c)) !== undefined) {
        return c.redirect(safeReturnTo(returnTo), 302);
      }
      const user = await local.localUserStore.getUser();
      return c.html(
        user === undefined
          ? localCreateAccountPage({ returnTo: returnTo ?? '' })
          : localSignInPage({ returnTo: returnTo ?? '' }),
        200,
        LOCAL_LOGIN_PAGE_HEADERS,
      );
    };
    router.use('/login', localLoginPage);

    // First run: create the one sign-in. The store refuses a second, so this path closes itself.
    router.post('/create-account', async c => {
      const pageStart = localLimiter.allowPageStart(localClientKey(c));
      if (!pageStart.allowed) {
        return c.text(tooManyText(pageStart.retryAfterSeconds, 'address'), 429, {
          'Retry-After': String(pageStart.retryAfterSeconds),
        });
      }
      const fields = await formFields(c);
      const returnTo = fields['return_to'] ?? '';
      const email = fields['email'] ?? '';
      const password = fields['password'] ?? '';
      if (password !== (fields['password_confirm'] ?? '')) {
        return c.html(
          localCreateAccountPage({ returnTo, email, error: LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE }),
          400,
          LOCAL_LOGIN_PAGE_HEADERS,
        );
      }
      const created = await createLocalUser({ store: local.localUserStore, email, password });
      if (!created.ok) {
        if (created.message === LOCAL_SIGN_IN_EXISTS_MESSAGE) {
          return c.html(localSignInPage({ returnTo, email, error: created.message }), 400, LOCAL_LOGIN_PAGE_HEADERS);
        }
        return c.html(
          localCreateAccountPage({ returnTo, email, error: created.message }),
          400,
          LOCAL_LOGIN_PAGE_HEADERS,
        );
      }
      await issueLocalSession(c, created.user);
      return c.redirect(safeReturnTo(returnTo === '' ? undefined : returnTo), 302);
    });

    // The password check sits behind the same limiter that guards the sign-in service's form.
    router.post('/login', async c => {
      const fields = await formFields(c);
      const returnTo = fields['return_to'] ?? '';
      const email = fields['email'] ?? '';
      const password = fields['password'] ?? '';
      const permit = localLimiter.begin(localClientKey(c), email);
      if (!permit.allowed) {
        return c.text(tooManyText(permit.retryAfterSeconds, permit.scope), 429, {
          'Retry-After': String(permit.retryAfterSeconds),
        });
      }
      const existing = await local.localUserStore.getUser();
      if (existing === undefined) {
        permit.finish('abandon');
        return c.redirect('login', 302);
      }
      const user = await verifyLocalSignIn({ store: local.localUserStore, email, password });
      if (user === undefined) {
        permit.finish('failure');
        return c.html(
          localSignInPage({ returnTo, email, error: LOCAL_WRONG_CREDENTIALS_MESSAGE }),
          401,
          LOCAL_LOGIN_PAGE_HEADERS,
        );
      }
      permit.finish('success');
      await issueLocalSession(c, user);
      return c.redirect(safeReturnTo(returnTo === '' ? undefined : returnTo), 302);
    });
  }

  // Registered before the route so the retry page needs no OpenAPI response entry.
  router.use('/login', async (c, next) => {
    if (params.oidcDiscovery !== undefined && params.oidcDiscovery.client() === undefined) {
      return c.html(LOGIN_UNAVAILABLE_PAGE, 503, { 'Retry-After': String(LOGIN_RETRY_SECONDS) });
    }
    return next();
  });

  router.openapi(authLoginRoute, async c => {
    const returnTo = c.req.valid('query').return_to;

    const oidcClient = params.oidcDiscovery?.client();
    if (oidcClient) {
      try {
        const authorizationUrl = await buildLoginAuthorization({
          context: c,
          client: oidcClient,
          returnTo,
        });
        return c.redirect(authorizationUrl, 302);
      } catch (error) {
        params.logger.error('Failed to build login authorization', extractErrorLogFields(error));
        return c.redirect(oauthErrorRedirect('login_failed'), 302);
      }
    }

    if (isTrueFoundryModeEnabled()) {
      try {
        return c.redirect(buildTrueFoundryExternalLoginHref(resolveTrueFoundryLoginReturnTo(returnTo)), 302);
      } catch (error) {
        params.logger.error('Failed to build TrueFoundry external login URL', extractErrorLogFields(error));
        return c.redirect(oauthErrorRedirect('login_failed'), 302);
      }
    }

    return c.redirect(getPublicUiBasePath(), 302);
  });

  router.openapi(oAuthCallbackRoute, async c => {
    const oidcClient = params.oidcDiscovery?.client();
    if (!oidcClient) {
      return c.redirect(getPublicUiBasePath(), 302);
    }

    const query = c.req.valid('query');
    const pending = readOAuthStateCookie({ context: c, logger: params.logger });
    clearAuthCookie({ context: c, name: OAUTH_STATE_COOKIE });

    if (pending?.state !== query.state || query.error || !query.code) {
      // If already authenticated, redirect home instead of showing an error.
      const soft = await redirectIfAlreadyAuthenticated({
        context: c,
        whenAuthenticated: getPublicUiBasePath(),
      });
      if (soft) {
        return soft;
      }
      // The provider's own error text is never passed on: anyone can put words in a link to this address.
      return c.redirect(oauthErrorRedirect('login_failed'), 302);
    }

    try {
      await exchangeAuthorizationCode({
        context: c,
        client: oidcClient,
        callbackParams: new URL(c.req.url).searchParams,
        codeVerifier: pending.code_verifier,
        state: pending.state,
      });
      return c.redirect(safeReturnTo(pending.return_to), 302);
    } catch (error) {
      params.logger.error('Failed to exchange authorization code', extractErrorLogFields(error));
      const soft = await redirectIfAlreadyAuthenticated({
        context: c,
        whenAuthenticated: safeReturnTo(pending.return_to),
      });
      if (soft) {
        return soft;
      }
      // Standalone has one account, so a refused person is told why; a shared allowlist stays undisclosed.
      // Other exchange errors can carry the provider response and address, so they stay in the log above.
      const code = error instanceof EmailNotAllowedError && configuration.STANDALONE ? 'owner_only' : 'login_failed';
      return c.redirect(oauthErrorRedirect(code), 302);
    }
  });

  router.openapi(authLogoutRoute, c => {
    // Cookie deletion is idempotent, so logout also succeeds when no cookie exists.
    clearAuthCookie({ context: c, name: ID_TOKEN_COOKIE });
    return c.body(null, 204);
  });

  const gated = new OpenAPIHono();
  gated.use('*', params.authMiddleware);
  if (local !== undefined && localLimiter !== undefined) {
    gated.openapi(changePasswordRoute, async c => {
      const requestContext = resolveRequestContext(c);
      const body = c.req.valid('json');
      const user = await local.localUserStore.getUser();
      if (user?.id !== requestContext.subject.id) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }
      // A password check like any other: the limiter sits in front of it too.
      const permit = localLimiter.begin(localClientKey(c), user.email);
      if (!permit.allowed) {
        throw new HTTPException(429, { message: tooManyText(permit.retryAfterSeconds, permit.scope) });
      }
      const result = await changeLocalUserPassword({
        store: local.localUserStore,
        user_id: user.id,
        current_password: body.current_password,
        new_password: body.new_password,
      });
      if (!result.ok) {
        permit.finish('failure');
        throw new HTTPException(400, { message: result.message });
      }
      permit.finish('success');
      // The stored session version just went up; re-issue so this session survives its own change.
      await issueLocalSession(c, result.user);
      return c.body(null, 204);
    });
  }
  gated.openapi(meRoute, c => {
    const requestContext = resolveRequestContext(c);
    const body: GetMeResponse = {
      data: {
        // FE logout chrome keys off the connected types (a browser cookie session).
        type:
          local !== undefined
            ? 'local-connected'
            : params.oidcDiscovery?.client() !== undefined
              ? 'oidc-connected'
              : 'default',
        tenant_id: requestContext.tenant_id,
        subject: requestContext.subject,
        roles: requestContext.roles,
      },
    };
    return c.json(body, 200);
  });
  router.route('/', gated);

  return router;
}
