import { parseArgs } from 'node:util';

import { z } from 'zod';

import type { Command } from '../command';
import { UsageError } from '../io';
import { processDeps, type DoctorDeps } from './deps';
import { INSTANCE_CHECK_IDS, runInstanceChecks } from './run';
import { CheckSchema, type Check } from './schemas';

const USAGE = 'Usage: amanuensis doctor [--json | --text] [--only <check>] [--deep]';

interface DoctorOptions {
  text: boolean;
  deep: boolean;
  only: string | undefined;
}

function parseOptions(args: readonly string[]): DoctorOptions {
  let values: { json?: boolean; text?: boolean; deep?: boolean; only?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        json: { type: 'boolean' },
        text: { type: 'boolean' },
        deep: { type: 'boolean' },
        only: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n${USAGE}`, {
      cause: error,
    });
  }
  if (values.json === true && values.text === true) {
    throw new UsageError(`Use either --json or --text, not both.\n${USAGE}`);
  }
  const only = values.only;
  if (only !== undefined && !INSTANCE_CHECK_IDS.some(id => id === only)) {
    throw new UsageError(`Unknown check "${only}". Checks: ${INSTANCE_CHECK_IDS.join(', ')}.`);
  }
  return { text: values.text === true, deep: values.deep === true, only };
}

function singleLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

/** One check per line: id, state, detail, fix, tab separated, for the host shim to relay. */
function renderText(checks: readonly Check[]): string {
  return checks.map(c => [c.id, c.state, singleLine(c.detail), singleLine(c.fix)].join('\t')).join('\n') + '\n';
}

export function createDoctor(deps: DoctorDeps): Command {
  return async ({ args, io }) => {
    const options = parseOptions(args);
    const checks = z
      .array(CheckSchema)
      .parse(await runInstanceChecks({ deps, deep: options.deep, only: options.only }));
    await io.stdout(options.text ? renderText(checks) : `${JSON.stringify(checks)}\n`);
    return checks.some(check => check.state === 'fail') ? 1 : 0;
  };
}

export const doctor: Command = createDoctor(processDeps());
