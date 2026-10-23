'use client';

import type { FC } from 'react';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { HELP_AREAS } from './tourPrompts.js';

/** Adds an area at the end when it is not chosen yet, and removes it when it is; the list keeps the order chosen. */
export function toggleHelpArea(current: readonly HelpAreaId[], id: HelpAreaId): HelpAreaId[] {
  return current.includes(id) ? current.filter(item => item !== id) : [...current, id];
}

/** "What would help you most?": the Tour's card choice, shared by the setup card and Settings. */
export const HelpAreaChoices: FC<{
  idPrefix: string;
  value: readonly HelpAreaId[];
  onChange: (next: HelpAreaId[]) => void;
  disabled?: boolean;
}> = ({ idPrefix, value, onChange, disabled = false }) => (
  <fieldset className="min-w-0 border-0 p-0">
    <legend className="text-sm font-medium text-text-primary">What would help you most?</legend>
    <p className="mt-1 text-sm text-text-secondary">
      Pick any, and change them any time. They show as pills on the home.
    </p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {HELP_AREA_IDS.map(id => (
        <label
          key={id}
          className="flex items-start gap-2 rounded-lg border border-border/70 bg-secondary-bg px-3 py-2 text-sm text-text-primary"
        >
          <input
            id={`${idPrefix}-${id}`}
            type="checkbox"
            className="mt-0.5"
            checked={value.includes(id)}
            disabled={disabled}
            onChange={() => onChange(toggleHelpArea(value, id))}
          />
          <span>{HELP_AREAS[id].label}</span>
        </label>
      ))}
    </div>
  </fieldset>
);
