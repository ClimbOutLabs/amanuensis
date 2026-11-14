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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  npx amanuensis --reset-password

Amanuensis v${PACKAGE_VERSION}. Start the agent server and chat UI.
Runs in standalone mode (SQLite, no Redis), local use only, not production-safe.
Sign-in is a local email and password that Aman keeps itself: the first time you open
Aman it asks you to create it, and there is only ever one. Setting the OIDC variables
(OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ALLOWED_EMAILS with exactly
one email address) uses your own sign-in service instead. Optional: PUBLIC_BASE_URL
(origin, no path), AUTH_COOKIE_SUFFIX.
Set STANDALONE=false with Postgres and Redis for multi-replica peering.

Options:
  --port <n>         HTTP port (default: ${String(DEFAULT_PORT)}, or PORT env)
  --reset-password   Set a new password for the local sign-in (Aman must be stopped).
                     If you start Aman with --port, pass the same --port here too
  -h, --help         Show this help

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
  process.env['SECRETS_KEY_FILE'] ??= path.join(DEFAULT_DATA_DIR, 'secrets', 'master.key');
  // The npx install signs in locally unless the person set up their own sign-in
  // service (OIDC variables present) or named a mode themselves.
  if (
    process.env['STANDALONE'] === 'true' &&
    process.env['OIDC_ISSUER_URL'] === undefined &&
    process.env['TRUEFORGE_AUTH_MODE'] === undefined
  ) {
    process.env['TRUEFORGE_AUTH_MODE'] = 'local';
  }
}

/**
 * Aman never makes its own key at start, so the first run makes it here and shows the recovery key once.
 * When setup fails Aman still starts, and its locked page says what to do.
 */
function setUpSavedLoginsOnFirstRun(): void {
  const keyFile = process.env['SECRETS_KEY_FILE'];
  const sqlitePath = process.env['SQLITE_PATH'];
  const standalone = process.env['STANDALONE'] === 'true';
  // Skips the extra start-up work once a standalone install has both its key and its database.
  if (
    standalone &&
    keyFile !== undefined &&
    sqlitePath !== undefined &&
    existsSync(keyFile) &&
    existsSync(sqlitePath)
  ) {
    return;
  }
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./aman.js', import.meta.url)), 'secrets', 'first-run'], {
      stdio: 'inherit',
    });
  } catch {
    // The command already printed why.
    console.error('Aman could not set up the key that protects your saved logins.');
  }
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
      'reset-password': { type: 'boolean', default: false },
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
    if (values['reset-password']) {
      // The server's own command dispatcher does the work under its command name;
      // it exits the process itself, so nothing after this import runs.
      process.argv = [process.argv[0] ?? 'node', 'amanuensis', 'reset-password'];
      await import(new URL('./aman.js', import.meta.url).href);
    } else {
      setUpSavedLoginsOnFirstRun();
      // Not a static specifier: `main.js` is vendored into dist/ at build time and has no src/ twin.
      await import(new URL('./main.js', import.meta.url).href);
      console.log(`Amanuensis is listening on ${listeningUrl()}`);
    }
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
