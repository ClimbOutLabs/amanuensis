import { fileURLToPath } from 'node:url';
import { BrowserSidecar, createHttpServer } from './server.mjs';

export const DEFAULT_PORT = 8792;
export const DEFAULT_PROFILES_DIR = '/profiles';
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const secret = process.env.BROWSER_SECRET;
  if (secret === undefined || secret === '') {
    process.stderr.write('browser sidecar: BROWSER_SECRET is not set, refusing to start\n');
    process.exit(1);
  }
  const sidecar = new BrowserSidecar({
    profilesDir: process.env.BROWSER_PROFILES_DIR ?? DEFAULT_PROFILES_DIR,
    navTimeoutMs: Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? DEFAULT_NAV_TIMEOUT_MS),
    // The gate's own log line only: never the page's content, never a login.
    log: message => process.stdout.write(`${message}\n`),
  });
  const server = createHttpServer({ sidecar, secret });
  server.listen(Number(process.env.BROWSER_PORT ?? DEFAULT_PORT), '0.0.0.0');
  const shutdown = () => {
    server.close();
    sidecar.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
