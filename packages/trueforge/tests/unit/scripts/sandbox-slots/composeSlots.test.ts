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
  restart: z.string(),
  healthcheck: z.object({ test: z.array(z.string()) }),
  privileged: z.never().optional(),
  cap_add: z.never().optional(),
  devices: z.never().optional(),
  ports: z.never().optional(),
  pid: z.never().optional(),
  env_file: z.never().optional(),
  environment: z.never().optional(),
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

  test('the slot volumes have fixed names the app file can join', () => {
    expect(
      Object.values(compose.volumes)
        .map(volume => volume.name)
        .sort(),
    ).toEqual([
      'aman_slot_ctl_1',
      'aman_slot_ctl_2',
      'aman_slot_ctl_3',
      'aman_slot_ctl_4',
      'aman_slot_ws_1',
      'aman_slot_ws_2',
      'aman_slot_ws_3',
      'aman_slot_ws_4',
    ]);
  });
});

describe('docker-compose.slots-app.yml', () => {
  const app = z
    .object({
      services: z.object({
        server: z.object({
          environment: z.record(z.string(), z.string()),
          volumes: z.array(z.string()),
        }),
      }),
      volumes: z.record(z.string(), z.object({ name: z.string(), external: z.literal(true) })),
    })
    .parse(load('docker-compose.slots-app.yml'));

  test('switches the app to the slot backend and mounts each control volume read-only, with no socket', () => {
    expect(app.services.server.environment).toMatchObject({
      SANDBOX_BACKEND: 'slots',
      SANDBOX_SLOTS_DIR: '/run/aman-slots',
    });
    expect(app.services.server.volumes).toHaveLength(4);
    for (const [index, volume] of app.services.server.volumes.entries()) {
      expect(volume).toBe(`slot_ctl_${String(index + 1)}:/run/aman-slots/${String(index + 1)}:ro`);
    }
    expect(JSON.stringify(app)).not.toContain('docker.sock');
  });

  test('only the control volumes are shared, never a workspace volume', () => {
    expect(Object.values(app.volumes).map(volume => volume.name)).toEqual([
      'aman_slot_ctl_1',
      'aman_slot_ctl_2',
      'aman_slot_ctl_3',
      'aman_slot_ctl_4',
    ]);
  });
});

describe('ops/sandbox-slot/sandbox-seccomp.json', () => {
  const ProfileSchema = z.object({
    defaultAction: z.literal('SCMP_ACT_ERRNO'),
    syscalls: z.array(z.object({ names: z.array(z.string()), action: z.string() })),
  });
  const profile = ProfileSchema.parse(
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'ops/sandbox-slot/sandbox-seccomp.json'), 'utf8')),
  );
  const allowed = new Set(
    profile.syscalls.filter(rule => rule.action === 'SCMP_ACT_ALLOW').flatMap(rule => rule.names),
  );

  // gVisor starts its sandbox and gofer from inside the slot, so these must stay allowed; each was
  // confirmed by removing it and watching the guest canary fail.
  test.each(['ptrace', 'chroot', 'mount', 'umount2', 'pivot_root', 'clone', 'unshare', 'setns', 'setuid', 'capset'])(
    'keeps %s, which the gVisor runtime needs to start a guest',
    name => {
      expect(allowed.has(name)).toBe(true);
    },
  );

  // Docker's default profile grants these once the container has the matching capability. The slots have
  // none, and gVisor does not use them, so they stay denied rather than relying on the missing capability.
  test.each([
    'bpf',
    'perf_event_open',
    'open_by_handle_at',
    'init_module',
    'finit_module',
    'delete_module',
    'kexec_load',
    'reboot',
    'acct',
    'iopl',
    'ioperm',
    'settimeofday',
    'clock_settime',
    'syslog',
    'process_vm_readv',
    'process_vm_writev',
    'kcmp',
    'pidfd_getfd',
    'quotactl',
    'lookup_dcookie',
    'fanotify_init',
    'fsopen',
    'fsconfig',
    'fsmount',
    'fspick',
    'open_tree',
    'move_mount',
    'mount_setattr',
    'sethostname',
    'setdomainname',
  ])('denies %s', name => {
    expect(allowed.has(name)).toBe(false);
  });

  test('answers clone3 with an error so libc falls back to clone', () => {
    const clone3 = profile.syscalls.filter(rule => rule.names.includes('clone3'));
    expect(clone3.map(rule => rule.action)).toEqual(['SCMP_ACT_ERRNO']);
  });
});
