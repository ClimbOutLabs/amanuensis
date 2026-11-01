import type { SystemKind } from '../host/host.ts';
import type { InstallerEvent } from './events.ts';

// The checks screen's rows, read from a preflight dry run's event stream:
// the events of the run's first phase ("Checking this computer"), in
// order. A quick check reports itself with a step_result; a problem
// reports itself with a warning that carries the problem and the one fix.
// The stream does not mark a warning as warn or block (the terminal tells
// them apart by color), so the run's own ending decides: a dry run that
// ends failed was stopped by its problems, and its warnings are blocks;
// a dry run that ends well leaves its warnings as warnings. When a block
// and a warning stand together, the warning shows as a block until the
// block is fixed and the check runs again, which is the safe direction:
// Install stays unclickable while anything might block it.

export type CheckRowState = 'pass' | 'warn' | 'block' | 'offer' | 'note';

export interface CheckRow {
  id: string;
  name: string;
  state: CheckRowState;
  fix: string | null;
}

export interface ChecksResult {
  rows: CheckRow[];
  blocked: boolean;
  dockerInstallOffered: boolean;
}

export function checkRows(input: {
  events: readonly InstallerEvent[];
  runFailed: boolean;
  hostKind: SystemKind;
  finalVerdict: string | null;
}): ChecksResult {
  const rows: CheckRow[] = [];
  let dockerInstallOffered = false;
  let phaseSeen = 0;
  for (const event of input.events) {
    if (event.type === 'phase_start') {
      phaseSeen += 1;
      continue;
    }
    if (phaseSeen !== 1) {
      continue;
    }
    if (event.type === 'step_result' && event.result === 'done') {
      rows.push({ id: `c${String(rows.length)}`, name: event.name, state: 'pass', fix: null });
    } else if (event.type === 'step_result' && event.result === 'skipped') {
      if (input.hostKind === 'linux' && event.name.includes('Docker is not installed yet')) {
        dockerInstallOffered = true;
        rows.push({ id: `c${String(rows.length)}`, name: event.name, state: 'offer', fix: null });
      } else {
        rows.push({ id: `c${String(rows.length)}`, name: event.name, state: 'note', fix: null });
      }
    } else if (event.type === 'warning') {
      rows.push({
        id: `c${String(rows.length)}`,
        name: event.text,
        state: input.runFailed ? 'block' : 'warn',
        fix: event.next,
      });
    }
  }
  let blocked = rows.some(row => row.state === 'block');
  if (input.runFailed && !blocked) {
    // The run stopped and no row says why: say so as a block, in the
    // run's own closing words, rather than letting the screen look ready.
    rows.push({
      id: `c${String(rows.length)}`,
      name: input.finalVerdict ?? 'The checks could not finish.',
      state: 'block',
      fix: null,
    });
    blocked = true;
  }
  return { rows, blocked, dockerInstallOffered };
}
