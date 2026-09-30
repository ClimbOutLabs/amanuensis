'use client';

import { useState, type FC } from 'react';

import { Icon } from '../icons/Icon.js';
import { Button } from '../atoms/primitives/Button.js';
import type { Tier2Notice } from './types.js';

export type Tier2IndicatorProps = {
  notice: Tier2Notice;
  onUndo: () => Promise<void>;
  onStop: () => Promise<void>;
};

/**
 * Subtle non-blocking notice for an action that ran under Tier 2. The tool card
 * itself renders unchanged; this line names what ran, offers Undo when the server
 * marked the action undoable and Stop when it marked it stoppable, and lists the
 * tracked files when the server named any.
 */
export const Tier2Indicator: FC<Tier2IndicatorProps> = ({ notice, onUndo, onStop }) => {
  const [busy, setBusy] = useState<'undo' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'undo' | 'stop', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-secondary-bg/60 px-2.5 py-1.5 text-xs text-text-secondary">
      <Icon name="circle-check" className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.undoable && (
        <Button
          variant="secondary"
          size="small"
          disabled={busy !== null}
          onClick={() => void run('undo', onUndo)}
        >
          {busy === 'undo' ? 'Undoing…' : 'Undo'}
        </Button>
      )}
      {notice.stoppable && (
        <Button
          variant="secondary"
          size="small"
          disabled={busy !== null}
          onClick={() => void run('stop', onStop)}
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </Button>
      )}
      {notice.tracked_files.length > 0 && (
        <span className="w-full text-[0.6875rem] text-text-secondary">
          Tracked files: {notice.tracked_files.join(', ')}
        </span>
      )}
      {error !== null && (
        <span className="w-full text-[0.6875rem] text-failure-bg" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
