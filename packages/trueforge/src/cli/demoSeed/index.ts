import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';
import { parseArgs } from 'node:util';
import type { Command } from '../command';
import { UsageError, type CliIo } from '../io';
import type { DemoSeedSession } from './session';
import { parseDemoDay } from './storyDays.mjs';
import { DEFAULT_DEMO_TIME_ZONE, DEFAULT_DEMO_USER } from './world';

const USAGE = `Usage: aman demo-seed [--reset | --fresh] [--user <email>] [--timezone <iana>] [--today <YYYY-MM-DD>] [--model <provider/model>]

Seeds one synthetic demo world for the demo user: Maya, a fictional designer who moved to Lisbon. It writes
two personas with knowledge libraries, memory notes, a Tasks space, and a Morning brief schedule. Her email and calendar are not seeded here; they live in her connected Google account. Every
record is marked demo_synthetic. Every date in her world is counted from "today", so the tasks, notes and her
mail (made with pnpm demo:import-mailbox) always line up with the day. Re-running it rewrites the Tasks space to that
day's list; --reset removes the synthetic records. --fresh removes everything the demo user made, then seeds again. Needs DEMO_MODE=true.

  --reset              Remove the synthetic records only, then stop
  --fresh              Remove everything the user made (chats, spaces, memory, schedules, personas, profile, files), then seed
  --user <email>       Demo user's login (default: ${DEFAULT_DEMO_USER})
  --timezone <iana>    Time zone that defines "today" (default: ${DEFAULT_DEMO_TIME_ZONE})
  --today <day>        Treat this day as "today", such as 2026-10-19 (default: the real today in the time zone)
  --model <p/model>    Model for the personas and agent (default: first configured model)
`;

/** The `--today` day, or undefined when the flag is absent. */
function parseToday(text: string | undefined): CalendarDay | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    return parseDemoDay(text);
  } catch (error) {
    throw new UsageError('--today must be a real day written YYYY-MM-DD, such as 2026-10-19.', { cause: error });
  }
}

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
        fresh: { type: 'boolean', default: false },
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
    if (options.fresh && options.reset) {
      throw new UsageError('Use either --fresh or --reset, not both.');
    }
    const userId = (options.user ?? DEFAULT_DEMO_USER).trim();
    if (userId === '' || /\s/.test(userId)) {
      throw new UsageError('--user must be a login email without spaces.');
    }
    const timeZone = options.timezone ?? DEFAULT_DEMO_TIME_ZONE;
    if (!isValidTimezone(timeZone)) {
      throw new UsageError(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/Lisbon.`);
    }

    const today = parseToday(options.today);

    if (!(await deps.demoModeEnabled())) {
      await io.stderr(
        options.fresh
          ? 'Start fresh only works on a demo instance. Nothing was removed.\n'
          : 'Refusing to seed: DEMO_MODE is not true. This command only runs on a demo instance.\n',
      );
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
      // Picked before anything is removed, so a missing model never leaves an empty instance.
      const modelName = pickModel({ requested: options.model, available: session.models });
      const removed = options.fresh ? await session.fresh({ userId }) : undefined;
      if (removed !== undefined) {
        await io.stderr(`Removed everything ${userId} made.\n`);
      }
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
          action: options.fresh ? 'fresh' : 'seed',
          user: userId,
          time_zone: timeZone,
          today: options.today ?? null,
          model: modelName,
          removed: removed ?? null,
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
