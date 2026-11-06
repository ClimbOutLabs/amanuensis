import { createLogger, transports, type Logger } from 'winston';

/** A logger that writes nowhere. */
export function winstonSilent(): Logger {
  return createLogger({ silent: true, transports: [new transports.Console()] });
}
