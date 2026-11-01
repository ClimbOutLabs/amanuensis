/**
 * Calendar account API under /api/v1/user/settings/calendar: the Settings Calendar card's endpoints. What each
 * call does is shared with Email (see connectorAccountHandlers.ts); this file holds Calendar's own status shape.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  CALDAV_GOOGLE_PROVIDER_KEY,
  CALDAV_PROVIDER_PRESETS,
  caldavProviderKeyForUrl,
} from '@truefoundry/trueforge-core/core/calendar/caldav/presets';
import type { Logger } from 'winston';
import configuration from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import { calendarAccountRoutes } from '../routes/calendarAccountRoutes';
import {
  getCalendarAccountState,
  removeCalendarAccount,
  saveCalendarAccount,
  syncCalendarConnectorWithAccount,
  type PublicCalendarAccount,
} from '../runtime/calendarAccount';
import { connectionStateOf } from '../runtime/connectorAccount';
import type { CalendarAccountStatus, SaveCalendarAccountRequest } from '../schemas/calendarAccount';
import { createConnectorAccountHandlers } from './connectorAccountHandlers';
import { requireJsonOrSameOrigin } from './crossSite';
import { TENANT_ID } from './sessions';

export const CALENDAR_SETTINGS_BASE_PATH = '/api/v1/user/settings/calendar';

interface CalendarAccountRouterDeps {
  logger: Logger;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer' | 'getServer'>;
}

const DEFAULT_PROVIDER_KEY = CALDAV_GOOGLE_PROVIDER_KEY;

function providerTable(): CalendarAccountStatus['providers'] {
  return CALDAV_PROVIDER_PRESETS.map(preset => ({
    key: preset.key,
    name: preset.name,
    server_url: preset.server_url,
    account_url_template: preset.account_url_template,
    help_url: preset.help_url,
    help_hint: preset.help_hint,
    setup_steps: [...preset.setup_steps],
  }));
}

export function createCalendarAccountRouter(deps: CalendarAccountRouterDeps) {
  const clientDeps = () => ({
    accountUrl: configuration.CALENDAR_ACCOUNT_URL,
    secret: configuration.CALENDAR_ACCOUNT_SECRET,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });
  const handlers = createConnectorAccountHandlers<
    PublicCalendarAccount,
    SaveCalendarAccountRequest,
    CalendarAccountStatus
  >({
    // The card needs both the agent's address and the secret it answers to.
    isAvailable: () =>
      configuration.CALENDAR_ACCOUNT_URL !== undefined && configuration.CALENDAR_ACCOUNT_SECRET !== undefined,
    unavailableBody: () => ({
      available: false,
      state: 'not_connected',
      email: null,
      username: null,
      calendar_url: null,
      provider_key: DEFAULT_PROVIDER_KEY,
      providers: providerTable(),
    }),
    statusBody: state => ({
      available: true,
      state: connectionStateOf(state),
      email: state.account?.email ?? null,
      username: state.account?.username ?? null,
      calendar_url: state.account?.url ?? null,
      provider_key: state.account === null ? DEFAULT_PROVIDER_KEY : caldavProviderKeyForUrl(state.account.url),
      providers: providerTable(),
    }),
    readState: options => getCalendarAccountState(clientDeps(), options),
    save: request =>
      saveCalendarAccount(clientDeps(), {
        provider_key: request.provider_key,
        email: request.email,
        password: request.password,
        username: request.username,
        calendar_url: request.calendar_url,
      }),
    remove: () => removeCalendarAccount(clientDeps()),
    sync: state =>
      syncCalendarConnectorWithAccount({
        state,
        mcpUrl: configuration.CALENDAR_SIDECAR_MCP_URL,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: TENANT_ID,
        logger: deps.logger,
      }),
  });

  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());
  router.openapi(calendarAccountRoutes.status, async c => {
    const answer = await handlers.status();
    return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, 502);
  });
  router.openapi(calendarAccountRoutes.save, async c => {
    const answer = await handlers.save(c.req.valid('json'));
    if (answer.status === 201) {
      return c.json(answer.body, 201);
    }
    return answer.status === 400 ? c.json(answer.body, 400) : c.json(answer.body, 502);
  });
  router.openapi(calendarAccountRoutes.remove, async c => {
    const answer = await handlers.remove();
    return answer.status === 200 ? c.json(answer.body, 200) : c.json(answer.body, 502);
  });
  return router;
}
