import {
  CommandNotFoundError,
  runSandboxSlots,
  SLOT_COUNT,
  type CommandResult,
  type CommandRunner,
  type SlotsResult,
} from '../../../../scripts/sandbox-slots/slots';

const OK: CommandResult = { stdout: '', stderr: '', exitCode: 0 };

interface Call {
  command: string;
  args: string[];
}

/** A scripted docker: `respond` returns the result for a call, or undefined to answer success. */
function fakeRunner(respond: (call: Call) => Partial<CommandResult> | Error | undefined): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = input => {
    const call = { command: input.command, args: input.args };
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

async function run(
  respond: (call: Call) => Partial<CommandResult> | Error | undefined,
  fix = false,
): Promise<{
  result: SlotsResult;
  calls: Call[];
}> {
  const { run: runner, calls } = fakeRunner(call => respond(call) ?? defaultAnswers(call));
  const result = await runSandboxSlots({ repoRoot: '/repo', run: runner, fix, instance: 'aman', onCheck: undefined });
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
      return Promise.resolve({ ...OK, ...defaultAnswers({ command: input.command, args: input.args }) });
    };
    const result = await runSandboxSlots({
      repoRoot: '/repo',
      run: runner,
      fix: false,
      instance: 'lab',
      onCheck: undefined,
    });
    expect(result.ok).toBe(true);
    const compose = seen.filter(entry => entry.args[0] === 'compose' && entry.args[1] !== 'version');
    expect(compose.length).toBeGreaterThan(0);
    for (const entry of compose) {
      expect(entry.args).toEqual(expect.arrayContaining(['-p', 'lab-slots']));
      expect(entry.env).toEqual({ AMAN_SLOTS_INSTANCE: 'lab' });
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
