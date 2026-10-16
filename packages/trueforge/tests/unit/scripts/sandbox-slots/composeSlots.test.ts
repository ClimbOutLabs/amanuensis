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
      expect(service.volumes).toHaveLength(2);
      expect(service.volumes.every(volume => /^slot_(ws|ctl)_[1-4]:\/(workspace|run\/aman)$/.test(volume))).toBe(true);
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
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_1',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_2',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_3',
      '${AMAN_SLOTS_INSTANCE:-aman}_slot_ws_4',
    ]);
  });
});

/** The installer's instance template with the sandbox on and no https front end, for an instance named main. */
function renderInstanceTemplate(): unknown {
  const text = readFileSync(resolve(REPO_ROOT, 'installer/templates/instance/compose.yaml.tpl'), 'utf8');
  const rendered = text
    .split('\n')
    .filter(line => !line.startsWith('@@IF_EDGE@@'))
    .map(line => line.replace('@@IF_SANDBOX@@', ''))
    .join('\n')
    .replace(/@@NAME@@/g, 'main')
    .replace('@@APP_PORTS@@', "      - '127.0.0.1:1:8790'")
    .replace(/@@[A-Z_]+@@/g, '1');
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
    .parse(renderInstanceTemplate());

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
    ]);
    expect(JSON.stringify(app)).not.toContain('slot_ws_');
  });

  test('the slot image tag the installer builds is the one the slot services run', () => {
    const slots = ComposeSchema.parse(load('docker-compose.slots.yml'));
    const service = ServiceSchema.parse(slots.services['sandbox-1']);
    expect(readFileSync(resolve(REPO_ROOT, 'installer/lib/sandbox.sh'), 'utf8')).toContain(
      `SLOT_IMAGE=${service.image}`,
    );
  });
});
