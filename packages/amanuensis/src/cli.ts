/**
 * CLI entry for `amanuensis` (`package.json` `bin` → `dist/cli.js`).
 *
 * The server bundle is built next to this file as `dist/main.js`. Flags and
 * defaults must be applied before that import because the server reads
 * `process.env` at module load.
 *
 * Reading `process.env` directly is the documented bootstrap exception: this
 * runs before the server config module exists.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PACKAGE_VERSION } from './packageVersion';

const DEFAULT_PORT = 8790;
const DEFAULT_HOST = 'localhost';
/** Home-relative so a user who never sets an env var can find, back up, or delete their data. */
const DEFAULT_DATA_DIR = path.join(homedir(), '.amanuensis');

function printUsage(): void {
  console.log(`Usage:
  npx amanuensis
  npx amanuensis --port <n>

Amanuensis v${PACKAGE_VERSION}. Start the agent server and chat UI.
Runs in standalone mode (SQLite, no Redis), local use only, not production-safe.
Login is required: set OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (an http issuer
is accepted only on localhost). From a repository checkout, "pnpm dev:login" starts a local
Dex and prints them. Optional: PUBLIC_BASE_URL (origin, no path), AUTH_COOKIE_SUFFIX.
Set STANDALONE=false with Postgres and Redis for multi-replica peering.

Options:
  --port <n>   HTTP port (default: ${String(DEFAULT_PORT)}, or PORT env)
  -h, --help   Show this help

Data:
  ${path.join(DEFAULT_DATA_DIR, 'db', 'db.sqlite')} (override with SQLITE_PATH)
`);
}

function applyPort(raw: string | undefined): void {
  if (raw === undefined) {
    return;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${raw}" (expected integer 1 to 65535)`);
  }
  process.env['PORT'] = String(port);
}

/** Only fills gaps: anything the user already exported wins. */
function applyDefaults(): void {
  process.env['STANDALONE'] ??= 'true';
  process.env['SQLITE_PATH'] ??= path.join(DEFAULT_DATA_DIR, 'db', 'db.sqlite');
}

function listeningUrl(): string {
  const host = process.env['HOST'] ?? DEFAULT_HOST;
  const port = process.env['PORT'] ?? String(DEFAULT_PORT);
  return `http://${host}:${port}`;
}

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printUsage();
  } else {
    applyPort(values.port);
    applyDefaults();
    // Not a static specifier: `main.js` is vendored into dist/ at build time and has no src/ twin.
    await import(new URL('./main.js', import.meta.url).href);
    console.log(`Amanuensis is listening on ${listeningUrl()}`);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
