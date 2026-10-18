import { createDemoSeed, type DemoSeedDeps } from '../../../../src/cli/demoSeed';
import type { ResetReport, SeedReport } from '../../../../src/cli/demoSeed/seed';
import type { DemoSeedSession } from '../../../../src/cli/demoSeed/session';
import { runCli } from '../../../../src/cli/dispatch';
import { UsageError, type CliIo } from '../../../../src/cli/io';

const NOW = new Date('2026-10-26T08:00:00Z');
const SEED_REPORT: SeedReport = {
  personas: { 'demo-synthetic-persona-june': 'created', 'demo-synthetic-persona-theo': 'created' },
  profile: 'created',
  agent: 'created',
  schedule: 'created',
  spaces: { created: 1, updated: 0, unchanged: 0 },
  knowledge: { created: 11, unchanged: 0, removed: 0, still_indexing: 0 },
  memory: { created: 22, updated: 0, unchanged: 0, removed: 0 },
};
const RESET_REPORT: ResetReport = {
  personas: 2,
  profile: 1,
  agent: 1,
  schedule: 1,
  sessions: 0,
  spaces: 1,
  memory: 22,
};

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readStdin: () => Promise.resolve(''),
    stdout: text => {
      out.push(text);
      return Promise.resolve();
    },
    stderr: text => {
      err.push(text);
      return Promise.resolve();
    },
  };
  return { io, out, err };
}

function fakeDeps({ enabled, models = ['demo-provider/demo-model'] }: { enabled: boolean; models?: string[] }) {
  const calls: { seed: unknown[]; reset: unknown[]; opened: number; closed: number } = {
    seed: [],
    reset: [],
    opened: 0,
    closed: 0,
  };
  const session: DemoSeedSession = {
    models,
    seed: input => {
      calls.seed.push(input);
      return Promise.resolve(SEED_REPORT);
    },
    reset: input => {
      calls.reset.push(input);
      return Promise.resolve(RESET_REPORT);
    },
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
  };
  const deps: DemoSeedDeps = {
    now: () => NOW,
    demoModeEnabled: () => Promise.resolve(enabled),
    open: () => {
      calls.opened += 1;
      return Promise.resolve(session);
    },
  };
  return { deps, calls };
}

describe('aman demo-seed', () => {
  it('refuses to run unless DEMO_MODE is true, without opening the database', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const { io, err, out } = fakeIo();

    const code = await createDemoSeed(deps)({ args: [], io });

    expect(code).toBe(1);
    expect(err.join('')).toContain('DEMO_MODE is not true');
    expect(out).toEqual([]);
    expect(calls).toEqual({ seed: [], reset: [], opened: 0, closed: 0 });
  });

  it('also refuses --reset on a non-demo instance', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });

    expect(await createDemoSeed(deps)({ args: ['--reset'], io: fakeIo().io })).toBe(1);
    expect(calls.reset).toEqual([]);
    expect(calls.opened).toBe(0);
  });

  it('seeds with the defaults and prints the report as JSON', async () => {
    const { deps, calls } = fakeDeps({ enabled: true });
    const { io, out } = fakeIo();

    expect(await createDemoSeed(deps)({ args: [], io })).toBe(0);

    expect(calls.seed).toEqual([
      {
        userId: 'judge@example.com',
        now: NOW,
        timeZone: 'Europe/Lisbon',
        modelName: 'demo-provider/demo-model',
        today: undefined,
      },
    ]);
    expect(calls.closed).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ action: 'seed', user: 'judge@example.com', report: SEED_REPORT });
  });

  it('takes the user, zone and model from the options', async () => {
    const { deps, calls } = fakeDeps({ enabled: true, models: ['a/one', 'b/two'] });

    const args = ['--user', 'maria@example.com', '--timezone', 'America/New_York', '--model', 'b/two'];
    expect(await createDemoSeed(deps)({ args, io: fakeIo().io })).toBe(0);

    expect(calls.seed).toEqual([
      { userId: 'maria@example.com', now: NOW, timeZone: 'America/New_York', modelName: 'b/two', today: undefined },
    ]);
  });

  it('--today seeds a fixed day for rehearsals and says so', async () => {
    const { deps, calls } = fakeDeps({ enabled: true });
    const { io, err, out } = fakeIo();

    expect(await createDemoSeed(deps)({ args: ['--today', '2026-10-19'], io })).toBe(0);

    expect(calls.seed).toEqual([
      expect.objectContaining({ today: { year: 2026, month: 10, day: 19 }, timeZone: 'Europe/Lisbon' }),
    ]);
    expect(err.join('')).toContain('pretending today is 2026-10-19');
    expect(JSON.parse(out.join(''))).toMatchObject({ action: 'seed', today: '2026-10-19' });
  });

  it('tells the operator when knowledge documents are still indexing', async () => {
    const { deps } = fakeDeps({ enabled: true });
    const slow: DemoSeedDeps = {
      ...deps,
      open: async () => ({
        ...(await deps.open()),
        seed: () =>
          Promise.resolve({ ...SEED_REPORT, knowledge: { created: 11, unchanged: 0, removed: 0, still_indexing: 4 } }),
      }),
    };
    const { io, err } = fakeIo();

    expect(await createDemoSeed(slow)({ args: [], io })).toBe(0);

    expect(err.join('')).toContain('4 knowledge document(s) are still indexing; restart the app to finish them.');
  });

  it('--reset removes the synthetic records and does not seed', async () => {
    const { deps, calls } = fakeDeps({ enabled: true });
    const { io, out } = fakeIo();

    expect(await createDemoSeed(deps)({ args: ['--reset', '--user', 'maria@example.com'], io })).toBe(0);

    expect(calls.reset).toEqual([{ userId: 'maria@example.com' }]);
    expect(calls.seed).toEqual([]);
    expect(calls.closed).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ action: 'reset', removed: RESET_REPORT });
  });

  it('closes the session even when seeding fails', async () => {
    const { deps, calls } = fakeDeps({ enabled: true });
    const failing: DemoSeedDeps = {
      ...deps,
      open: async () => ({
        ...(await deps.open()),
        seed: () => Promise.reject(new Error('disk full')),
      }),
    };

    await expect(createDemoSeed(failing)({ args: [], io: fakeIo().io })).rejects.toThrow('disk full');
    expect(calls.closed).toBe(1);
  });

  it('asks for a model provider when none is configured', async () => {
    const { deps } = fakeDeps({ enabled: true, models: [] });

    await expect(createDemoSeed(deps)({ args: [], io: fakeIo().io })).rejects.toThrow('No model is configured');
  });

  it.each([
    [['--model', 'nope/none'], 'Unknown model'],
    [['--timezone', 'Mars/Olympus'], 'Unknown time zone'],
    [['--today', '2026-02-30'], '--today must be a real day'],
    [['--today', 'tomorrow'], '--today must be a real day'],
    [['--today', '19/10/2026'], 'such as 2026-10-19'],
    [['--user', 'two words'], '--user'],
    [['--bogus'], 'bogus'],
  ])('rejects bad arguments %j as a usage error', async (args, message) => {
    const { deps, calls } = fakeDeps({ enabled: true });

    await expect(createDemoSeed(deps)({ args, io: fakeIo().io })).rejects.toThrow(UsageError);
    await expect(createDemoSeed(deps)({ args, io: fakeIo().io })).rejects.toThrow(message);
    expect(calls.seed).toEqual([]);
  });

  it('prints usage for --help without touching the instance', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const { io, err } = fakeIo();

    expect(await createDemoSeed(deps)({ args: ['--help'], io })).toBe(0);
    expect(err.join('')).toContain('Usage: aman demo-seed');
    expect(calls.opened).toBe(0);
  });
});

describe('aman dispatcher', () => {
  it('routes demo-seed and maps argument errors to exit code 2 before any config is loaded', async () => {
    const { io, err } = fakeIo();

    expect(await runCli({ argv: ['demo-seed', '--timezone', 'Mars/Olympus'], io })).toBe(2);
    expect(err.join('')).toContain('Unknown time zone');
  });

  it('lists demo-seed in its usage', async () => {
    const { io, err } = fakeIo();

    expect(await runCli({ argv: ['--help'], io })).toBe(0);
    expect(err.join('')).toContain('demo-seed');
  });
});
