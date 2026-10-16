'use client';

import type { FC, ReactNode } from 'react';

export const NEEDS_YOUR_OK_TITLE = 'Needs your OK';
export const NEEDS_YOUR_OK_INTRO = 'Aman held these for you. Nothing has been done yet.';

export function notSavedText(count: number): string {
  const actions = count === 1 ? "1 more action wasn't" : `${count} more actions weren't`;
  return `${actions} saved because too many were waiting. Ask again in chat if you need ${count === 1 ? 'it' : 'them'}.`;
}

/** Said for actions the run could not keep for the owner, so nothing it wanted done goes unmentioned. */
export const NotSavedNote: FC<{ count: number }> = ({ count }) => (
  <p className="mt-3 text-sm text-text-secondary" data-role="held-not-saved">
    {notSavedText(count)}
  </p>
);

/**
 * The block a finished scheduled run ends with. The app writes it from the actions the run held, so
 * the model cannot leave one out or add one; its own words stay in the message above.
 */
export const NeedsYourOk: FC<{ children: ReactNode; notSavedCount?: number }> = ({ children, notSavedCount = 0 }) => (
  <section
    aria-labelledby="needs-your-ok-title"
    data-role="needs-your-ok"
    className="mt-4 rounded-lg border border-primary-button-bg/30 bg-primary-button-bg/10 p-3 sm:p-4"
  >
    <h3 id="needs-your-ok-title" className="text-sm font-semibold text-text-primary">
      {NEEDS_YOUR_OK_TITLE}
    </h3>
    <p className="mt-1 text-sm text-text-secondary">{NEEDS_YOUR_OK_INTRO}</p>
    <ul className="mt-3 list-none space-y-3 p-0">{children}</ul>
    {notSavedCount > 0 && <NotSavedNote count={notSavedCount} />}
  </section>
);
