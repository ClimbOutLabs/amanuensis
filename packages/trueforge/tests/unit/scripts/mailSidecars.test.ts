import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

const ServiceSchema = z
  .object({
    image: z.string().optional(),
    ports: z.array(z.unknown()).optional(),
    expose: z.array(z.string()).optional(),
    command: z.array(z.string()).optional(),
    environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    volumes: z.array(z.string()).optional(),
    env_file: z
      .array(z.union([z.string(), z.object({ path: z.string(), required: z.boolean().optional() })]))
      .optional(),
  })
  .passthrough();

const ComposeSchema = z.object({
  services: z.record(z.string(), ServiceSchema),
});

const compose = ComposeSchema.parse(parse(readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8')));

const MAIL_SIDECARS = ['mail-email'];

function serviceNamed(name: string) {
  const service = compose.services[name];
  if (service === undefined) {
    throw new Error(`docker-compose.yml has no ${name} service`);
  }
  return service;
}

describe('mail and calendar sidecars', () => {
  it.each(MAIL_SIDECARS)('%s is never published to the host', name => {
    expect(serviceNamed(name).ports).toBeUndefined();
  });

  it.each(MAIL_SIDECARS)('%s pins its image by digest', name => {
    expect(serviceNamed(name).image).toMatch(/^ghcr\.io\/[^@\s]+@sha256:[0-9a-f]{64}$/);
  });

  it('mail-email exposes its MCP port only to the Compose network', () => {
    const service = serviceNamed('mail-email');
    expect(service.expose).toEqual(['9557']);
    expect(service.command).toEqual(['streamable-http', '--host', '0.0.0.0', '--port', '9557']);
  });

  it('mail-email accepts requests only under its service name', () => {
    expect(serviceNamed('mail-email').environment?.['MCP_ALLOWED_HOSTS']).toBe('mail-email');
  });

  it('mail-email never reads the OS keyring and keeps its config and index on its own volume', () => {
    const service = serviceNamed('mail-email');
    expect(service.environment?.['MCP_EMAIL_SERVER_CREDENTIAL_STORAGE']).toBe('plaintext');
    expect(service.environment?.['MCP_EMAIL_SERVER_CONFIG_PATH']).toBe('/data/config.toml');
    expect(service.volumes).toEqual(['mail-email-data:/data']);
  });

  it('mail-email reads account secrets from an optional git-ignored file only', () => {
    expect(serviceNamed('mail-email').env_file).toEqual([{ path: './.env.mail-email', required: false }]);
  });
});
