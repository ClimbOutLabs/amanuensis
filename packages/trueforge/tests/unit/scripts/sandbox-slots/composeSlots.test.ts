import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

const ServiceSchema = z.object({
  image: z.string(),
  pull_policy: z.literal('never'),
  init: z.literal(false),
  user: z.literal('65532:65532'),
  read_only: z.literal(true),
  network_mode: z.literal('none'),
  cap_drop: z.tuple([z.literal('ALL')]),
  security_opt: z.array(z.string()),
  tmpfs: z.array(z.string()),
  mem_limit: z.string(),
  memswap_limit: z.string(),
  cpus: z.number(),
  pids_limit: z.number(),
  cgroup: z.literal('private'),
  ipc: z.literal('private'),
  volumes: z.array(z.string()),
  restart: z.literal('unless-stopped'),
  healthcheck: z.object({ test: z.array(z.string()) }),
  privileged: z.never().optional(),
  cap_add: z.never().optional(),
  devices: z.never().optional(),
  ports: z.never().optional(),
  pid: z.never().optional(),
  env_file: z.never().optional(),
  environment: z.object({ AMAN_WORKSPACE_DISK_MODE: z.string() }).strict(),
});

const ComposeSchema = z.object({
  name: z.string(),
  services: z.record(z.string(), z.unknown()),
  volumes: z.record(z.string(), z.object({ name: z.string() })),
});

function load(file: string): unknown {
  return parse(readFileSync(resolve(REPO_ROOT, file), 'utf8'), { merge: true });
}

describe('docker-compose.slots.yml', () => {
  const compose = ComposeSchema.parse(load('docker-compose.slots.yml'));

  test('defines four slots, each fully hardened and with nothing the guest design forbids', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['sandbox-1', 'sandbox-2', 'sandbox-3', 'sandbox-4']);
    for (const raw of Object.values(compose.services)) {
      const service = ServiceSchema.parse(raw);
      expect(service.security_opt).toEqual(
        expect.arrayContaining([
          'no-new-privileges:true',
          'seccomp=./ops/sandbox-slot/sandbox-seccomp.json',
          'apparmor=aman-sandbox-slot',
        ]),
      );
      expect(service.security_opt.some(option => /unconfined/.test(option))).toBe(false);
      expect(service.tmpfs.map(entry => entry.split(':')[0]).sort()).toEqual(['/run/runsc', '/tmp']);
      expect(service.volumes).toHaveLength(3);
      expect(
        service.volumes.every(volume =>
          /^slot_(ws|ctl|mirror)_[1-4]:\/(workspace|run\/aman|run\/aman\/mirror)$/.test(volume),
        ),
      ).toBe(true);
      expect(
        service.volumes.some(
          volume => volume.includes('docker.sock') || volume.startsWith('/') || volume.startsWith('.'),
        ),
      ).toBe(false);
    }
  });

  test('the project, volumes and containers are named by the install, so two installs never share slots', () => {
    expect(compose.name).toBe('${AMAN_SLOTS_INSTANCE:-aman}-slots');
    for (const raw of Object.values(compose.services)) {
      expect(JSON.stringify(raw)).toContain('"com.amanuensis.instance":"${AMAN_SLOTS_INSTANCE:-aman}"');
    }
  });

  test('the slot volumes have names the app file can join', () => {
    expect(
      Object.values(compose.volumes)
        .map(volume => volume.name)
        .sort(),
    ).toEqual([
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ctl_1',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ctl_2',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ctl_3',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ctl_4',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_mirror_1',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_mirror_2',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_mirror_3',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_mirror_4',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_1',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_2',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_3',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_4',
    ]);
  });
});

/**
 * The installer's instance template, rendered by the installer's own `render_template` with the pairs
 * `instance.sh` passes, for an instance named main with the sandbox on, the email connector off and no https
 * front end of either kind. The calendar connector block is kept only when `calendar` is true.
 */
function renderInstanceTemplate({ calendar }: { calendar: boolean }): unknown {
  const pairs = [
    'NAME=main',
    `IF_CALENDAR=${calendar ? '1' : '0'}`,
    'CALENDAR_IMAGE=calendar-test:1',
    'IF_EMAIL=0',
    'MAIL_EMAIL_IMAGE=mail-test:1',
    'STT_NETWORK=aman_main_speech',
    'APP_IMAGE=app-test:1',
    'DEX_IMAGE=dex-test:1',
    'APP_PORT=8790',
    'IF_SANDBOX=1',
    'IF_EDGE=0',
    'LOGIN_HOST=login.test',
    'LOGIN_PORT=5556',
    'DEX_TELEMETRY_PORT=5558',
    "APP_PORTS=      - '127.0.0.1:1:8790'",
    'IF_TLS=0',
    'CADDY_IMAGE=caddy-test:1',
    'TLS_USER=1000:1000',
    'TLS_LEAF_DIR=/tmp/leaf',
    'TLS_TRUST_DIR=/tmp/trust',
    'TLS_HTTP_IN=8080',
  ];
  // `die` lives in a library that needs the whole installer; the renderer only needs it to stop with a message.
  const script = 'die() { printf "%s\\n" "$*" >&2; exit 1; }; . "$1"; shift; render_template "$@"';
  const rendered = execFileSync(
    'bash',
    [
      '-c',
      script,
      'bash',
      resolve(REPO_ROOT, 'installer/lib/templates.sh'),
      resolve(REPO_ROOT, 'installer/templates/instance/compose.yaml.tpl'),
      ...pairs,
    ],
    { encoding: 'utf8' },
  );
  return parse(rendered);
}

describe('installer/templates/instance/compose.yaml.tpl sandbox wiring', () => {
  const app = z
    .object({
      services: z.object({
        app: z.object({
          environment: z.record(z.string(), z.string()),
          volumes: z.array(z.string()),
        }),
      }),
      volumes: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })),
    })
    .parse(renderInstanceTemplate({ calendar: false }));

  test('switches the app to the slot backend and mounts each control volume read-only, with no socket', () => {
    expect(app.services.app.environment).toMatchObject({
      SANDBOX_BACKEND: 'slots',
      SANDBOX_SLOTS: '4',
      SANDBOX_SLOTS_DIR: '/run/aman-slots',
    });
    const mounts = app.services.app.volumes.filter(volume => volume.startsWith('slot_ctl_'));
    expect(mounts).toHaveLength(4);
    for (const [index, volume] of mounts.entries()) {
      expect(volume).toBe(`slot_ctl_${String(index + 1)}:/run/aman-slots/${String(index + 1)}:ro`);
    }
    expect(JSON.stringify(app)).not.toContain('docker.sock');
  });

  test('the shared control volumes are the slots project volumes of the same name, and no workspace volume is shared', () => {
    const external = Object.entries(app.volumes).filter(([, volume]) => volume.external === true);
    expect(external.map(([, volume]) => volume.name)).toEqual([
      'main_slot_ctl_1',
      'main_slot_ctl_2',
      'main_slot_ctl_3',
      'main_slot_ctl_4',
      'main_slot_mirror_1',
      'main_slot_mirror_2',
      'main_slot_mirror_3',
      'main_slot_mirror_4',
    ]);
    expect(JSON.stringify(app)).not.toContain('slot_ws_');
  });

  test('mounts each mirror volume writable, so the app can run the package mirrors there', () => {
    const mounts = app.services.app.volumes.filter(volume => volume.startsWith('slot_mirror_'));
    expect(mounts).toHaveLength(4);
    for (const [index, volume] of mounts.entries()) {
      expect(volume).toBe(`slot_mirror_${String(index + 1)}:/run/aman-slots/${String(index + 1)}/mirror`);
    }
  });

  test('the slot image tag the installer builds is the one the slot services run', () => {
    const slots = ComposeSchema.parse(load('docker-compose.slots.yml'));
    const service = ServiceSchema.parse(slots.services['sandbox-1']);
    expect(readFileSync(resolve(REPO_ROOT, 'installer/lib/sandbox.sh'), 'utf8')).toContain(
      `SLOT_IMAGE=${service.image}`,
    );
  });
});

describe('installer/templates/instance/compose.yaml.tpl calendar connector', () => {
  const services = (calendar: boolean) =>
    z.object({ services: z.record(z.string(), z.unknown()) }).parse(renderInstanceTemplate({ calendar })).services;

  test('renders without the connector when the calendar is off, and with it when on, and both parse', () => {
    expect(Object.keys(services(false))).not.toContain('calendar-caldav');
    expect(Object.keys(services(true))).toEqual(expect.arrayContaining(['app', 'dex', 'calendar-caldav']));
  });

  test('the connector is never published and runs with the hardening the other services use', () => {
    const connector = z
      .object({
        expose: z.array(z.string()),
        cap_drop: z.array(z.string()),
        security_opt: z.array(z.string()),
        restart: z.literal('unless-stopped'),
        ports: z.never().optional(),
      })
      .parse(services(true)['calendar-caldav']);
    expect(connector.expose).toEqual(['9558', '9560']);
    expect(connector.cap_drop).toEqual(['ALL']);
    expect(connector.security_opt).toEqual(['no-new-privileges:true']);
  });

  test('the connector starts with the instance, keeps its login in its own volume and reads no host file', () => {
    const rendered = z
      .object({
        services: z.object({
          'calendar-caldav': z.object({
            profiles: z.never().optional(),
            env_file: z.never().optional(),
            volumes: z.array(z.string()),
            environment: z.record(z.string(), z.string()),
          }),
          app: z.object({ environment: z.record(z.string(), z.string()) }),
        }),
        volumes: z.record(z.string(), z.object({ name: z.string() })),
      })
      .parse(renderInstanceTemplate({ calendar: true }));
    const connector = rendered.services['calendar-caldav'];
    expect(connector.volumes).toEqual(['calendar-account:/account']);
    expect(connector.environment['CALENDAR_ACCOUNT_FILE']).toBe('/account/.env.calendar');
    expect(connector.environment['CALENDAR_ACCOUNT_PORT']).toBe('9560');
    expect(Object.keys(connector.environment).filter(key => /PASSWORD|TOKEN|USERNAME/i.test(key))).toEqual([]);
    expect(rendered.volumes['calendar-account']?.name).toBe('aman_main_calendar_account');
    expect(rendered.services.app.environment['CALENDAR_ACCOUNT_URL']).toBe('http://calendar-caldav:9560');
  });

  test('the app is told nothing about a calendar agent when the connector is left out', () => {
    const app = z
      .object({ services: z.object({ app: z.object({ environment: z.record(z.string(), z.string()) }) }) })
      .parse(renderInstanceTemplate({ calendar: false }));
    expect(app.services.app.environment['CALENDAR_ACCOUNT_URL']).toBeUndefined();
  });
});
