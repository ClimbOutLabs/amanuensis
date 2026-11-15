// Records every host the server process looks up or connects to, one JSON line per new host, in
// the file named by AMAN_OUTBOUND_HOSTS_LOG. Load it before the app starts:
//
//   AMAN_OUTBOUND_HOSTS_LOG=outbound.jsonl node --import ./scripts/record-outbound-hosts.mjs dist/main.js
//
// The nightly end-to-end run hands that file to `pnpm run test:external-hosts --runtime`.
// Name lookups catch every connection by name, whichever HTTP client makes it; the net and tls
// hooks catch connections made straight to an address.

import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const logFile = process.env.AMAN_OUTBOUND_HOSTS_LOG;
const recorded = new Set();

function record(host, via) {
  if (typeof host !== 'string' || host === '' || recorded.has(host)) {
    return;
  }
  recorded.add(host);
  appendFileSync(logFile, `${JSON.stringify({ host: host.toLowerCase(), via })}\n`);
}

function hostOf(args) {
  const [first, second] = args;
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return first.path === undefined ? (first.servername ?? first.host) : undefined;
  }
  // connect(port, host) dials host; connect(port) dials localhost; connect(path) is a local socket.
  const isPort = typeof first === 'number' || /^\d+$/.test(String(first));
  return isPort && typeof second === 'string' ? second : undefined;
}

function wrap(owner, name, via, pick) {
  const original = owner[name];
  owner[name] = function recordingWrapper(...args) {
    record(pick(args), via);
    return Reflect.apply(original, this, args);
  };
}

if (logFile !== undefined && logFile !== '') {
  wrap(dns, 'lookup', 'dns', args => args[0]);
  wrap(dns.promises, 'lookup', 'dns', args => args[0]);
  wrap(net, 'connect', 'net', hostOf);
  wrap(net, 'createConnection', 'net', hostOf);
  wrap(tls, 'connect', 'tls', hostOf);
  syncBuiltinESMExports();
}
