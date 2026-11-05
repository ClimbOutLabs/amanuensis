import type { Logger } from 'winston';

import configuration from '../config';
import { createTlsFetch, normalizeTlsUrl } from '../http/tls';
import { RunNoticingResponseSchema, type NoticingWatcher } from '../schemas/reach';
import type { ControlLoop } from './Controller';

/** Mail is looked at every 10 minutes, the calendar every 30, and waiting approvals alongside the mail. */
export const MAIL_WATCH_INTERVAL_MS = 10 * 60_000;
export const CALENDAR_WATCH_INTERVAL_MS = 30 * 60_000;
export const APPROVAL_WATCH_INTERVAL_MS = 10 * 60_000;

/** A pass reads mail and may ask a model once per new event, so it is given longer than a plain request. */
const NOTICING_REQUEST_TIMEOUT_MS = 5 * 60_000;

export type NoticingRunner = (watcher: NoticingWatcher) => Promise<{ owners: number; raised: number }>;

/**
 * HTTP handoff to `POST /api/internal/noticing/run`. Like the schedule loop, the controller holds no mail, calendar or
 * model access itself: the server does the pass, in the dedicated controller and as a loopback in standalone alike.
 */
export function createHttpNoticingRunner(): NoticingRunner {
  const tls = { enabled: configuration.TRUEFORGE_MTLS_ENABLED, dir: configuration.TRUEFORGE_MTLS_CERTS_DIR };
  const send = createTlsFetch(tls) ?? fetch;
  const base = normalizeTlsUrl({ url: configuration.SERVER_URL, enabled: tls.enabled });
  return async watcher => {
    const response = await send(`${base.replace(/\/$/, '')}/api/internal/noticing/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
      body: JSON.stringify({ watcher }),
      signal: AbortSignal.timeout(NOTICING_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`The server refused the ${watcher} pass with status ${String(response.status)}.`);
    }
    return RunNoticingResponseSchema.parse(await response.json()).data;
  };
}

function watcherLoop({
  watcher,
  intervalMs,
  run,
  logger,
}: {
  watcher: NoticingWatcher;
  intervalMs: number;
  run: NoticingRunner;
  logger: Logger;
}): ControlLoop {
  return {
    name: `noticing-${watcher}`,
    intervalMs,
    async tick() {
      const result = await run(watcher);
      if (result.raised > 0) {
        logger.debug('Noticing pass raised events', { watcher, ...result });
      }
    },
  };
}

export function noticingLoops({
  logger,
  run = createHttpNoticingRunner(),
}: {
  logger: Logger;
  run?: NoticingRunner;
}): ControlLoop[] {
  return [
    watcherLoop({ watcher: 'mail', intervalMs: MAIL_WATCH_INTERVAL_MS, run, logger }),
    watcherLoop({ watcher: 'calendar', intervalMs: CALENDAR_WATCH_INTERVAL_MS, run, logger }),
    watcherLoop({ watcher: 'approvals', intervalMs: APPROVAL_WATCH_INTERVAL_MS, run, logger }),
  ];
}
