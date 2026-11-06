'use client';

import { useState, type FC } from 'react';

import { Icon } from '../icons/Icon.js';

/** The label on the (i) disclosure, named in the help guide's list of labels. */
export const WHY_IM_ASKING_LABEL = "Why I'm asking";

/**
 * The (i) disclosure that holds why a card asks: the tier's reason first, then anything else the
 * server attached (the agent's own why, a repeat-ask note). Renders nothing when there is no reason.
 */
export const WhyIAmAsking: FC<{ lines: readonly string[] }> = ({ lines }) => {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-text-secondary hover:text-text-primary"
      >
        <Icon name="info" className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="underline">{WHY_IM_ASKING_LABEL}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {lines.map((line, index) => (
            // The lines are fixed when the card renders, so the index is stable for this card.
            <p key={index} className="text-text-secondary">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};
