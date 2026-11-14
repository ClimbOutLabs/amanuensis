'use client';

import { useEffect, useRef, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import { formatCount } from './memoryExplorer.js';
import type { MemoryReviewState } from './useMemoryReview.js';
import { MEMORY_PAGE_SIZE } from './useMemoryVaultState.js';

/** The notice shown above the memories when older notes can be reviewed. */
export function MemoryReviewNotice({ onReview }: { onReview: () => void }) {
  const assistant = useAssistantDisplayName();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card-bg p-4">
      <p className="text-sm text-text-primary">
        Some older notes have no record of where they came from. {assistant} treats them as external until you say they
        are yours.
      </p>
      <button type="button" onClick={onReview} className={auiButtonClass({ variant: 'secondary', size: 'small' })}>
        Review older notes
      </button>
    </div>
  );
}

/** Lists the older notes with a tick box each. Nothing is ticked at the start. */
export function MemoryReviewPanel({ review, onClose }: { review: MemoryReviewState; onClose: () => void }) {
  const assistant = useAssistantDisplayName();
  const [limit, setLimit] = useState(MEMORY_PAGE_SIZE);
  const heading = useRef<HTMLHeadingElement>(null);
  // The button that opened this view is gone, so focus moves to the heading.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const shown = review.notes.slice(0, limit);
  const tickedCount = review.ticked.size;

  return (
    <section aria-labelledby="memory-review-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="memory-review-heading"
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary outline-none"
        >
          Review older notes
        </h3>
        <button type="button" onClick={onClose} className={auiButtonClass({ variant: 'ghost', size: 'small' })}>
          Back to memories
        </button>
      </div>

      {review.error !== null ? (
        <p role="alert" className="text-sm text-error-text">
          {review.error}
        </p>
      ) : null}

      {review.outcome !== null ? (
        <div role="status" className="flex flex-col gap-1 rounded-xl border border-border bg-card-bg p-3">
          <p className="text-sm text-text-primary">
            {formatCount(review.outcome.markedCount)} {review.outcome.markedCount === 1 ? 'note' : 'notes'} marked as
            from you.
          </p>
          {review.outcome.refused.length > 0 ? (
            <>
              <p className="text-sm text-text-primary">These notes were left as they are.</p>
              <ul className="m-0 list-disc pl-5">
                {review.outcome.refused.map(item => (
                  <li key={item.entryId} className="text-sm text-text-secondary">
                    {item.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {review.notes.length === 0 ? (
        <p className="text-sm text-text-secondary">No older notes are waiting for review.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => review.tickAll(shown.map(note => note.entryId))}
              className={auiButtonClass({ variant: 'secondary', size: 'small' })}
            >
              Tick all on this page
            </button>
            <span className="text-sm text-text-secondary" aria-live="polite">
              {formatCount(tickedCount)} ticked
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {shown.map(note => {
              const labelId = `memory-review-${note.entryId}`;
              return (
                <li key={note.entryId} className="flex gap-3 rounded-xl border border-border bg-card-bg p-4">
                  <input
                    type="checkbox"
                    checked={review.ticked.has(note.entryId)}
                    onChange={() => review.toggle(note.entryId)}
                    aria-labelledby={labelId}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p id={labelId} className="text-xs font-medium text-text-secondary">
                      {note.day}
                      {note.chatTitle === null ? '' : ` · ${note.chatTitle}`}
                    </p>
                    <p className="m-0 whitespace-pre-wrap break-words text-sm text-text-primary">{note.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          {review.notes.length > limit ? (
            <button
              type="button"
              onClick={() => setLimit(previous => previous + MEMORY_PAGE_SIZE)}
              className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'self-start')}
            >
              Show {formatCount(MEMORY_PAGE_SIZE)} more
            </button>
          ) : null}
          <p className="text-sm text-text-primary">
            {assistant} will treat these notes as your own words. It will act on them without asking as it does for
            things it read.
          </p>
          <button
            type="button"
            disabled={tickedCount === 0 || review.busy}
            onClick={() => void review.markTicked()}
            className={cn(auiButtonClass({ variant: 'primary', size: 'small' }), 'self-start')}
          >
            Mark the ticked notes as from me
          </button>
        </>
      )}

      {review.hasMore ? (
        <button
          type="button"
          onClick={() => void review.loadMore()}
          className={cn(auiButtonClass({ variant: 'secondary', size: 'small' }), 'self-start')}
        >
          Look at older notes
        </button>
      ) : null}
      <p className="text-sm text-text-secondary">
        Some older notes are not listed here. They came from a chat where {assistant} read something from outside, or
        you edited them, or their chat is gone.
      </p>
    </section>
  );
}
