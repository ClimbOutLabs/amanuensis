import type { RunCodeStatus } from '@/components/RunCodeStatusContext.js';

export type StatusTone = 'success' | 'warning' | 'failure' | 'neutral';

export interface RunCodeStatusPresentation {
  tone: StatusTone;
  /** Short pill label next to the status dot. */
  pill: string;
  headline: string;
  summary?: string;
  /** What the admin should do; absent when nothing is needed. */
  fix?: string;
}

/** The one repair command, shown for every sandbox problem. */
const FIX = 'Run `aman doctor sandbox --fix` on the computer that runs Aman, then press Re-check.';

export function presentRunCodeStatus(status: RunCodeStatus): RunCodeStatusPresentation {
  if (status.state === 'ready') {
    return { tone: 'success', pill: 'Ready', headline: 'Sealed sandbox: ready' };
  }
  if (status.backend === 'slots' && status.state === 'isolation_refused') {
    return {
      tone: 'failure',
      pill: 'Off',
      headline: 'Sealed sandbox: failed its safety check',
      summary: "The sandbox checks itself before every run and one check failed, so code won't run.",
      fix: FIX,
    };
  }
  if (status.backend === 'slots') {
    return {
      tone: 'failure',
      pill: 'Off',
      headline: 'Sealed sandbox: not running',
      summary: "Aman can't reach the sandbox, so code won't run.",
      fix: FIX,
    };
  }
  return {
    tone: 'failure',
    pill: 'Off',
    headline: 'Sealed sandbox: not ready',
    summary: "This server is set to an older developer sandbox that isn't ready, so code won't run.",
    fix: FIX,
  };
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
