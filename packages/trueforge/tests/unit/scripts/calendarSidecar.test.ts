import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

const ServiceSchema = z
  .object({
    build: z.object({ context: z.string() }).optional(),
    ports: z.array(z.unknown()).optional(),
    expose: z.array(z.string()).optional(),
    restart: z.string().optional(),
    environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_file: z
      .array(z.union([z.string(), z.object({ path: z.string(), required: z.boolean().optional() })]))
      .optional(),
  })
  .passthrough();

const ComposeSchema = z.object({
  services: z.record(z.string(), ServiceSchema),
});

const compose = ComposeSchema.parse(parse(readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8')));

const CALENDAR_TOOLS = [
  'list_calendars',
  'list_events',
  'get_event',
  'search_events',
  'create_event',
  'update_event',
  'delete_event',
  'respond_to_event',
];

function calendarService() {
  const service = compose.services['calendar-caldav'];
  if (service === undefined) {
    throw new Error('docker-compose.yml has no calendar-caldav service');
  }
  return service;
}

describe('calendar-caldav sidecar', () => {
  it('builds from the ops/calendar-sidecar directory', () => {
    expect(calendarService().build).toEqual({ context: './ops/calendar-sidecar' });
  });

  it('is never published to the host', () => {
    expect(calendarService().ports).toBeUndefined();
  });

  it('exposes its MCP port only to the Compose network', () => {
    expect(calendarService().expose).toEqual(['9558']);
  });

  it('reads credentials only from an optional git-ignored file', () => {
    expect(calendarService().env_file).toEqual([{ path: './.env.calendar', required: false }]);
  });

  it('offers exactly the eight calendar tools, comma separated with no spaces', () => {
    const raw = calendarService().environment?.['CALDAV_ALLOW_TOOLS'];
    expect(typeof raw).toBe('string');
    expect(String(raw).split(',').sort()).toEqual([...CALENDAR_TOOLS].sort());
    expect(String(raw)).not.toMatch(/\s/);
  });

  it('turns off interactive approvals so writes use confirm tokens', () => {
    expect(calendarService().environment?.['ELICITATION']).toBe('false');
  });

  it('keeps no credential keys in the service environment', () => {
    const keys = Object.keys(calendarService().environment ?? {});
    expect(keys.filter(key => /PASSWORD|TOKEN|USERNAME/i.test(key))).toEqual([]);
  });

  it('restarts unless stopped', () => {
    expect(calendarService().restart).toBe('unless-stopped');
  });
});
