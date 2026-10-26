/**
 * Calendar account API under /api/v1/user/settings/calendar: the Settings Calendar card's endpoints.
 * Browser session only (mounted behind the UI-session middleware, like Google's and Email's), so no
 * agent or API token can read or change the account. The app password passes through the save call
 * to the sidecar's account agent and is never stored here, never logged, and never returned; the
 * responses are built only from the account's public view.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  CALDAV_PROVIDER_PRESETS,
  caldavProviderKeyForUrl,
} from '@truefoundry/trueforge-core/core/calendar/caldav/presets';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration, { calendarMcpUrlFromAccountUrl } from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import {
  getCalendarAccountStatusRoute,
  removeCalendarAccountRoute,
  saveCalendarAccountRoute,
} from '../routes/calendarAccountRoutes';
import {
  CalendarAccountError,
  getCalendarAccountState,
  removeCalendarAccount,
  saveCalendarAccount,
  syncCalendarConnectorWithAccount,
  type CalendarAccountState,
} from '../runtime/calendarAccount';
import type { CalendarAccountStatus } from '../schemas/calendarAccount';
import { requireJsonOrSameOrigin } from './crossSite';
import { TENANT_ID } from './sessions';

export const CALENDAR_SETTINGS_BASE_PATH = '/api/v1/user/settings/calendar';

interface CalendarAccountRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
}

const DEFAULT_PROVIDER_KEY = 'fastmail';

function providerTable(): CalendarAccountStatus['providers'] {
  return CALDAV_PROVIDER_PRESETS.map(preset => ({
    key: preset.key,
    name: preset.name,
    server_url: preset.server_url,
    help_url: preset.help_url,
    help_hint: preset.help_hint,
  }));
}

function statusBody(state: CalendarAccountState): CalendarAccountStatus {
  return {
    available: true,
    state: !state.connected ? 'not_connected' : state.sign_in === 'refused' ? 'sign_in_stopped' : 'connected',
    email: state.account?.email ?? null,
    provider_key: state.account === null ? DEFAULT_PROVIDER_KEY : caldavProviderKeyForUrl(state.account.url),
    providers: providerTable(),
  };
}

function unavailableBody(): CalendarAccountStatus {
  return {
    available: false,
    state: 'not_connected',
    email: null,
    provider_key: DEFAULT_PROVIDER_KEY,
    providers: providerTable(),
  };
}

export function createCalendarAccountRouter(deps: CalendarAccountRouterDeps) {
  const clientDeps = () => ({
    accountUrl: configuration.CALENDAR_ACCOUNT_URL,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const effectiveMcpUrl = () =>
    configuration.CALENDAR_CONNECTOR_URL ?? calendarMcpUrlFromAccountUrl(configuration.CALENDAR_ACCOUNT_URL);

  const syncConnector = async (state: CalendarAccountState) => {
    await syncCalendarConnectorWithAccount({
      state,
      mcpUrl: effectiveMcpUrl(),
      mcpServerStore: deps.mcpServerStore,
      tenant_id: TENANT_ID,
      logger: deps.logger,
    });
  };

  const statusHandler: RouteHandler<typeof getCalendarAccountStatusRoute> = async c => {
    if (configuration.CALENDAR_ACCOUNT_URL === undefined) {
      return c.json({ data: unavailableBody() }, 200);
    }
    try {
      return c.json({ data: statusBody(await getCalendarAccountState(clientDeps())) }, 200);
    } catch (caught) {
      if (caught instanceof CalendarAccountError) {
        // A status read can only fail one way: the connector could not be reached.
        return c.json({ error: { message: caught.message, type: caught.failure } }, 502);
      }
      throw caught;
    }
  };

  const saveHandler: RouteHandler<typeof saveCalendarAccountRoute> = async c => {
    // The account is instance-wide and the router sits behind the browser-session middleware;
    // resolving the caller is the owner check, the same pattern as the other settings routers.
    deps.resolveRequestContext(c);
    const body = c.req.valid('json');
    try {
      const state = await saveCalendarAccount(clientDeps(), {
        provider_key: body.provider_key,
        email: body.email,
        password: body.password,
        username: body.username,
        calendar_url: body.calendar_url,
      });
      await syncConnector(state);
      return c.json({ data: statusBody(state) }, 201);
    } catch (caught) {
      if (caught instanceof CalendarAccountError) {
        return caught.failure === 'connector_unreachable'
          ? c.json({ error: { message: caught.message, type: caught.failure } }, 502)
          : c.json({ error: { message: caught.message, type: caught.failure } }, 400);
      }
      throw caught;
    }
  };

  const removeHandler: RouteHandler<typeof removeCalendarAccountRoute> = async c => {
    deps.resolveRequestContext(c);
    try {
      const state = await removeCalendarAccount(clientDeps());
      await syncConnector(state);
      return c.json({ data: statusBody(state) }, 200);
    } catch (caught) {
      if (caught instanceof CalendarAccountError) {
        // A removal can only fail one way: the connector could not be reached.
        return c.json({ error: { message: caught.message, type: caught.failure } }, 502);
      }
      throw caught;
    }
  };

  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());
  router.openapi(getCalendarAccountStatusRoute, statusHandler);
  router.openapi(saveCalendarAccountRoute, saveHandler);
  router.openapi(removeCalendarAccountRoute, removeHandler);
  return router;
}
