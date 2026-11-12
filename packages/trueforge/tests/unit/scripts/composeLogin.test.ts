import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

import { assertOidcIssuerTransportAllowed, assertOwnSignInIssuer } from '../../../src/config';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const ComposeSchema = z.object({
  services: z.record(
    z.string(),
    z.object({ ports: z.array(z.string()).optional(), volumes: z.array(z.string()).optional() }).passthrough(),
  ),
  volumes: z.record(z.string(), z.unknown()).optional(),
});

// The Dex config is a gomplate template, so only its plain keys are read here.
const DexConfigSchema = z.object({
  issuer: z.string(),
  web: z.object({ http: z.string() }).strict(),
});

const compose = ComposeSchema.parse(parse(read('docker-compose.yml')));
const dexConfig = DexConfigSchema.parse(
  parse(
    read('ops/compose/dex/config.yaml')
      .split('\n')
      .filter(line => !line.includes('{{'))
      .join('\n'),
  ),
);

describe('the Compose login profile', () => {
  it('serves sign-in over plain http on this computer, so no browser has a certificate to warn about', () => {
    expect(dexConfig.issuer).toBe('http://localhost:5556/dex');
    expect(() => assertOidcIssuerTransportAllowed(dexConfig.issuer)).not.toThrow();
    expect(() => assertOwnSignInIssuer(dexConfig.issuer)).not.toThrow();
    expect(dexConfig.web).toEqual({ http: '0.0.0.0:5556' });
  });

  it('publishes the sign-in port on the loopback address only', () => {
    const published = (compose.services['loopback']?.ports ?? []).filter(port => port.endsWith(':5556'));
    expect(published).toEqual(['127.0.0.1:5556:5556']);
  });

  it('makes no certificate of its own', () => {
    const file = read('docker-compose.yml');
    expect(compose.services['dex-tls']).toBeUndefined();
    expect(Object.keys(compose.volumes ?? {})).not.toContain('dex-tls');
    expect(file).not.toContain('openssl req');
    expect(file).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('matches the issuer the env example tells people to set', () => {
    const example = read('packages/trueforge/.env.example');
    const issuers = [...example.matchAll(/^# OIDC_ISSUER_URL=(.+)$/gm)].map(match => match[1]);
    expect(issuers).toContain(dexConfig.issuer);
    expect(example).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('never tells people to click past a certificate warning', () => {
    const quickstart = read('docs/quickstart.mdx');
    expect(quickstart).not.toMatch(/choose \*\*Advanced\*\*/);
    expect(quickstart).not.toContain('https://localhost:5556');
  });
});
