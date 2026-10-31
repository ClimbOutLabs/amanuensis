// Runs `docker compose` for the smoke stack with a random calendar secret, so the checked-in compose file needs no
// fixed default. A value already in the environment is kept, so a stack started by hand can be stopped the same way.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** The environment for a compose call: the caller's own, plus a random secret when none is set. */
export function smokeComposeEnv({ env, secret = () => randomBytes(32).toString('hex') }) {
  const existing = env.CALENDAR_ACCOUNT_SECRET;
  if (typeof existing === 'string' && existing.trim() !== '') {
    return env;
  }
  return { ...env, CALENDAR_ACCOUNT_SECRET: secret() };
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
