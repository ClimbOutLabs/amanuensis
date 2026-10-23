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
    expect(service.expose).toEqual(['9557', '9559']);
    expect(service.command).toEqual(['streamable-http', '--host', '0.0.0.0', '--port', '9557']);
  });

  it('mail-email runs the account agent on the private network, holding the one account file', () => {
    const service = serviceNamed('mail-email');
    expect(service.environment?.['AMAN_MAIL_ACCOUNT_PORT']).toBe('9559');
    expect(service.volumes).toContain('./.env.mail-email:/account/.env.mail-email');
    expect(service.volumes).toContain(
      './ops/compose/mail-email/account_agent.py:/usr/local/bin/aman-mail-account-agent:ro',
    );
    expect(service.volumes).toContain(
      './ops/compose/mail-email/email_check.py:/usr/local/bin/aman-mail-email-check:ro',
    );
    // The account agent's port is exposed to the Compose network only, never published.
    expect(service.ports).toBeUndefined();
  });

  it('the server is pointed at the account agent, never at the Docker socket', () => {
    const service = serviceNamed('server');
    expect(service.environment?.['MAIL_EMAIL_ACCOUNT_URL']).toBe('http://mail-email:9559');
    expect(service.volumes?.some(volume => volume.includes('docker.sock'))).toBe(false);
  });

  it('mail-email accepts requests only under its service name', () => {
    expect(serviceNamed('mail-email').environment?.['MCP_ALLOWED_HOSTS']).toBe('mail-email');
  });

  it('mail-email never reads the OS keyring and keeps its index on its own volume', () => {
    const service = serviceNamed('mail-email');
    expect(service.environment?.['MCP_EMAIL_SERVER_CREDENTIAL_STORAGE']).toBe('plaintext');
    expect(service.volumes).toContain('mail-email-data:/data');
  });

  it('mail-email reads its send list read-only and never writes it', () => {
    const service = serviceNamed('mail-email');
    expect(service.environment?.['MCP_EMAIL_SERVER_CONFIG_PATH']).toBe('/policy/allowed_recipients.toml');
    expect(service.volumes).toContain('mail-policy:/policy:ro');
    expect(service.volumes?.some(volume => volume.startsWith('mail-policy:') && !volume.endsWith(':ro'))).toBe(false);
  });

  it('mail-email starts through the wrapper that restarts it on a new send list', () => {
    const service = serviceNamed('mail-email');
    expect(service['entrypoint']).toEqual(['/bin/sh', '/usr/local/bin/aman-mail-entrypoint']);
    expect(service.volumes).toContain('./ops/compose/mail-email/entrypoint.sh:/usr/local/bin/aman-mail-entrypoint:ro');
    expect(service.environment?.['AMAN_MAIL_STATUS_FILE']).toBe('/mail-status/loaded.sha256');
  });

  it('mail-email reads attachment content for the agent as data', () => {
    expect(serviceNamed('mail-email').environment?.['MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_CONTENT']).toBe('true');
  });

  it('the server writes the send list and reads the sidecar status, and nothing else holds the list', () => {
    const service = serviceNamed('server');
    expect(service.volumes).toContain('mail-policy:/data/mail-policy');
    expect(service.volumes).toContain('mail-policy-status:/data/mail-policy-status:ro');
    expect(service.environment?.['MAIL_POLICY_FILE']).toBe('/data/mail-policy/allowed_recipients.toml');
  });

  it('mail-email reads account secrets from an optional git-ignored file only', () => {
    expect(serviceNamed('mail-email').env_file).toEqual([{ path: './.env.mail-email', required: false }]);
  });
});
