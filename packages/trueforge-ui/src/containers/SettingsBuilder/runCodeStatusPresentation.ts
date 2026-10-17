import type { RunCodeStatus } from '@/components/RunCodeStatusContext.js';

export type StatusTone = 'success' | 'warning' | 'failure' | 'neutral';

export interface RunCodeStatusPresentation {
  tone: StatusTone;
  /** Short pill label next to the status dot. */
  pill: string;
  headline: string;
  summary: string;
  /** What the admin should do; absent when nothing is needed. */
  fix?: string;
  /** Server setting names behind this state, shown under Technical details rather than in the advice. */
  settings?: string;
}

/** The one repair command, shown for every sandbox-slot problem. */
const SLOTS_FIX = 'Run `aman doctor sandbox --fix` on the machine that runs Aman, then press Re-check.';

/** Wording for the isolated sandbox slots. */
function presentSlotsStatus(status: RunCodeStatus): RunCodeStatusPresentation {
  switch (status.state) {
    case 'ready':
      return {
        tone: 'success',
        pill: 'Ready',
        headline: 'Code execution is on',
        summary:
          'The assistant can run Python, Node.js and shell commands. Each command starts in a fresh, isolated sandbox with no network access.',
      };
    case 'isolation_refused':
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox could not prove it is safe',
        summary:
          'Before it runs anything, the sandbox checks its own safety limits, such as no network access and no extra privileges. One of those checks failed, so it refuses to run code.',
        fix: SLOTS_FIX,
      };
    default:
      return {
        tone: 'failure',
        pill: 'Off',
        headline: 'Code execution is off: the sandbox is not running',
        summary: 'The server could not reach the sandbox that runs code, so the assistant cannot run any.',
        fix: SLOTS_FIX,
      };
  }
}

export function presentRunCodeStatus(status: RunCodeStatus): RunCodeStatusPresentation {
  if (status.state === 'not_configured') {
    return {
      tone: 'neutral',
      pill: 'Off',
      headline: 'Code execution is off: the sandbox is not set up',
      summary: 'This server is not set up with the isolated sandbox, so the assistant cannot run code.',
      fix: SLOTS_FIX,
      settings: 'SANDBOX_BACKEND',
    };
  }
  return presentSlotsStatus(status);
}

/** Whole GB when the value divides evenly, MB otherwise. */
export function formatMegabytes(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${String(mb / 1024)} GB` : `${String(mb)} MB`;
}

/** Whole minutes when the value divides evenly, seconds otherwise. */
export function formatSeconds(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${String(seconds / 60)} min` : `${String(seconds)} s`;
}

/** "just now" under a minute, then whole minutes, then whole hours. */
export function formatCheckedAgo({ checkedAt, now }: { checkedAt: number; now: number }): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  return `${String(Math.floor(minutes / 60))} h ago`;
}
