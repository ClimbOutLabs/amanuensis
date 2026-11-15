import { parseArgs } from 'node:util';
import type { Command } from '../command';
import { UsageError, type CliIo } from '../io';
import type { MemoryExampleResult } from './replace';

const USAGE = `Usage: aman memory-example --replace

Fills the memory of this instance with about two years of made-up notes, so you can try how old and new
memories are used. The notes are dated back from today. The memory that is there now is not deleted: it is
moved to a folder named .set-aside inside the memory folder, and the command prints where. Do not chat
while it runs, and restart Aman after it finishes.

  --replace   Required. Says you want the current memory moved aside and replaced
`;

export interface MemoryExampleDeps {
  now(): Date;
  /** Sets this instance's memory aside and writes the example notes dated back from `now`. */
  replace(input: { now: Date }): Promise<MemoryExampleResult>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: MemoryExampleDeps = {
  now: () => new Date(),
  replace: async ({ now }) => {
    const [{ default: configuration }, { TENANT_ID }, { replaceMemoryWithExample }] = await Promise.all([
      import('../../config'),
      import('../../tenancy'),
      import('./replace'),
    ]);
    return replaceMemoryWithExample({ baseDir: configuration.MEMORY_MARKDOWN_DIR, namespace: TENANT_ID, now });
  },
};

function parseOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new UsageError('memory-example takes only --replace. Run it with --help to see what it does.', {
      cause: error,
    });
  }
}

async function printJson({ io, value }: { io: CliIo; value: unknown }): Promise<void> {
  await io.stdout(`${JSON.stringify(value)}\n`);
}

export function createMemoryExample(deps: MemoryExampleDeps): Command {
  return async ({ args, io }) => {
    const options = parseOptions(args);
    if (options.help) {
      await io.stderr(USAGE);
      return 0;
    }
    if (!options.replace) {
      throw new UsageError(
        'This moves the memory of this instance aside and puts made-up notes in its place. Nothing was changed. Run it again with --replace to go ahead.',
      );
    }
    const { notes, setAside } = await deps.replace({ now: deps.now() });
    await io.stderr(
      setAside === null
        ? `There was no memory to move. Wrote ${String(notes)} example notes. Restart Aman now.\n`
        : `Moved the memory that was there to ${setAside}. Wrote ${String(notes)} example notes. Restart Aman now.\n`,
    );
    await printJson({ io, value: { notes, set_aside: setAside } });
    return 0;
  };
}

export const memoryExample: Command = createMemoryExample(lazyDeps);
