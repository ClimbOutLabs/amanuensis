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
  interactive: boolean;
  echo: boolean;
}

/** A scripted docker: `respond` returns the result for a call, or undefined to answer success. */
function fakeRunner(respond: (call: Call) => Partial<CommandResult> | Error | undefined): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = input => {
    const call = {
      command: input.command,
      args: input.args,
      env: input.env,
      interactive: input.interactive,
      echo: input.echo,
    };
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
  mode: 'up',
  command: 'pnpm sandbox:slots',
  restart: false,
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
  onStage: undefined,
  prepareRoot: undefined,
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
  test('builds, starts and attests every slot', async () => {
    const { result, calls } = await run(() => undefined);
    expect(result).toMatchObject({ ok: true, image_size_mb: 1717 });
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
        ...defaultAnswers({
          command: input.command,
          args: input.args,
          env: input.env,
          interactive: input.interactive,
          echo: input.echo,
        }),
      });
    };
    const result = await runSandboxSlots({ ...BASE_OPTIONS, run: runner, fix: false, instance: 'lab' });
    expect(result.ok).toBe(true);
    const compose = seen.filter(entry => entry.args[0] === 'compose' && entry.args[1] !== 'version');
    expect(compose.length).toBeGreaterThan(0);
    for (const entry of compose) {
      expect(entry.args).toEqual(expect.arrayContaining(['-p', 'lab-slots']));
      expect(entry.env).toEqual({ AMAN_SLOTS_INSTANCE: 'lab', AMAN_SLOTS_PACKS: '', AMAN_SLOTS_DISK_MODE: 'vm' });
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

  test('announces each part of a full run in order, even a part with nothing to do', async () => {
    const stages: string[] = [];
    await run(() => undefined, false, { onStage: stage => void stages.push(stage) });
    expect(stages).toEqual(['docker', 'image', 'profile', 'disks', 'start', 'attest']);
  });

  test('a read-only check announces its parts without a start, and a build stops after the image', async () => {
    const checked: string[] = [];
    await run(() => undefined, false, { mode: 'check', onStage: stage => void checked.push(stage) });
    expect(checked).toEqual(['docker', 'image', 'profile', 'disks', 'attest']);
    const built: string[] = [];
    await run(() => undefined, false, { mode: 'build', onStage: stage => void built.push(stage) });
    expect(built).toEqual(['docker', 'image']);
  });

  test('a failure keeps the tool output apart from its sentence and leaves the message as it was', async () => {
    const { result } = await run(call =>
      joined(call).includes('build sandbox-1') ? { exitCode: 1, stderr: 'no route to mirror' } : undefined,
    );
    expect(result).toMatchObject({
      ok: false,
      step: 'build',
      error: 'Building the sandbox image failed: no route to mirror',
      detail: 'no route to mirror',
    });
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

    test('--fix installs the profile in /etc/apparmor.d so it loads at boot, loads it, and continues once the probe passes', async () => {
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
      expect(calls.filter(call => call.command === 'sudo').map(call => call.args)).toEqual([
        [
          'install',
          '-m',
          '0644',
          '/repo/ops/sandbox-slot/apparmor/aman-sandbox-slot',
          '/etc/apparmor.d/aman-sandbox-slot',
        ],
        ['apparmor_parser', '-r', '-W', '/etc/apparmor.d/aman-sandbox-slot'],
      ]);
    });

    test('asks for the sudo password once, before the first root step, and lets the steps run with their output captured', async () => {
      let loaded = false;
      const order: string[] = [];
      const { result, calls } = await run(
        call => {
          if (call.command === 'sudo') {
            order.push(`sudo ${call.args[0] ?? ''}`);
            loaded = true;
            return undefined;
          }
          if (joined(call).includes('apparmor=aman-sandbox-slot')) {
            return loaded ? undefined : { exitCode: 125 };
          }
          return appArmorHost(call);
        },
        true,
        {
          prepareRoot: () => {
            order.push('password');
            return Promise.resolve(true);
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(order).toEqual(['password', 'sudo install', 'sudo apparmor_parser']);
      expect(calls.filter(call => call.command === 'sudo').every(call => call.interactive === false)).toBe(true);
    });

    test('without a cached password the root steps keep the terminal, as before', async () => {
      let loaded = false;
      const { calls } = await run(
        call => {
          if (call.command === 'sudo') {
            loaded = true;
            return undefined;
          }
          if (joined(call).includes('apparmor=aman-sandbox-slot')) {
            return loaded ? undefined : { exitCode: 125 };
          }
          return appArmorHost(call);
        },
        true,
        { prepareRoot: () => Promise.resolve(false) },
      );
      expect(calls.filter(call => call.command === 'sudo').every(call => call.interactive === true)).toBe(true);
    });

    test('as root the profile is installed and loaded without sudo', async () => {
      let loaded = false;
      const { result, calls } = await run(
        call => {
          if (call.command === 'apparmor_parser') {
            loaded = true;
            return undefined;
          }
          if (joined(call).includes('apparmor=aman-sandbox-slot')) {
            return loaded ? undefined : { exitCode: 125 };
          }
          return appArmorHost(call);
        },
        true,
        { isRoot: true },
      );
      expect(result.ok).toBe(true);
      expect(calls.some(call => call.command === 'sudo')).toBe(false);
      expect(calls.find(call => call.command === 'install')?.args).toContain('/etc/apparmor.d/aman-sandbox-slot');
    });

    test('a profile that cannot be copied into place is a failure that names the fix', async () => {
      const { result, calls } = await run(call => {
        if (call.command === 'sudo') {
          return { exitCode: 1, stderr: 'permission denied' };
        }
        return joined(call).includes('apparmor=aman-sandbox-slot') ? { exitCode: 125 } : appArmorHost(call);
      }, true);
      expect(result).toMatchObject({ ok: false, step: 'apparmor' });
      expect(calls.some(call => call.args[0] === 'apparmor_parser')).toBe(false);
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
    expect(!result.ok && result.error).toContain('Safety check seccomp failed: Seccomp is "0"');
  });

  test('a start failure names the failing safety check from the slot log, in plain words and without its log prefix, and reads the logs out loud', async () => {
    const { result, calls } = await run(call => {
      const text = joined(call);
      if (text.includes('up -d')) {
        return { exitCode: 1, stderr: 'container aman-slots-sandbox-2-1 is unhealthy' };
      }
      if (text.includes(' logs ')) {
        return {
          stdout:
            'sandbox-2-1  | 2026-10-10 11:58:00 attestation FAILED network: interfaces: eth0 has a route off this computer',
        };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(!result.ok && result.error).toContain(
      'Safety check network failed: interfaces: eth0 has a route off this computer',
    );
    expect(!result.ok && result.error).not.toContain('attestation FAILED');
    expect(!result.ok && result.error).not.toContain('sandbox-2-1  |');
    const logs = calls.find(call => joined(call).includes(' logs '));
    expect(logs?.echo).toBe(true);
  });

  test('a slot that is unhealthy at start writes the plain failure line to the log', async () => {
    const { result, calls } = await run(call => {
      const text = joined(call);
      if (text.includes('up -d')) {
        return { exitCode: 1, stderr: 'container aman-slots-sandbox-2-1 is unhealthy' };
      }
      if (text.includes(' logs ')) {
        return {
          stdout:
            'sandbox-2-1  | 2026-10-10 11:58:00 attestation FAILED network: interfaces: eth0 has a route off this computer',
        };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'start' });
    // The runner writes the output of every echoed call to the log file (see createRunCommand in main.ts),
    // so the plain line reaches the log only by being read out loud through an echoed call.
    const readOutLoud = calls.filter(call => call.echo).map(joined);
    expect(
      readOutLoud.some(line =>
        line.includes('Safety check network failed: interfaces: eth0 has a route off this computer'),
      ),
    ).toBe(true);
  });

  test('a failure line that does not name a check and a reason is shown as it is', async () => {
    const { result } = await run(call => {
      const text = joined(call);
      if (text.includes('up -d')) {
        return { exitCode: 1, stderr: 'container is unhealthy' };
      }
      if (text.includes(' logs ')) {
        return { stdout: 'sandbox-1-1  | 2026-10-10 11:58:00 attestation FAILED in a way nobody foresaw' };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(!result.ok && result.error).toContain('attestation FAILED in a way nobody foresaw');
  });

  test('slots that fail to start for another reason keep the log tail as the detail', async () => {
    const { result } = await run(call => {
      const text = joined(call);
      if (text.includes('up -d')) {
        return { exitCode: 1, stderr: 'image not found' };
      }
      if (text.includes(' logs ')) {
        return { stdout: 'sandbox-1-1  | starting up' };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(!result.ok && result.error).toContain('image not found');
  });

  test('a slot that is down fails its check with the failing safety check from its own log', async () => {
    const { result, calls } = await run(call => {
      const text = joined(call);
      if (text.includes('sandbox-2') && text.includes('healthcheck')) {
        return { exitCode: 1, stderr: 'Error response from daemon: container is not running' };
      }
      if (text.includes(' logs ')) {
        return {
          stdout: 'sandbox-2-1  | 2026-10-10 11:57:00 attestation FAILED runsc: the sandbox runtime did not answer',
        };
      }
      return undefined;
    });
    expect(result).toMatchObject({ ok: false, step: 'attest' });
    expect(!result.ok && result.error).toContain('Safety check runsc failed: the sandbox runtime did not answer');
    expect(calls.some(call => joined(call).includes(' logs ') && call.echo)).toBe(true);
    expect(
      calls.some(
        call => call.echo && joined(call).includes('Safety check runsc failed: the sandbox runtime did not answer'),
      ),
    ).toBe(true);
  });

  test('a slot whose agent answers with its failing checks keeps that answer, and the logs are not read', async () => {
    const { result, calls } = await run(call =>
      joined(call).includes('sandbox-2') && joined(call).includes('healthcheck')
        ? { exitCode: 1, stdout: 'FAIL apparmor: the profile is not enforced', stderr: 'attestation failed: apparmor' }
        : undefined,
    );
    expect(result).toMatchObject({ ok: false, step: 'attest' });
    expect(!result.ok && result.error).toContain('Sandbox 2');
    expect(calls.some(call => joined(call).includes(' logs '))).toBe(false);
  });

  test('a slot whose attestation fails after start fails the run', async () => {
    const { result } = await run(call =>
      joined(call).includes('sandbox-2') && joined(call).includes('healthcheck')
        ? { exitCode: 1, stderr: 'attestation failed: apparmor: wrong profile' }
        : undefined,
    );
    expect(result).toMatchObject({ ok: false, step: 'attest' });
    expect(!result.ok && result.error).toContain('Sandbox 2');
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

describe('the extra slots of an install from before two slots', () => {
  /** Slots 3 and 4 still run as containers of the slots project, and their volumes exist. */
  function oldInstall(call: Call): Partial<CommandResult> | undefined {
    const text = joined(call);
    if (text.startsWith('ps -aq') && (text.includes('service=sandbox-3') || text.includes('service=sandbox-4'))) {
      return { stdout: text.includes('sandbox-3') ? 'c3\n' : 'c4\n' };
    }
    if (text.startsWith('volume inspect')) {
      return { stdout: '[]\n' };
    }
    return undefined;
  }

  test('a full run removes their containers and volumes before the slots start', async () => {
    const { result, calls } = await run(oldInstall);
    expect(result.ok).toBe(true);
    const text = calls.map(joined);
    const removed = text.indexOf('rm --force c3 c4');
    expect(removed).toBeGreaterThan(-1);
    for (const slot of ['3', '4']) {
      for (const kind of ['ws', 'ctl', 'mirror']) {
        expect(text).toContain(`volume rm aman_slot_${kind}_${slot}`);
      }
    }
    expect(removed).toBeLessThan(text.findIndex(line => line.includes('up -d')));
    expect(text.some(line => line.includes('aman_slot_ctl_1') && line.startsWith('volume rm'))).toBe(false);
    expect(result.ok && result.checks.some(check => check.message.includes('Removed the extra sandboxes'))).toBe(true);
  });

  test('a read-only check reports them and changes nothing', async () => {
    const { result, calls } = await run(oldInstall, false, { mode: 'check' });
    expect(result).toMatchObject({ ok: false, step: 'retire' });
    expect(!result.ok && result.fix).toContain('pnpm sandbox:slots --fix');
    expect(calls.some(call => call.args[0] === 'rm' || joined(call).startsWith('volume rm'))).toBe(false);
  });

  test('the chats of the extra slots are moved into the slots that stay, before their workspaces are removed', async () => {
    const withChats = (call: Call): Partial<CommandResult> | undefined => {
      const text = joined(call);
      if (call.args[0] === 'run' && call.args.includes('ls')) {
        if (text.includes('aman_slot_ws_3:/from:ro')) {
          return { stdout: `${'a'.repeat(32)}\n` };
        }
        if (text.includes('aman_slot_ws_4:/from:ro')) {
          return { stdout: `${'b'.repeat(32)}\n` };
        }
      }
      return oldInstall(call);
    };
    const { result, calls } = await run(withChats);
    expect(result.ok).toBe(true);
    const text = calls.map(joined);
    const moves = calls.filter(call => call.args.includes('move-sessions'));
    expect(moves).toHaveLength(2);
    expect(moves[0]?.args).toEqual(
      expect.arrayContaining(['aman_slot_ws_3:/from', 'aman_slot_ws_1:/to', 'a'.repeat(32)]),
    );
    expect(moves[1]?.args).toEqual(
      expect.arrayContaining(['aman_slot_ws_4:/from', 'aman_slot_ws_2:/to', 'b'.repeat(32)]),
    );
    const firstMove = text.findIndex(line => line.includes('move-sessions'));
    expect(firstMove).toBeGreaterThan(-1);
    // The retired containers stop first, so nothing writes while the folders move; the workspaces
    // themselves are only removed after the move.
    expect(firstMove).toBeGreaterThan(text.indexOf('rm --force c3 c4'));
    expect(firstMove).toBeLessThan(text.indexOf('volume rm aman_slot_ws_3'));
  });

  test('on a native Linux host their disks go only with --fix and after agreeing', async () => {
    const linuxOld = (call: Call): Partial<CommandResult> | undefined => {
      const text = joined(call);
      if (text.startsWith('info --format {{.OperatingSystem}}')) {
        return { stdout: 'Ubuntu 24.04.3 LTS\n' };
      }
      if (call.command === 'uname') {
        return { stdout: '6.8.0-1-generic\n' };
      }
      if (call.command === 'findmnt') {
        return { stdout: `ext4 ${String(16 * 2 ** 30)}\n` };
      }
      if (call.command === 'find') {
        return { stdout: '/var/lib/aman-slots/aman/ws-3\n/var/lib/aman-slots/aman/ws-3.img\n' };
      }
      if (text.startsWith('volume inspect')) {
        return { stdout: `/var/lib/aman-slots/aman/ws-${call.args[call.args.length - 1]?.slice(-1) ?? ''}\n` };
      }
      return undefined;
    };
    // Without --fix the disks are cleanup the run cannot do: they stay, the slots still start, and the
    // result warns about the disks instead of failing.
    const withoutFix = await run(linuxOld, false, { platform: 'linux' });
    expect(withoutFix.result.ok).toBe(true);
    expect(
      withoutFix.result.ok &&
        withoutFix.result.warnings.some(warning => warning.includes('disks of the extra sandboxes')),
    ).toBe(true);
    expect(withoutFix.calls.some(call => call.command === 'sudo')).toBe(false);

    const questions: string[] = [];
    const fixed = await run(linuxOld, true, {
      platform: 'linux',
      confirm: question => {
        questions.push(question);
        return Promise.resolve(true);
      },
    });
    expect(fixed.result.ok).toBe(true);
    expect(questions.some(question => question.includes('remove the disks of the extra sandboxes'))).toBe(true);
    expect(fixed.calls.map(call => call.args)).toContainEqual([
      'sh',
      '/repo/ops/sandbox-slot/disks/setup-disks.sh',
      'retire',
      '/var/lib/aman-slots/aman',
      String(SLOT_COUNT),
    ]);

    // Saying no to the cleanup also leaves the disks and lets the run finish, with the same warning.
    const declined = await run(linuxOld, true, { platform: 'linux', confirm: () => Promise.resolve(false) });
    expect(declined.result.ok).toBe(true);
    expect(
      declined.result.ok && declined.result.warnings.some(warning => warning.includes('disks of the extra sandboxes')),
    ).toBe(true);
    expect(declined.calls.some(call => call.command === 'sudo')).toBe(false);
    expect(declined.calls.some(call => call.args.includes('retire'))).toBe(false);
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
      ['sh', '/repo/ops/sandbox-slot/disks/setup-disks.sh', 'setup', ROOT, '16', String(SLOT_COUNT)],
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
    expect(withoutFix.calls.some(call => joined(call).startsWith('volume rm --force'))).toBe(false);
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
    expect(wsl.result).toMatchObject({ ok: true, disk: { mode: 'vm' }, warnings: [] });
    expect(desktop.result).toMatchObject({ warnings: [] });
    for (const { calls } of [desktop, wsl]) {
      expect(calls.some(call => call.command === 'sudo' || call.command === 'findmnt')).toBe(false);
      // The agents are told the VM bounds the disk, so their attestation reports it.
      expect(calls.find(call => joined(call).includes('up -d'))?.env['AMAN_SLOTS_DISK_MODE']).toBe('vm');
    }
  });

  test('--no-hard-disk-limit skips the disks and warns that the machine is unprotected', async () => {
    const { result, calls } = await run(host({ disks: false }), false, { ...linux, hardDiskLimit: false });
    expect(result).toMatchObject({ ok: true, disk: { mode: 'off' } });
    expect(result.ok && result.warnings.join(' ')).toContain('pnpm sandbox:slots --fix');
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

describe('runSandboxSlots modes', () => {
  test('--check builds and starts nothing and never asks for sudo', async () => {
    const { result, calls } = await run(() => undefined, true, { mode: 'check' });
    expect(result.ok).toBe(true);
    const text = calls.map(joined);
    expect(text.some(line => line.includes('compose') && /\b(build|up)\b/.test(line))).toBe(false);
    expect(text.some(line => line.startsWith('image inspect'))).toBe(true);
    expect(text.filter(line => line.includes('aman-slot-agent healthcheck'))).toHaveLength(SLOT_COUNT);
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
  });

  test('--check shows the plain failure line of an unhealthy slot, word for word, and reads it out loud', async () => {
    const { result, calls } = await run(
      call => {
        const text = joined(call);
        if (text.includes('sandbox-2') && text.includes('healthcheck')) {
          return { exitCode: 1, stderr: 'Error response from daemon: container is not running' };
        }
        if (text.includes(' logs ')) {
          return {
            stdout:
              'sandbox-2-1  | 2026-10-10 11:58:00 attestation FAILED network: interfaces: eth0 has a route off this computer',
          };
        }
        return undefined;
      },
      false,
      { mode: 'check', command: 'aman doctor sandbox' },
    );
    expect(result).toMatchObject({ ok: false, step: 'attest' });
    expect(!result.ok && result.error).toContain(
      'Safety check network failed: interfaces: eth0 has a route off this computer',
    );
    expect(!result.ok && result.error).not.toContain('attestation FAILED');
    expect(
      calls.some(
        call =>
          call.echo &&
          joined(call).includes('Safety check network failed: interfaces: eth0 has a route off this computer'),
      ),
    ).toBe(true);
  });

  test("--check says where the missing image is built, in the caller's own command", async () => {
    const { result } = await run(
      call => (joined(call).startsWith('image inspect') ? { exitCode: 1 } : undefined),
      false,
      {
        mode: 'check',
        command: 'aman doctor sandbox',
      },
    );
    expect(result).toMatchObject({ ok: false, step: 'build', fix: 'Run aman doctor sandbox --fix to build it.' });
  });

  test('--check on a host with AppArmor fails without loading the profile when it is not loaded', async () => {
    const { result, calls } = await run(
      call => {
        const text = joined(call);
        if (text.startsWith('info') && text.includes('SecurityOptions')) {
          return { stdout: '["name=apparmor","name=seccomp,profile=builtin"]' };
        }
        if (text.startsWith('run --rm')) {
          return { exitCode: 125 };
        }
        return undefined;
      },
      true,
      { mode: 'check', command: 'aman doctor sandbox' },
    );
    expect(result).toMatchObject({ ok: false, step: 'apparmor' });
    expect(!result.ok && result.fix).toContain('aman doctor sandbox --fix');
    expect(calls.some(call => call.command === 'sudo')).toBe(false);
  });

  test('--build-only builds the image and stops before the profile, the disks and the slots', async () => {
    const { result, calls } = await run(() => undefined, false, { mode: 'build' });
    expect(result.ok).toBe(true);
    const text = calls.map(joined);
    expect(text.some(line => line.includes('build sandbox-1'))).toBe(true);
    expect(text.some(line => line.includes('up -d'))).toBe(false);
    expect(text.some(line => line.includes('aman-slot-agent healthcheck'))).toBe(false);
  });

  test('--restart recreates the slots', async () => {
    const { calls } = await run(() => undefined, false, { restart: true });
    expect(calls.map(joined).some(line => line.includes('up -d --no-build --force-recreate --wait'))).toBe(true);
  });

  test('fix lines quote the command the caller gave', async () => {
    const { result } = await run(
      call => {
        const text = joined(call);
        if (text.startsWith('info') && text.includes('OperatingSystem')) {
          return { stdout: 'Ubuntu 24.04' };
        }
        return undefined;
      },
      false,
      { command: 'aman doctor sandbox', platform: 'linux' },
    );
    expect(!result.ok && result.fix).toContain('aman doctor sandbox --fix');
    expect(!result.ok && result.fix).not.toContain('pnpm');
  });
});

describe('the package mirror folders of an earlier install', () => {
  /** Mirror volumes exist for the named slots; every other call answers as usual. */
  function mirrors(existing: number[]): (call: Call) => Partial<CommandResult> | undefined {
    return call => {
      if (joined(call).startsWith('volume inspect')) {
        const name = call.args[call.args.length - 1] ?? '';
        return existing.includes(Number(name.slice(-1)))
          ? { stdout: '[]\n' }
          : { exitCode: 1, stderr: 'no such volume' };
      }
      return undefined;
    };
  }

  test('existing mirror folders are handed to the app user in one throwaway container, after the build and before the slots start', async () => {
    const { result, calls } = await run(mirrors([1, 2]));
    expect(result.ok).toBe(true);
    const repairs = calls.filter(call => call.args[0] === 'run');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.args).toEqual([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--read-only',
      '-v',
      'aman_slot_mirror_1:/mirror-1',
      '-v',
      'aman_slot_mirror_2:/mirror-2',
      '--entrypoint',
      'chown',
      'amanuensis-sandbox-slot:local',
      '10001:10001',
      '/mirror-1',
      '/mirror-2',
    ]);
    const text = calls.map(joined);
    const repairAt = calls.findIndex(call => call.args[0] === 'run');
    expect(repairAt).toBeGreaterThan(text.findIndex(line => line.includes('build sandbox-1')));
    expect(repairAt).toBeLessThan(text.findIndex(line => line.includes('up -d')));
    expect(
      result.ok && result.checks.some(check => check.message.includes('mirror folders belong to the app user')),
    ).toBe(true);
  });

  test('only the mirror volumes that exist are handed over', async () => {
    const { result, calls } = await run(mirrors([2]));
    expect(result.ok).toBe(true);
    const repair = calls.find(call => call.args[0] === 'run');
    expect(repair?.args).toEqual(expect.arrayContaining(['-v', 'aman_slot_mirror_2:/mirror-1', '10001:10001']));
    expect(repair?.args.some(arg => arg.includes('_slot_mirror_1') || arg.includes('_slot_mirror_3'))).toBe(false);
    expect(repair?.args.some(arg => arg.includes('_slot_mirror_4'))).toBe(false);
  });

  test('with no mirror volumes yet, no repair container runs', async () => {
    const { result, calls } = await run(mirrors([]));
    expect(result.ok).toBe(true);
    expect(calls.some(call => call.args[0] === 'run')).toBe(false);
  });

  test('a repair that fails stops the run before the slots start', async () => {
    const { result, calls } = await run(call =>
      call.args[0] === 'run' ? { exitCode: 1, stderr: 'chown failed' } : mirrors([1, 2])(call),
    );
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(!result.ok && result.error).toContain('chown failed');
    expect(calls.some(call => joined(call).includes('up -d'))).toBe(false);
  });

  test("a named install's mirror volumes are the ones repaired", async () => {
    const { result, calls } = await run(mirrors([1, 2]), false, { instance: 'lab' });
    expect(result.ok).toBe(true);
    const repair = calls.find(call => call.args[0] === 'run');
    expect(repair?.args).toEqual(
      expect.arrayContaining(['-v', 'lab_slot_mirror_1:/mirror-1', '-v', 'lab_slot_mirror_2:/mirror-2']),
    );
  });

  test('a read-only check and a build never inspect or repair the mirror volumes', async () => {
    const checked = await run(mirrors([1, 2]), true, { mode: 'check' });
    expect(checked.result.ok).toBe(true);
    expect(checked.calls.some(call => joined(call).startsWith('volume inspect'))).toBe(false);
    expect(checked.calls.some(call => call.args[0] === 'run')).toBe(false);
    const built = await run(mirrors([1, 2]), false, { mode: 'build' });
    expect(built.result.ok).toBe(true);
    expect(built.calls.some(call => joined(call).startsWith('volume inspect'))).toBe(false);
  });
});
