import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { BrowserSidecar, createHttpServer } from './server.mjs';

export const DEFAULT_PORT = 8792;
export const DEFAULT_PROFILES_DIR = '/profiles';
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/** The addresses a host name has now; the gateway's can change when its container is recreated. */
async function addressesOf(host) {
  return (await lookup(host, { all: true })).map(entry => entry.address);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const peer = process.env.BROWSER_API_PEER;
  let server;
  let sidecar;
  try {
    sidecar = new BrowserSidecar({
      profilesDir: process.env.BROWSER_PROFILES_DIR ?? DEFAULT_PROFILES_DIR,
      navTimeoutMs: Number(process.env.BROWSER_NAV_TIMEOUT_MS ?? DEFAULT_NAV_TIMEOUT_MS),
      proxyServer: process.env.BROWSER_PROXY,
    });
    server = createHttpServer({
      sidecar,
      allowedPeers: peer === undefined || peer === '' ? undefined : () => addressesOf(peer),
    });
  } catch (error) {
    process.stderr.write(
      `browser sidecar: ${error instanceof Error ? error.message : String(error)}, refusing to start\n`,
    );
    process.exit(1);
  }
  server.listen(Number(process.env.BROWSER_PORT ?? DEFAULT_PORT), '0.0.0.0');
  const shutdown = () => {
    server.close();
    sidecar.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
