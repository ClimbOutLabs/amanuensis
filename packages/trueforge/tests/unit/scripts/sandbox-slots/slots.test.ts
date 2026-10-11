import { PackError, type PacksPort } from '../../../../scripts/sandbox-slots/packs';
import {
  CommandNotFoundError,
  runSandboxSlots,
  SLOT_COUNT,
  stopSandboxSlots,
  type CommandResult,
  type CommandRunner,
  type SlotsOptions,
  type SlotsResult,
} from '../../../../scripts/sandbox-slots/slots';

const OK: CommandResult = { stdout: '', stderr: '', exitCode: 0 };

interface Call {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A scripted docker: `respond` returns the result for a call, or undefined to answer success. */
function fakeRunner(respond: (call: Call) => Partial<CommandResult> | Error | undefined): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = input => {
    const call = { command: input.command, args: input.args, env: input.env };
    calls.push(call);
    const answer = respond(call);
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return Promise.resolve({ ...OK, ...answer });
  };
  return { run, calls };
}

function joined(call: Call): string {
  return call.args.join(' ');
}

function defaultAnswers(call: Call): Partial<CommandResult> | undefined {
  const text = joined(call);
  if (text.startsWith('version')) {
    return { stdout: '29.1.0 aarch64\n' };
  }
  if (text.includes('compose version')) {
    return { stdout: '2.40.0\n' };
  }
  if (text.startsWith('info')) {
    return { stdout: '["name=seccomp,profile=builtin","name=cgroupns"]' };
  }
  if (text.includes('image inspect')) {
    return { stdout: String(1_800_000_000) };
  }
  return undefined;
}

/** Defaults describe a Mac: Docker runs in a VM, so no per-slot disks are involved. */
const BASE_OPTIONS: Omit<SlotsOptions, 'run' | 'fix'> = {
  repoRoot: '/repo',
  instance: 'aman',
  platform: 'darwin',
  isRoot: false,
  diskGb: 16,
  hardDiskLimit: true,
  packsPort: {
    selected: () => Promise.resolve([]),
    prepare: ({ add, remove }) => Promise.resolve(add.filter(name => !remove.includes(name))),
  },
  addPacks: [],
  removePacks: [],
  confirm: () => Promise.resolve(true),
  onCheck: undefined,
};

async function run(
  respond: (call: Call) => Partial<CommandResult> | Error | undefined,
  fix = false,
  extra: Partial<SlotsOptions> = {},
): Promise<{
  result: SlotsResult;
  calls: Call[];
}> {
  const { run: runner, calls } = fakeRunner(call => respond(call) ?? defaultAnswers(call));
  const result = await runSandboxSlots({ ...BASE_OPTIONS, ...extra, run: runner, fix });
  return { result, calls };
}

describe('runSandboxSlots', () => {
  test('builds, starts and attests every slot, then names the app compose file', async () => {
    const { result, calls } = await run(() => undefined);
    expect(result).toMatchObject({
      ok: true,
      image_size_mb: 1717,
      app_compose_file: '/repo/docker-compose.slots-app.yml',
    });
    const text = calls.map(joined);
    expect(text.some(line => line.includes('build sandbox-1'))).toBe(true);
    expect(text.some(line => line.includes('up -d --no-build --wait'))).toBe(true);
    expect(text.filter(line => line.includes('aman-slot-agent healthcheck'))).toHaveLength(SLOT_COUNT);
    expect(text.every(line => !line.includes('apparmor_parser'))).toBe(true);
  });

  test('every compose call uses the slots project and this checkout as the project directory', async () => {
    const { calls } = await run(() => undefined);
    for (const call of calls.filter(entry => entry.args[0] === 'compose' && entry.args[1] !== 'version')) {
      expect(call.args).toEqual(
        expect.arrayContaining([
          '--project-directory',
          '/repo',
          '-p',
          'aman-slots',
          '-f',
          '/repo/docker-compose.slots.yml',
        ]),
      );
    }
  });

  test('a named install gets its own project and tells compose its name', async () => {
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    const runner: CommandRunner = input => {
      seen.push({ args: input.args, env: input.env });
      return Promise.resolve({
        ...OK,
        ...defaultAnswers({ command: input.command, args: input.args, env: input.env }),
      });
    };
    const result = await runSandboxSlots({ ...BASE_OPTIONS, run: runner, fix: false, instance: 'lab' });
    expect(result.ok).toBe(true);
    const compose = seen.filter(entry => entry.args[0] === 'compose' && entry.args[1] !== 'version');
    expect(compose.length).toBeGreaterThan(0);
    for (const entry of compose) {
      expect(entry.args).toEqual(expect.arrayContaining(['-p', 'lab-slots']));
      expect(entry.env).toEqual({ AMAN_SLOTS_INSTANCE: 'lab', AMAN_SLOTS_PACKS: '' });
    }
  });

  test('a missing docker is a plain failure with an install fix', async () => {
    const { result } = await run(() => new CommandNotFoundError('docker'));
    expect(result).toMatchObject({ ok: false, step: 'docker' });
    expect(!result.ok && result.fix).toContain('Install Docker');
  });

  test('a daemon that is not running names how to start it', async () => {
    const { result } = await run(call =>
      joined(call).startsWith('version') ? { exitCode: 1, stderr: 'Cannot connect' } : undefined,
    );
    expect(result).toMatchObject({ ok: false, step: 'docker' });
    expect(!result.ok && result.error).toContain('Cannot connect');
  });

  test('a build failure points at the network, not at editing files', async () => {
    const { result } = await run(call =>
      joined(call).includes(' build ') ? { exitCode: 1, stderr: 'toomanyrequests' } : undefined,
    );
    expect(result).toMatchObject({ ok: false, step: 'build' });
    expect(!result.ok && result.fix).toContain('docker login');
  });

  test('without AppArmor on the host the profile is never probed or loaded', async () => {
    const { calls } = await run(() => undefined);
    expect(calls.some(call => joined(call).includes('apparmor='))).toBe(false);
  });

  describe('where the host runs AppArmor', () => {
    const appArmorHost = (call: Call): Partial<CommandResult> | undefined =>
      joined(call).startsWith('info') ? { stdout: '["name=apparmor","name=seccomp,profile=builtin"]' } : undefined;

    test('an unloaded profile fails with the one command, and loads nothing without --fix', async () => {
      const { result, calls } = await run(call =>
        joined(call).includes('apparmor=aman-sandbox-slot') ? { exitCode: 125 } : appArmorHost(call),
      );
      expect(result).toMatchObject({ ok: false, step: 'apparmor' });
      expect(!result.ok && result.fix).toBe(
        'Run pnpm sandbox:slots --fix. It asks for your password once to load the profile.',
      );
      expect(calls.some(call => call.command === 'sudo')).toBe(false);
      expect(calls.some(call => joined(call).includes('up -d'))).toBe(false);
    });

    test('--fix loads the profile with sudo and continues once the probe passes', async () => {
      let loaded = false;
      const { result, calls } = await run(call => {
        if (call.command === 'sudo') {
          loaded = true;
          return undefined;
        }
        if (joined(call).includes('apparmor=aman-sandbox-slot')) {
          return loaded ? undefined : { exitCode: 125 };
        }
        return appArmorHost(call);
      }, true);
      expect(result.ok).toBe(true);
      const sudo = calls.find(call => call.command === 'sudo');
      expect(sudo?.args).toEqual(['apparmor_parser', '-r', '-W', '/repo/ops/sandbox-slot/apparmor/aman-sandbox-slot']);
    });

    test('a profile that still does not load after sudo is a failure', async () => {
      const { result } = await run(
        call => (joined(call).includes('apparmor=aman-sandbox-slot') ? { exitCode: 125 } : appArmorHost(call)),
        true,
      );
      expect(result).toMatchObject({ ok: false, step: 'apparmor' });
    });
  });

  test('slots that never become healthy fail with their log lines', async () => {
    const { result } = await run(call => {
      const text = joined(call);
      if (text.includes('up -d')) {
        return { exitCode: 1, stderr: 'container is unhealthy' };
      }
      if (text.includes(' logs ')) {
        return { stdout: 'attestation FAILED seccomp: Seccomp is "0"' };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(!result.ok && result.error).toContain('attestation FAILED seccomp');
  });

  test('a slot whose attestation fails after start fails the run', async () => {
    const { result } = await run(call =>
      joined(call).includes('sandbox-3') && joined(call).includes('healthcheck')
        ? { exitCode: 1, stderr: 'attestation failed: apparmor: wrong profile' }
        : undefined,
    );
    expect(result).toMatchObject({ ok: false, step: 'attest' });
    expect(!result.ok && result.error).toContain('Slot 3');
  });
});

describe('toolchain packs', () => {
  test('the chosen packs reach the image build and every later compose call, and the result lists them', async () => {
    const asked: { add: string[]; remove: string[]; arch: string | undefined }[] = [];
    const packsPort: PacksPort = {
      selected: () => Promise.resolve([]),
      prepare: input => {
        asked.push({ add: input.add, remove: input.remove, arch: input.arch });
        return Promise.resolve(['go', 'rust']);
      },
    };
    const { result, calls } = await run(
      call => (joined(call).startsWith('info --format {{.Architecture}}') ? { stdout: 'aarch64\n' } : undefined),
      false,
      { packsPort, addPacks: ['go'], removePacks: ['java'] },
    );
    expect(result).toMatchObject({ ok: true, packs: ['go', 'rust'] });
    expect(asked).toEqual([{ add: ['go'], remove: ['java'], arch: 'aarch64' }]);
    const compose = calls.filter(call => call.args[0] === 'compose' && call.args[1] !== 'version');
    expect(compose.length).toBeGreaterThan(0);
    for (const call of compose) {
      expect(call.env['AMAN_SLOTS_PACKS']).toBe('go,rust');
    }
    expect(calls.findIndex(call => joined(call).startsWith('info --format {{.Architecture}}'))).toBeLessThan(
      calls.findIndex(call => joined(call).includes(' build ')),
    );
  });

  test('a pack that cannot be downloaded or verified stops before the build', async () => {
    const packsPort: PacksPort = {
      selected: () => Promise.resolve([]),
      prepare: () =>
        Promise.reject(new PackError('go-1.27.2-linux-amd64.zip does not match its pinned checksum', 'Run it again.')),
    };
    const { result, calls } = await run(() => undefined, false, { packsPort, addPacks: ['go'] });
    expect(result).toMatchObject({ ok: false, step: 'packs', fix: 'Run it again.' });
    expect(calls.some(call => joined(call).includes(' build '))).toBe(false);
  });
});

describe('the per-slot disks on a native Linux host', () => {
  const ROOT = '/var/lib/aman-slots/aman';
  const SIZE = 16 * 2 ** 30;
  const linux: Partial<SlotsOptions> = { platform: 'linux' };

  /** A host whose disks are set up once the setup script has run. */
  function host(state: { disks: boolean; oldVolumes?: boolean }) {
    return (call: Call): Partial<CommandResult> | undefined => {
      const text = joined(call);
      if (text.startsWith('info --format {{.OperatingSystem}}')) {
        return { stdout: 'Ubuntu 24.04.3 LTS\n' };
      }
      if (call.command === 'uname') {
        return { stdout: '6.8.0-1-generic\n' };
      }
      if (call.command === 'findmnt') {
        return state.disks ? { stdout: `ext4 ${String(SIZE - 100 * 2 ** 20)}\n` } : { exitCode: 1 };
      }
      if (text.startsWith('volume inspect')) {
        const slot = call.args[call.args.length - 1]?.slice(-1);
        return state.oldVolumes === true ? { stdout: '\n' } : { stdout: `${ROOT}/ws-${slot ?? ''}\n` };
      }
      if (call.command === 'sudo' || (call.command === 'sh' && call.args.includes('setup'))) {
        state.disks = true;
      }
      return undefined;
    };
  }

  test('without disks it stops with the one command and touches nothing', async () => {
    const { result, calls } = await run(host({ disks: false }), false, linux);
    expect(result).toMatchObject({ ok: false, step: 'disk' });
    expect(!result.ok && result.fix).toContain('pnpm sandbox:slots --fix');
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
    expect(calls.some(call => joined(call).includes('up -d'))).toBe(false);
  });

  test('--fix asks first, then runs one root script that creates the disks, and every later compose call uses them', async () => {
    const questions: string[] = [];
    const { result, calls } = await run(host({ disks: false }), true, {
      ...linux,
      confirm: question => {
        questions.push(question);
        return Promise.resolve(true);
      },
    });
    expect(result).toMatchObject({ ok: true, disk: { mode: 'hard', bytes: SIZE - 100 * 2 ** 20 } });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('/etc/fstab');
    expect(questions[0]).toContain('16 GB');
    const sudo = calls.filter(call => call.command === 'sudo');
    expect(sudo.map(call => call.args)).toEqual([
      ['sh', '/repo/ops/sandbox-slot/disks/setup-disks.sh', 'setup', ROOT, '16', '4'],
    ]);
    const up = calls.find(call => joined(call).includes('up -d'));
    expect(up?.args).toEqual(expect.arrayContaining(['-f', '/repo/docker-compose.slots-disks.yml']));
    expect(up?.env).toMatchObject({ AMAN_SLOTS_DISK_DIR: ROOT, AMAN_SLOTS_DISK_BYTES: String(SIZE - 100 * 2 ** 20) });
    const build = calls.find(call => joined(call).includes(' build '));
    expect(build?.args).not.toContain('/repo/docker-compose.slots-disks.yml');
  });

  test('declining the question changes nothing', async () => {
    const { result, calls } = await run(host({ disks: false }), true, {
      ...linux,
      confirm: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ ok: false, step: 'disk' });
    expect(!result.ok && result.error).toContain('not confirmed');
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
  });

  test('a root process runs the script directly, without sudo', async () => {
    const { result, calls } = await run(host({ disks: false }), true, { ...linux, isRoot: true });
    expect(result.ok).toBe(true);
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
    expect(calls.some(call => call.command === 'sh' && call.args.includes('setup'))).toBe(true);
  });

  test('disks that are already mounted need no password and no question', async () => {
    let asked = false;
    const { result, calls } = await run(host({ disks: true }), false, {
      ...linux,
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
    });
    expect(result).toMatchObject({ ok: true, disk: { mode: 'hard' } });
    expect(asked).toBe(false);
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
  });

  test('workspace volumes from before the disks are removed only after agreeing, then the disks are used', async () => {
    const state = { disks: true, oldVolumes: true };
    const { result, calls } = await run(host(state), true, linux);
    expect(result.ok).toBe(true);
    const text = calls.map(joined);
    const down = text.findIndex(line => line.includes(' down'));
    const removed = text.findIndex(line => line.startsWith('volume rm --force aman_slot_ws_1'));
    const up = text.findIndex(line => line.includes('up -d'));
    expect(down).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(down);
    expect(up).toBeGreaterThan(removed);
    const withoutFix = await run(host({ disks: true, oldVolumes: true }), false, linux);
    expect(withoutFix.result).toMatchObject({ ok: false, step: 'disk' });
    expect(withoutFix.calls.some(call => joined(call).startsWith('volume rm'))).toBe(false);
  });

  test('Docker Desktop and WSL2 use no per-slot disks', async () => {
    const desktop = await run(
      call =>
        joined(call).startsWith('info --format {{.OperatingSystem}}') ? { stdout: 'Docker Desktop\n' } : undefined,
      true,
      linux,
    );
    expect(desktop.result).toMatchObject({ ok: true, disk: { mode: 'vm' } });
    const wsl = await run(
      call => (call.command === 'uname' ? { stdout: '5.15.153.1-microsoft-standard-WSL2\n' } : undefined),
      true,
      linux,
    );
    expect(wsl.result).toMatchObject({ ok: true, disk: { mode: 'vm' } });
    for (const { calls } of [desktop, wsl]) {
      expect(calls.some(call => call.command === 'sudo' || call.command === 'findmnt')).toBe(false);
    }
  });

  test('--no-hard-disk-limit skips the disks', async () => {
    const { result, calls } = await run(host({ disks: false }), false, { ...linux, hardDiskLimit: false });
    expect(result).toMatchObject({ ok: true, disk: { mode: 'off' } });
    expect(calls.some(call => call.command === 'findmnt')).toBe(false);
  });

  test('a setup script that fails is reported with what to do next', async () => {
    const { result } = await run(
      call =>
        call.command === 'sudo' ? { exitCode: 1, stderr: 'mkfs.ext4 is missing' } : host({ disks: false })(call),
      true,
      linux,
    );
    expect(result).toMatchObject({ ok: false, step: 'disk' });
    expect(!result.ok && result.fix).toContain('e2fsprogs');
  });

  test('--down --purge also removes the disks, with one root script', async () => {
    const { run: runner, calls } = fakeRunner(call => (call.command === 'test' ? undefined : undefined));
    const stopped = await stopSandboxSlots({
      repoRoot: '/repo',
      run: runner,
      purge: true,
      instance: 'aman',
      platform: 'linux',
      isRoot: false,
    });
    expect(stopped.exitCode).toBe(0);
    expect(calls.map(call => call.args)).toContainEqual([
      'sh',
      '/repo/ops/sandbox-slot/disks/setup-disks.sh',
      'remove',
      ROOT,
      '4',
    ]);
    const plain = fakeRunner(() => undefined);
    await stopSandboxSlots({
      repoRoot: '/repo',
      run: plain.run,
      purge: false,
      instance: 'aman',
      platform: 'linux',
      isRoot: false,
    });
    expect(plain.calls.some(call => call.command === 'sudo')).toBe(false);
  });
});
