'use client';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { starterPrompts, type TourCapabilities } from './tourPrompts.js';

const STARTER_CLASS =
  'cursor-pointer border-0 bg-transparent p-0 text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

export type AmanStartersProps = {
  helpAreas: readonly HelpAreaId[];
  capabilities: TourCapabilities;
  canSend: boolean;
  onSend: (prompt: string) => void;
};

/** Up to three quiet starter suggestions from the picked help areas, under the composer. */
export function AmanStarters({ helpAreas, capabilities, canSend, onSend }: AmanStartersProps) {
  const prompts = starterPrompts({ helpAreas, capabilities });
  if (prompts.length === 0) return null;
  return (
    <ul aria-label="Starter suggestions" className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0">
      {prompts.map(item => (
        <li key={item.key}>
          <button type="button" className={STARTER_CLASS} disabled={!canSend} onClick={() => onSend(item.prompt)}>
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
