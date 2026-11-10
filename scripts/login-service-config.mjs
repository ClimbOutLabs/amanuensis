// The settings for a local Dex sign-in service with one fixed person, shared by `pnpm dev:login` and
// the signed-in journey test. Loopback only: the password is public.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const LOGIN_USER_EMAIL = 'dev@example.com';
export const LOGIN_USER_PASSWORD = 'dev-password';
/** bcrypt of the fixed password. */
const LOGIN_USER_PASSWORD_HASH = '$2b$10$JqZyP4lvrnOYrTxXa9ODRuRDG52HwRE3sFxClWiC7j26mvtimjolq';
/** The environment variable Dex reads the client secret from, so the secret is never in the file or argv. */
export const LOGIN_CLIENT_SECRET_ENV = 'DEV_CLIENT_SECRET';

/**
 * The Dex config file. `storage` is `{ type: 'memory' }` or `{ type: 'sqlite3', file }`; `webDir`
 * names Dex's own page templates when it runs outside its image.
 */
export function loginServiceConfig({ issuer, listen, clientId, redirectOrigins, storage, webDir }) {
  const storageLines =
    storage.type === 'sqlite3' ? `  type: sqlite3\n  config:\n    file: ${storage.file}` : '  type: memory';
  const frontend = webDir === undefined ? '' : `frontend:\n  dir: ${webDir}\n`;
  return `issuer: ${issuer}
storage:
${storageLines}
web:
  http: ${listen}
${frontend}oauth2:
  responseTypes: ['code']
  skipApprovalScreen: true
enablePasswordDB: true
staticPasswords:
  - email: ${LOGIN_USER_EMAIL}
    hash: '${LOGIN_USER_PASSWORD_HASH}'
    username: dev
    userID: dev-user
staticClients:
  - id: ${clientId}
    name: Amanuensis development
    secretEnv: ${LOGIN_CLIENT_SECRET_ENV}
    redirectURIs:
${redirectOrigins.map(origin => `      - ${origin}/api/v1/auth/callback`).join('\n')}
`;
}

/** The OIDC settings a server needs to sign people in through that service, as name and value pairs. */
export function loginEnv({ issuer, clientId, clientSecret }) {
  return {
    OIDC_ISSUER_URL: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_USER_REFERENCE_CLAIM: 'email',
    OIDC_USER_ROLE_CLAIM: 'email',
    OIDC_ADMIN_ROLE_VALUE: LOGIN_USER_EMAIL,
    OIDC_ALLOWED_EMAILS: LOGIN_USER_EMAIL,
  };
}

/** The same settings as lines for an env file. */
export function loginEnvLines(input) {
  return Object.entries(loginEnv(input))
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

/** The Dex image the compose file pins, so the tag has one owner. */
export async function readLoginServiceImage(rootDir) {
  const compose = await readFile(path.join(rootDir, 'docker-compose.yml'), 'utf8');
  const match = /image:\s*(ghcr\.io\/dexidp\/dex:\S+)/.exec(compose);
  if (match?.[1] === undefined) {
    throw new Error('docker-compose.yml does not pin a Dex image. Restore its dex service from git.');
  }
  return match[1];
}
