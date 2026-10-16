'use client';

import type { FC, ReactNode } from 'react';

export const NEEDS_YOUR_OK_TITLE = 'Needs your OK';
export const NEEDS_YOUR_OK_INTRO = 'Aman held these for you. Nothing has been done yet.';

/**
 * The block a finished scheduled run ends with. The app writes it from the actions the run held, so
 * the model cannot leave one out or add one; its own words stay in the message above.
 */
export const NeedsYourOk: FC<{ children: ReactNode }> = ({ children }) => (
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
  </section>
);
