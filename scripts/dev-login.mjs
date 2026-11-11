/**
 * Starts the Dex image the compose `login` profile pins as a local OIDC provider for development.
 *
 * Plain HTTP on loopback (an http issuer is only accepted for loopback hosts), one static client,
 * one static user, and sessions kept in a named Docker volume so restarts do not sign you out.
 * Prints the OIDC lines for `packages/trueforge/.env`, then runs Dex in the foreground.
 *
 * `--print` writes the config and prints the lines without starting Docker.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOGIN_CLIENT_SECRET_ENV,
  LOGIN_USER_EMAIL,
  LOGIN_USER_PASSWORD,
  loginEnvLines,
  loginServiceConfig,
  readLoginServiceImage,
} from './login-service-config.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(rootDir, '.dev-login');
const containerName = 'amanuensis-dev-login';
const volumeName = 'amanuensis-dev-login-data';
const port = 5556;
const issuer = `http://localhost:${String(port)}/dex`;
const clientId = 'amanuensis-dev';
const redirectOrigins = ['http://localhost:8790', 'http://localhost:3000'];

/** Random once, then stable, so the .env lines stay valid across restarts. */
async function readClientSecret() {
  const file = path.join(stateDir, 'client-secret');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const secret = randomBytes(24).toString('hex');
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return secret;
  }
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
const clientSecret = await readClientSecret();
const configFile = path.join(stateDir, 'dex.yaml');
await writeFile(
  configFile,
  loginServiceConfig({
    issuer,
    listen: `0.0.0.0:${String(port)}`,
    clientId,
    redirectOrigins,
    storage: { type: 'sqlite3', file: '/var/dex/dex.db' },
  }),
);

console.log(`Add these lines to packages/trueforge/.env (set PUBLIC_BASE_URL to the app origin you open,
http://localhost:8790 for pnpm standalone:start or http://localhost:3000 for pnpm standalone:dev):

${loginEnvLines({ issuer, clientId, clientSecret })}

Sign in with ${LOGIN_USER_EMAIL} / ${LOGIN_USER_PASSWORD}. Development only: Dex listens on 127.0.0.1:${String(port)}.
`);

if (process.argv.includes('--print')) {
  process.exit(0);
}

const image = await readLoginServiceImage(rootDir);
const docker = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--name',
    containerName,
    '-p',
    `127.0.0.1:${String(port)}:${String(port)}`,
    '-v',
    `${volumeName}:/var/dex`,
    '-v',
    `${configFile}:/etc/dex/config.yaml:ro`,
    // Name only: the value comes from the child environment, never argv.
    '-e',
    LOGIN_CLIENT_SECRET_ENV,
    image,
    'dex',
    'serve',
    '/etc/dex/config.yaml',
  ],
  { stdio: 'inherit', env: { ...process.env, [LOGIN_CLIENT_SECRET_ENV]: clientSecret } },
);
docker.on('error', error => {
  console.error('Could not run docker. Install Docker and make sure the daemon is running.', error.message);
  process.exit(1);
});
docker.on('exit', code => {
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => docker.kill(signal));
}
