import { createServer, type Server } from 'node:http';

import type { KeyProvider } from './keyProvider';

/** Why Aman cannot open yet. */
export type StartupLock =
  | { reason: 'no_key'; detail: string }
  | { reason: 'not_set_up'; detail: string }
  | { reason: 'wrong_key'; detail: string };

export type KeyCheckResult = 'match' | 'not_set_up' | 'wrong_key';

const HEADLINES: Readonly<Record<StartupLock['reason'], string>> = {
  no_key: "Aman is waiting for this computer's key",
  not_set_up: 'Aman is not set up to keep your data encrypted yet',
  wrong_key: "This computer's key does not match Aman's data",
};

const NEXT_STEPS: Readonly<Record<StartupLock['reason'], string>> = {
  no_key:
    'This usually takes a few seconds after the computer starts. If this page stays, run "aman doctor" on the computer Aman runs on.',
  not_set_up: 'On the computer Aman runs on, run "aman doctor". It says how to finish setting up.',
  wrong_key:
    'This happens after Aman\'s data moved to another computer. On the computer Aman runs on, run "aman unlock" and type your recovery key.',
};

/** What a person sees while Aman is locked: what is wrong, and the one thing to do next. */
export function lockedMessage(lock: StartupLock): { headline: string; next: string } {
  return { headline: HEADLINES[lock.reason], next: NEXT_STEPS[lock.reason] };
}

function lockedPage(lock: StartupLock): string {
  const { headline, next } = lockedMessage(lock);
  // Fixed text only, so nothing here needs escaping. The page reloads until Aman opens.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Aman is locked</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#1f2328;background:#fafaf7}
h1{font-size:1.4rem}
p{font-size:1rem}
@media (prefers-color-scheme: dark){body{color:#e6e6e1;background:#17181a}}
</style>
</head>
<body>
<h1>${headline}</h1>
<p>${next}</p>
<p>Your chats and saved logins stay encrypted until then. This page opens Aman by itself once it is unlocked.</p>
</body>
</html>
`;
}

/**
 * The only thing Aman serves while it is locked: a health answer, a plain page and a plain API
 * error. No data is read and nothing is accepted.
 */
export function createLockedServer(currentLock: () => StartupLock): Server {
  return createServer((request, response) => {
    const lock = currentLock();
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/healthz') {
      // Not healthy: anything waiting for Aman to be ready must keep waiting.
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      response.end(JSON.stringify({ status: 'locked', reason: lock.reason }));
      return;
    }
    const { headline, next } = lockedMessage(lock);
    if (path.startsWith('/api/')) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      response.end(JSON.stringify({ error: { message: `${headline}. ${next}`, code: 'locked', reason: lock.reason } }));
      return;
    }
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
    response.end(lockedPage(lock));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Holds startup until the host has delivered the key this instance's data was set up with, and
 * returns that key. Aman never makes a key here. While waiting it serves only the locked page.
 * It checks often for the first ten minutes, then every 30 seconds, so a key that arrives after
 * the containers started opens Aman with no restart.
 */
export async function waitForMachineKey({
  provider,
  checkKey,
  listen,
  onLockChange,
  fastMs = 2_000,
  fastForMs = 10 * 60_000,
  slowMs = 30_000,
  now = Date.now,
}: {
  provider: KeyProvider;
  /** Whether `key` is the key this instance's data was set up with. */
  checkKey: (key: Buffer) => Promise<KeyCheckResult>;
  /** Starts the locked server; called only when the first check finds Aman locked. */
  listen: (server: Server) => Promise<void>;
  onLockChange: (lock: StartupLock) => void;
  fastMs?: number;
  fastForMs?: number;
  slowMs?: number;
  now?: () => number;
}): Promise<Buffer> {
  const startedAt = now();
  let lock: StartupLock = { reason: 'no_key', detail: 'Not checked yet' };
  let server: Server | undefined;
  let reported = '';

  for (;;) {
    const loaded = await provider.load();
    if (loaded.status === 'loaded') {
      const match = await checkKey(loaded.key);
      if (match === 'match') {
        if (server !== undefined) {
          await closeServer(server);
        }
        return loaded.key;
      }
      lock =
        match === 'not_set_up'
          ? { reason: 'not_set_up', detail: 'This instance has no key check value' }
          : { reason: 'wrong_key', detail: 'The key does not match this instance' };
    } else {
      lock = { reason: 'no_key', detail: loaded.reason };
    }
    const current = `${lock.reason}:${lock.detail}`;
    if (current !== reported) {
      reported = current;
      onLockChange(lock);
    }
    if (server === undefined) {
      server = createLockedServer(() => lock);
      await listen(server);
    }
    await delay(now() - startedAt < fastForMs ? fastMs : slowMs);
  }
}
