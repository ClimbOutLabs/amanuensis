// The browser gateway: the egress proxy the browser must use, and the relay the app server uses to
// reach the sidecar's API. See egressProxy.mjs.
import { fileURLToPath } from 'node:url';

import { createApiRelay, createEgressProxy } from './egressProxy.mjs';

export const DEFAULT_PROXY_PORT = 3128;
export const DEFAULT_RELAY_PORT = 8792;

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sidecarHost = process.env.BROWSER_SIDECAR_HOST ?? 'browser';
  const sidecarPort = Number(process.env.BROWSER_SIDECAR_PORT ?? DEFAULT_RELAY_PORT);
  const proxy = createEgressProxy({
    log: entry => process.stderr.write(`browser gateway: refused ${entry.refused} (${entry.reason})\n`),
  });
  const relay = createApiRelay({ host: sidecarHost, port: sidecarPort });
  proxy.listen(Number(process.env.BROWSER_PROXY_PORT ?? DEFAULT_PROXY_PORT), '0.0.0.0');
  relay.listen(Number(process.env.BROWSER_RELAY_PORT ?? DEFAULT_RELAY_PORT), '0.0.0.0');
  const shutdown = () => {
    proxy.close();
    relay.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
