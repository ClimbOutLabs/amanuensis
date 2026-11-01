/**
 * Minimal OIDC provider on loopback for smoke scripts: discovery plus an empty JWKS is enough for
 * the server to finish startup. It issues no tokens, so nobody can sign in through it.
 */
import { createServer } from 'node:http';

export const STANDIN_CLIENT_ID = 'smoke-client';
export const STANDIN_CLIENT_SECRET = 'smoke-secret';
// A standalone server starts only with its one owner named; nobody can sign in through the stand-in anyway.
export const STANDIN_OWNER_EMAIL = 'smoke-owner@example.invalid';

/** Env lines a child server needs to treat the stand-in as its login provider. */
export function standinOidcEnv(issuer) {
  return {
    OIDC_ISSUER_URL: issuer,
    OIDC_CLIENT_ID: STANDIN_CLIENT_ID,
    OIDC_CLIENT_SECRET: STANDIN_CLIENT_SECRET,
    OIDC_ALLOWED_EMAILS: STANDIN_OWNER_EMAIL,
  };
}

export async function startStandinOidc() {
  const server = createServer((req, res) => {
    const address = server.address();
    const issuer = `http://127.0.0.1:${String(address.port)}/dex`;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/dex/.well-known/openid-configuration') {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
          subject_types_supported: ['public'],
        }),
      );
    } else if (req.url === '/dex/keys') {
      res.end(JSON.stringify({ keys: [] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    issuer: `http://127.0.0.1:${String(server.address().port)}/dex`,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}
