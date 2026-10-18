import { parseDateOnly } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';
import { parseArgs } from 'node:util';
import type { Command } from '../command';
import { UsageError, type CliIo } from '../io';
import type { DemoSeedSession } from './session';
import { DEFAULT_DEMO_TIME_ZONE, DEFAULT_DEMO_USER } from './world';

const USAGE = `Usage: aman demo-seed [--reset] [--user <email>] [--timezone <iana>] [--today <YYYY-MM-DD>] [--model <provider/model>]

Seeds one synthetic demo world for the demo user: Maya, a fictional designer who moved to Lisbon. It writes
two personas with knowledge libraries, memory notes, a Tasks space, and a Morning brief schedule. Her email and calendar are not seeded here; they live in her connected Google account. Every
record is marked demo_synthetic. Dates are relative to "today" in the user's time zone, so any day gives a
coherent week. Re-running it on the same day keeps the Tasks space as it is; --reset removes the synthetic
records. Needs DEMO_MODE=true.

  --reset              Remove the synthetic records only, then stop
  --user <email>       Demo user's login (default: ${DEFAULT_DEMO_USER})
  --timezone <iana>    Time zone that defines "today" (default: ${DEFAULT_DEMO_TIME_ZONE})
  --today <day>        Treat this day as "today", for rehearsing on a fixed day (default: the real today)
  --model <p/model>    Model for the personas and agent (default: first configured model)
`;

export interface DemoSeedDeps {
  now(): Date;
  demoModeEnabled(): Promise<boolean>;
  /** Opens the instance's stores; only called after the DEMO_MODE guard has passed. */
  open(): Promise<DemoSeedSession>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: DemoSeedDeps = {
  now: () => new Date(),
  demoModeEnabled: async () => (await import('./runtime')).isDemoModeEnabled(),
  open: async () => (await import('./runtime')).openDemoSeedSession(),
};

/** `parseArgs` errors are not `instanceof Error` everywhere (separate realms), so the message is read structurally. */
function argumentErrorMessage(error: unknown): string {
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
  return typeof message === 'string' && message !== '' ? message : 'Invalid arguments.';
}

function parseOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        reset: { type: 'boolean', default: false },
        user: { type: 'string' },
        timezone: { type: 'string' },
        today: { type: 'string' },
        model: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new UsageError(argumentErrorMessage(error), { cause: error });
  }
}

function pickModel({ requested, available }: { requested: string | undefined; available: readonly string[] }): string {
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new UsageError(`Unknown model "${requested}". Configured models: ${available.join(', ') || 'none'}.`);
    }
    return requested;
  }
  const [first] = available;
  if (first === undefined) {
    throw new Error('No model is configured yet. Add a model provider in Settings, then run demo-seed again.');
  }
  return first;
}

async function printJson({ io, value }: { io: CliIo; value: unknown }): Promise<void> {
  await io.stdout(`${JSON.stringify(value)}\n`);
}

export function createDemoSeed(deps: DemoSeedDeps): Command {
  return async ({ args, io }) => {
    const options = parseOptions(args);
    if (options.help) {
      await io.stderr(USAGE);
      return 0;
    }
    const userId = (options.user ?? DEFAULT_DEMO_USER).trim();
    if (userId === '' || /\s/.test(userId)) {
      throw new UsageError('--user must be a login email without spaces.');
    }
    const timeZone = options.timezone ?? DEFAULT_DEMO_TIME_ZONE;
    if (!isValidTimezone(timeZone)) {
      throw new UsageError(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/Lisbon.`);
    }

    const today = options.today === undefined ? undefined : parseDateOnly(options.today);
    if (options.today !== undefined && today === undefined) {
      throw new UsageError('--today must be a real day written YYYY-MM-DD, such as 2026-10-26.');
    }

    if (!(await deps.demoModeEnabled())) {
      await io.stderr('Refusing to seed: DEMO_MODE is not true. This command only runs on a demo instance.\n');
      return 1;
    }

    const session = await deps.open();
    try {
      if (options.reset) {
        const removed = await session.reset({ userId });
        await io.stderr(`Removed the synthetic demo records for ${userId}.\n`);
        await printJson({ io, value: { action: 'reset', user: userId, removed } });
        return 0;
      }
      const modelName = pickModel({ requested: options.model, available: session.models });
      const report = await session.seed({ userId, now: deps.now(), timeZone, modelName, today });
      await io.stderr(
        `Seeded the synthetic demo world for ${userId} (${options.today === undefined ? `today in ${timeZone}` : `pretending today is ${options.today}`}).\n`,
      );
      if (report.knowledge.still_indexing > 0) {
        await io.stderr(
          `${String(report.knowledge.still_indexing)} knowledge document(s) are still indexing; restart the app to finish them.\n`,
        );
      }
      await printJson({
        io,
        value: {
          action: 'seed',
          user: userId,
          time_zone: timeZone,
          today: options.today ?? null,
          model: modelName,
          report,
        },
      });
      return 0;
    } finally {
      await session.close();
    }
  };
}

export const demoSeed: Command = createDemoSeed(lazyDeps);
