import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

const ServiceSchema = z
  .object({
    build: z.object({ context: z.string() }).optional(),
    ports: z.array(z.unknown()).optional(),
    expose: z.array(z.string()).optional(),
    volumes: z.array(z.string()).optional(),
    restart: z.string().optional(),
    environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_file: z
      .array(z.union([z.string(), z.object({ path: z.string(), required: z.boolean().optional() })]))
      .optional(),
  })
  .passthrough();

const ComposeSchema = z.object({
  services: z.record(z.string(), ServiceSchema),
  volumes: z.record(z.string(), z.unknown()).optional(),
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

  it('exposes its tool port and its account agent port only to the Compose network', () => {
    expect(calendarService().expose).toEqual(['9558', '9560']);
  });

  it('reads no credentials from a file on the host: the login lives in a volume the sidecar owns', () => {
    expect(calendarService().env_file).toBeUndefined();
    expect(calendarService().volumes).toEqual(['calendar-account:/account']);
    expect(compose.volumes).toHaveProperty('calendar-account');
    expect(calendarService().environment?.['CALENDAR_ACCOUNT_FILE']).toBe('/account/.env.calendar');
    expect(calendarService().environment?.['CALENDAR_ACCOUNT_PORT']).toBe('9560');
  });

  it('tells the server where the account agent is', () => {
    expect(compose.services['server']?.environment?.['CALENDAR_ACCOUNT_URL']).toBe('http://calendar-caldav:9560');
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

describe('the installer and the calendar account agent', () => {
  const AGENT = resolve(REPO_ROOT, 'ops/calendar-sidecar/agent.mjs');
  const CANARY = 'CANARY-APP-PASSWORD-7f3d9';
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'calendar-installer-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The text the installer pipes to the agent for an account, from the installer's own function. */
  function installerText(url: string): string {
    const done = spawnSync(
      'bash',
      [
        '-c',
        `. '${REPO_ROOT}/installer/lib/common.sh'; . '${REPO_ROOT}/installer/lib/shared.sh'; . '${REPO_ROOT}/installer/lib/calendar.sh'; CAL_URL="$1" CAL_USER=owner@example.invalid CAL_PASSWORD="$2" CAL_EMAIL=owner@example.invalid calendar_env_text`,
        'installer',
        url,
        CANARY,
      ],
      { encoding: 'utf8' },
    );
    return done.stdout;
  }

  function runAgent(command: string, input: string) {
    return spawnSync('node', [AGENT, command], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', CALENDAR_ACCOUNT_FILE: join(folder, '.env.calendar') },
    });
  }

  it('saves what the installer sends as a private file the sidecar reads, and says nothing else', () => {
    const done = runAgent('--write-stdin', installerText('https://203.0.113.10/dav/'));
    expect(done.status).toBe(0);
    expect(done.stdout).toBe('saved\n');
    expect(done.stderr).not.toContain(CANARY);
    const file = join(folder, '.env.calendar');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('CALDAV_URL=https://203.0.113.10/dav/\n');
    expect(text).toContain(`CALDAV_PASSWORD=${CANARY}\n`);
    expect(text).toContain('CALDAV_USERNAME=owner@example.invalid\n');
    expect(text).toContain('CALDAV_USER_EMAIL=owner@example.invalid\n');
  });

  it('refuses a cloud metadata address and saves nothing', () => {
    const done = runAgent('--write-stdin', installerText('https://169.254.169.254/latest/'));
    expect(done.status).toBe(3);
    expect(done.stdout).toBe('');
    expect(done.stderr).not.toContain(CANARY);
    expect(existsSync(join(folder, '.env.calendar'))).toBe(false);
  });

  it('removes the saved account', () => {
    runAgent('--write-stdin', installerText('https://203.0.113.10/dav/'));
    const done = runAgent('--remove', '');
    expect(done.status).toBe(0);
    expect(done.stdout).toBe('removed\n');
    expect(existsSync(join(folder, '.env.calendar'))).toBe(false);
  });
});
