// Runs `docker compose` for the smoke stack with random calendar and browser secrets, so the checked-in compose file
// needs no fixed default. A value already in the environment is kept, so a stack started by hand can be stopped the
// same way.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** The shared secrets the compose file requires and has no default for. */
export const SMOKE_SECRETS = ['CALENDAR_ACCOUNT_SECRET', 'BROWSER_SECRET'];

/** The environment for a compose call: the caller's own, plus a random value for each secret that is not set. */
export function smokeComposeEnv({ env, secret = () => randomBytes(32).toString('hex') }) {
  const filled = { ...env };
  for (const name of SMOKE_SECRETS) {
    const existing = env[name];
    if (typeof existing !== 'string' || existing.trim() === '') {
      filled[name] = secret();
    }
  }
  return filled;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn('docker', ['compose', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: smokeComposeEnv({ env: process.env }),
  });
  child.on('error', () => {
    process.stderr.write('Docker could not be started. Install Docker, then try again.\n');
    process.exit(1);
  });
  child.on('exit', code => process.exit(code ?? 1));
}
