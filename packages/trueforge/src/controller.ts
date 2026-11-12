import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';
import { getPublicBaseUrl } from './config';
import { Controller } from './controller/Controller';
import { noticingLoops } from './controller/noticingLoops';
import { privateChatSweepLoop } from './controller/privateChatSweep';
import { scheduleDispatchLoop } from './controller/scheduleDispatch';
import { telegramPollLoop, telegramReplyLoop, type TelegramUpdateExecutor } from './controller/telegramDispatch';
import type { IScheduleStore } from './db/scheduleStore';
import type { SessionCustom, TurnCustom } from './db/sessionCustom';
import type { ITelegramStore } from './db/telegramStore';
import type { WithTransaction } from './db/transaction';
import { createTelegramService, type TelegramService } from './runtime/telegram/telegramService';

/** What the Telegram loops need: the connection store, a way to read finished turns, and the service that builds bot clients. */
export interface TelegramControllerDeps {
  store: ITelegramStore;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getTurn'>;
  service?: TelegramService;
  executeUpdate?: TelegramUpdateExecutor;
}

/**
 * Controller whose loops (schedule runs, noticing, the expired private chat sweep) hand work to the server over HTTP
 * (`SERVER_URL` + `TRUEFORGE_API_KEY` from process config). Standalone uses
 * loopback; distributed uses the dedicated controller against the server Service.
 * With Telegram deps it also runs the channel's polling and reply loops.
 */
export function createController<TTransaction>(params: {
  scheduleStore: IScheduleStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  telegram?: TelegramControllerDeps;
}): Controller {
  const loops = [
    scheduleDispatchLoop({
      scheduleStore: params.scheduleStore,
      withTransaction: params.withTransaction,
      logger: params.logger,
    }),
    ...noticingLoops({ logger: params.logger }),
    privateChatSweepLoop({ logger: params.logger }),
  ];
  if (params.telegram !== undefined) {
    const service =
      params.telegram.service ??
      createTelegramService({ store: params.telegram.store, publicBaseUrl: getPublicBaseUrl(), logger: params.logger });
    loops.push(
      telegramPollLoop({
        store: params.telegram.store,
        service,
        ...(params.telegram.executeUpdate === undefined ? {} : { executeUpdate: params.telegram.executeUpdate }),
        logger: params.logger,
      }),
      telegramReplyLoop({
        store: params.telegram.store,
        service,
        sessionStore: params.telegram.sessionStore,
        logger: params.logger,
      }),
    );
  }
  return new Controller({ loops, logger: params.logger });
}

/**
 * Runs the controller: starts the loops and drains them on SIGTERM/SIGINT.
 */
export function runController<TTransaction>(params: {
  scheduleStore: IScheduleStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  telegram?: TelegramControllerDeps;
  gracefulTimeoutSeconds: number;
  /** Releases what the caller opened for the loops, e.g. its database pool. */
  onStopped?: () => Promise<void>;
}): Controller {
  const { logger, gracefulTimeoutSeconds, onStopped } = params;
  const controller = createController(params);
  controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, stopping control loops`);

    // Passes only hold short transactions, so the deadline should never elapse.
    setTimeout(() => {
      logger.warn(`Controller drain timed out after ${String(gracefulTimeoutSeconds)}s, exiting`);
      process.exit(1);
    }, gracefulTimeoutSeconds * 1000).unref();

    await controller.stop();
    await onStopped?.();
    process.exit(0);
  };
  process.on('SIGTERM', signal => {
    void shutdown(signal);
  });
  process.on('SIGINT', signal => {
    void shutdown(signal);
  });

  return controller;
}
