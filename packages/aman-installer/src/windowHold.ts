import type { WindowsJobs } from './host/windowsJobs.ts';

// Whether to keep the window open at the end, until the person presses
// Enter. A double-click or a Start menu entry gives this program a
// window of its own that Windows closes the moment it ends, so without
// the wait every result, and every problem with its next step, would
// flash past unread. A terminal stays open by itself, and a scheduled
// task or a pipe has no one to read the window, so neither waits. Aman
// opening in the browser is its own answer, so a successful open does
// not hold its window either.
export async function shouldHoldWindow({
  hostKind,
  interactive,
  command,
  exitCode,
  parentPid,
  jobs,
}: {
  hostKind: string;
  interactive: boolean;
  command: string | undefined;
  exitCode: number;
  parentPid: number;
  jobs: Pick<WindowsJobs, 'startedFromExplorer'>;
}): Promise<boolean> {
  if (hostKind !== 'windows' || !interactive) {
    return false;
  }
  if (command === 'open' && exitCode === 0) {
    return false;
  }
  return jobs.startedFromExplorer(parentPid);
}
