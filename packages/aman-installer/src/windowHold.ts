import type { WindowsJobs } from './host/windowsJobs.ts';

// The commands only the scheduled tasks run. A task's window has no one
// in front of it, so it must close by itself when the job ends.
const SCHEDULED_COMMANDS: ReadonlySet<string> = new Set(['backup']);

// Whether to keep the window open at the end, until the person presses
// Enter. When this program is the only one using its console window,
// Windows closes that window the moment it ends, so without the wait
// every result, and every problem with its next step, would flash past
// unread. That is the case however the person started it: a double-click
// in Explorer or in a browser's download list, a Start menu entry or
// Windows Search. A terminal's shell shares the console and keeps it
// open, and a pipe or a redirect has no one to read it, so neither
// waits. A scheduled task never waits. Aman opening in the browser is
// its own answer, so a successful open does not hold its window either.
export async function shouldHoldWindow({
  hostKind,
  interactive,
  command,
  exitCode,
  selfPid,
  jobs,
}: {
  hostKind: string;
  interactive: boolean;
  command: string | undefined;
  exitCode: number;
  selfPid: number;
  jobs: Pick<WindowsJobs, 'ownsItsConsole'>;
}): Promise<boolean> {
  if (hostKind !== 'windows' || !interactive) {
    return false;
  }
  if (command !== undefined && SCHEDULED_COMMANDS.has(command)) {
    return false;
  }
  if (command === 'open' && exitCode === 0) {
    return false;
  }
  return jobs.ownsItsConsole(selfPid);
}
