import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { escapeHtml } from './localLoginPage';

/** A host as a browser writes it: a name or IPv4 address and an optional port. Anything else is never echoed back. */
const PLAIN_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

/**
 * What to type on the computer for a host this instance was not set up for. A host on one of the instance's own ports
 * is a name of this computer, so the name alone is added; any other host came through another program (Tailscale serve,
 * a web server) and is added as its full address. The scheme a browser used is not visible here, so https is assumed;
 * the page's script corrects it from the address bar.
 */
export function addressAddCommand({
  hostHeader,
  ownPorts,
}: {
  hostHeader: string;
  ownPorts: ReadonlySet<string>;
}): string {
  const host = hostHeader.toLowerCase();
  if (!PLAIN_HOST.test(host)) {
    return 'aman address add <the address you opened>';
  }
  const port = /:(\d+)$/.exec(host)?.[1];
  if (port !== undefined && ownPorts.has(port)) {
    return `aman address add ${host.slice(0, -(port.length + 1))}`;
  }
  return `aman address add https://${host}`;
}

// Puts the exact address from the address bar into the command, and copies it. The own ports come from the page itself.
const PAGE_SCRIPT = `(() => {
  const code = document.getElementById('command');
  const button = document.getElementById('copy');
  if (code === null || button === null) return;
  const own = (code.dataset.ownPorts || '').split(',');
  code.textContent = own.includes(location.port) ? 'aman address add ' + location.hostname : 'aman address add ' + location.origin;
  button.hidden = false;
  button.addEventListener('click', () => {
    const done = () => { button.textContent = 'Copied'; };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code.textContent).then(done, () => window.getSelection().selectAllChildren(code));
    } else {
      window.getSelection().selectAllChildren(code);
    }
  });
})();`;

const SCRIPT_HASH = createHash('sha256').update(PAGE_SCRIPT).digest('base64');

/** Headers for the page: only its own script runs, it is never framed or cached. */
export const ADDRESS_NOT_LISTED_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; frame-ancestors 'none'`,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const PAGE_STYLE = `
  body { margin: 0; font-family: system-ui, sans-serif; background: #f6f4ef; color: #1c1a17; }
  main { max-width: 32rem; margin: 12vh auto 0; padding: 0 1rem; }
  .card { background: #ffffff; border: 0.0625rem solid #ddd6c9; border-radius: 0.75rem; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; line-height: 1.45; }
  code { display: block; font-size: 0.875rem; padding: 0.75rem; background: #f0ece4; border-radius: 0.375rem; overflow-wrap: anywhere; }
  button { margin-top: 0.75rem; font-size: 0.875rem; padding: 0.5rem 1rem; border: 0; border-radius: 0.375rem; background: #1c1a17; color: #ffffff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1a17; color: #f6f4ef; }
    .card { background: #2a2723; border-color: #3d3832; }
    code { background: #1c1a17; }
    button { background: #f6f4ef; color: #1c1a17; }
  }
`;

/** The page a browser gets at an address this instance was not set up for: the address it used and the command to allow it. */
export function addressNotListedPage({
  hostHeader,
  ownPorts,
}: {
  hostHeader: string;
  ownPorts: ReadonlySet<string>;
}): string {
  const host = hostHeader.toLowerCase();
  const shown = PLAIN_HOST.test(host) ? host : 'this address';
  const command = addressAddCommand({ hostHeader, ownPorts });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aman is not set up for this address</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<div class="card">
<h1>Aman is not set up for this address</h1>
<p>You opened Aman at <strong>${escapeHtml(shown)}</strong>, which is not one of its addresses. Aman refuses addresses it does not know, so sign-in cannot be sent anywhere else.</p>
<p>To allow it, run this on the computer that runs Aman, then open this page again:</p>
<code id="command" data-own-ports="${escapeHtml([...ownPorts].join(','))}">${escapeHtml(command)}</code>
<button id="copy" type="button" hidden>Copy</button>
<p>If this computer's address changed, run this there instead: aman doctor network --fix</p>
</div>
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/** The ports an instance answers at: the ones its public address and listed addresses name, with their defaults filled in. */
export function ownPortsOf({
  publicBaseUrl,
  allowedOrigins,
}: {
  publicBaseUrl: string;
  allowedOrigins: readonly string[];
}): Set<string> {
  const ports = new Set<string>();
  for (const origin of [publicBaseUrl, ...allowedOrigins]) {
    const port = new URL(origin).port;
    if (port !== '') {
      ports.add(port);
    }
  }
  return ports;
}

const REFUSED_KEEP = 10;
const REFUSED_WRITE_GAP_MS = 60_000;

/**
 * Keeps the last few hosts a browser opened this instance at that were refused, one "epoch-seconds host" line each, so
 * `aman doctor` can say which name to add. A host already written in the last minute is not written again, so a page
 * that keeps retrying cannot fill the disk.
 */
export function createRefusedAddressLog(filePath: string): (hostHeader: string) => Promise<void> {
  const lastWritten = new Map<string, number>();
  let writing = Promise.resolve();
  return hostHeader => {
    const host = hostHeader.toLowerCase();
    if (!PLAIN_HOST.test(host)) {
      return writing;
    }
    const now = Date.now();
    const previous = lastWritten.get(host);
    if (previous !== undefined && now - previous < REFUSED_WRITE_GAP_MS) {
      return writing;
    }
    lastWritten.set(host, now);
    if (lastWritten.size > REFUSED_KEEP * 10) {
      lastWritten.clear();
    }
    // A failed write only costs the doctor its list; the refusal itself never waits on it.
    writing = writing
      .then(() => recordRefused({ filePath, host, at: String(Math.floor(now / 1000)) }))
      .catch(() => undefined);
    return writing;
  };
}

async function recordRefused({ filePath, host, at }: { filePath: string; host: string; at: string }): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(filePath, 'utf8')).split('\n').filter(line => line !== '');
  } catch {
    // No file yet: this is the first refused address.
  }
  const kept = lines.filter(line => line.split(' ')[1] !== host).slice(-(REFUSED_KEEP - 1));
  kept.push(`${at} ${host}`);
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${kept.join('\n')}\n`, 'utf8');
  await rename(temporary, filePath);
}
