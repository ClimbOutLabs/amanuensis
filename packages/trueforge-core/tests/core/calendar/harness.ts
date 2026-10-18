import { createLogger, type Logger } from 'winston';
import { CalendarApi } from '../../../src/core/calendar/CalendarApi';
import { CalendarToolSet } from '../../../src/core/calendar/CalendarToolSet';
import { GoogleAccessTokens } from '../../../src/core/google/GoogleAccessTokens';
import { GOOGLE_TOKEN_URL } from '../../../src/core/google/oauth';
import type { GoogleFeature } from '../../../src/core/google/scopes';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { json, scriptedGoogle, type Route } from '../email/gmail/harness';
import { connectedRecord, FakeConnections, OWNER } from '../google/fakes';

export { googleError, json, text } from '../email/gmail/harness';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const EVENTS_PATH = '/calendar/v3/calendars/primary/events';

/** The list endpoint, answering every request with the same page. */
export const eventsRoute =
  (body: unknown, status = 200): Route =>
  url =>
    url.pathname === EVENTS_PATH ? json(body, status) : undefined;

export const eventRoute =
  (id: string, body: unknown, status = 200): Route =>
  url =>
    url.pathname === `${EVENTS_PATH}/${encodeURIComponent(id)}` ? json(body, status) : undefined;

export async function build(input: {
  routes: Route[];
  features?: GoogleFeature[];
  unattended?: boolean;
  timeZone?: string | undefined;
  /** Google refuses the stored login when a new access token is asked for. */
  tokenRefused?: boolean;
  /** Shared across builds so a held call and its later approval use one token store. */
  services?: SentinelServices;
  /** Shared across builds so a later turn sees what an earlier one wrote. */
  google?: ReturnType<typeof scriptedGoogle>;
  logger?: Logger;
}) {
  const connections = new FakeConnections();
  await connections.save(
    connectedRecord({ granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly', CALENDAR_SCOPE] }),
  );
  const google = input.google ?? scriptedGoogle(input.routes);
  const fetchImpl: typeof fetch = (request, init) =>
    input.tokenRefused === true &&
    (typeof request === 'string' ? request : request instanceof URL ? request.href : request.url).startsWith(
      GOOGLE_TOKEN_URL,
    )
      ? Promise.resolve(json({ error: 'invalid_grant' }, 400))
      : google.fetchImpl(request, init);
  const api = new CalendarApi({
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl }),
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  const services = input.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const sentinel = createSentinelHostContext({
    ...OWNER,
    conversation_id: 'c1',
    services: input.unattended === true ? forUnattendedRun(services) : services,
  });
  const tools = new CalendarToolSet({
    tracing: NOOP_AGENT_TRACING,
    api,
    account: 'ada@example.com',
    features: input.features ?? ['gmail_read', 'calendar_read'],
    timeZone: 'timeZone' in input ? input.timeZone : 'America/Sao_Paulo',
    sentinel,
    logger: input.logger ?? createLogger({ silent: true }),
  });
  return { tools, google, sentinel, connections };
}

/** The query Aman sent for the most recent events request. */
export function lastEventsQuery(urls: string[]): URLSearchParams {
  const request = urls.filter(entry => entry.includes(EVENTS_PATH)).at(-1) ?? '';
  return new URL(`https://example.test${request.split(' ')[1] ?? ''}`).searchParams;
}
