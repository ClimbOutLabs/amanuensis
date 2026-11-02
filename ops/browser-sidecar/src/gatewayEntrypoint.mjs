// The browser gateway: the egress proxy the browser must use, and the relay the app server uses to
// reach the sidecar's API. See egressProxy.mjs.
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

import { createApiRelay, createEgressProxy } from './egressProxy.mjs';

export const DEFAULT_PROXY_PORT = 3128;
export const DEFAULT_RELAY_PORT = 8792;

/**
 * The one address of this container a name points to. Compose gives the gateway one name on the browser's
 * network and another on the server's, so the proxy listens only where the browser is and the relay only
 * where the server is.
 */
async function addressOf(name) {
  if (name === undefined || name === '') {
    throw new Error('the gateway needs BROWSER_PROXY_BIND and BROWSER_RELAY_BIND');
  }
  return (await lookup(name)).address;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sidecarHost = process.env.BROWSER_SIDECAR_HOST ?? 'browser';
  const sidecarPort = Number(process.env.BROWSER_SIDECAR_PORT ?? DEFAULT_RELAY_PORT);
  let proxy;
  let relay;
  let proxyAddress;
  let relayAddress;
  try {
    proxy = createEgressProxy({
      log: entry => process.stderr.write(`browser gateway: refused ${entry.refused} (${entry.reason})\n`),
    });
    relay = createApiRelay({ host: sidecarHost, port: sidecarPort, secret: process.env.BROWSER_SECRET });
    [proxyAddress, relayAddress] = await Promise.all([
      addressOf(process.env.BROWSER_PROXY_BIND),
      addressOf(process.env.BROWSER_RELAY_BIND),
    ]);
  } catch (error) {
    process.stderr.write(
      `browser gateway: ${error instanceof Error ? error.message : String(error)}, refusing to start\n`,
    );
    process.exit(1);
  }
  proxy.listen(Number(process.env.BROWSER_PROXY_PORT ?? DEFAULT_PROXY_PORT), proxyAddress);
  relay.listen(Number(process.env.BROWSER_RELAY_PORT ?? DEFAULT_RELAY_PORT), relayAddress);
  const shutdown = () => {
    proxy.close();
    relay.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
