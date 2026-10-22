'use client';

import { useId, type ReactNode } from 'react';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { WelcomeScreen } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';

import {
  CAPABILITY_PROMPTS,
  MORNING_BRIEF,
  tryADayPrompts,
  visibleTourPrompts,
  type TourCapabilities,
  type TourPrompt,
} from './tourPrompts.js';

export const TOUR_HEADLINE = 'Aman is your chief of staff.';
export const TOUR_SUBLINE =
  'It keeps track of your life and checks with you before taking important actions. It runs on your own computer.';

const TOUR_BUTTON_CLASS =
  'flex h-full w-full cursor-pointer items-center rounded-xl border border-border bg-card-bg px-4 py-3 text-left text-sm text-text-primary transition-colors hover:border-primary-button-bg hover:bg-ghost-button-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring/40 disabled:cursor-not-allowed disabled:opacity-60';

/** Shows the label only; the full prompt stays hidden and is the button's accessible description. */
function TourPromptButton({
  item,
  disabled,
  onSend,
}: {
  item: TourPrompt;
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  const promptId = useId();
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={promptId}
        onClick={() => onSend(item.prompt)}
        className={TOUR_BUTTON_CLASS}
      >
        {item.label}
      </button>
      <span id={promptId} hidden>
        {item.prompt}
      </span>
    </li>
  );
}

export type AmanTourProps = {
  capabilities: TourCapabilities;
  /** The areas the person picked, in the order picked; empty shows the general set. */
  helpAreas: readonly HelpAreaId[];
  /** Sends the prompt through the composer, which starts the chat when it is the first message. */
  onSend: (prompt: string) => void;
  /** False until the host reports a model; a prompt cannot run without one. */
  canSend: boolean;
  onHide: () => void;
  /** The "Get set up" block, or nothing once setup is complete. */
  setup: ReactNode;
};

/** The empty-chat tour: what Aman is, a setup block while it is needed, and prompts a click can run. */
export function AmanTour({ capabilities, helpAreas, onSend, canSend, onHide, setup }: AmanTourProps) {
  const dayPrompts = tryADayPrompts({ helpAreas, capabilities });
  const capabilityPrompts = visibleTourPrompts(CAPABILITY_PROMPTS, capabilities);
  return (
    <div data-testid="aman-tour" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-6">
      <WelcomeScreen heading={TOUR_HEADLINE} className="mb-0" />
      <p className="-mt-4 text-center text-base text-text-secondary">{TOUR_SUBLINE}</p>
      {setup}
      {canSend ? null : (
        <p className="text-center text-sm text-text-secondary">Choose a model in Settings before you start a chat.</p>
      )}
      <section aria-labelledby="aman-tour-day-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="aman-tour-day-heading" className="font-serif text-[1.75rem] font-normal text-text-primary">
            Try a day with Aman
          </h2>
          <p className="text-sm text-text-secondary">Tap a card and Aman starts a chat with that message.</p>
        </div>
        <section aria-label="Your morning brief">
          <ul className="grid list-none grid-cols-1 gap-3 p-0">
            <TourPromptButton item={MORNING_BRIEF} disabled={!canSend} onSend={onSend} />
          </ul>
        </section>
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
          {dayPrompts.map(item => (
            <TourPromptButton key={item.key} item={item} disabled={!canSend} onSend={onSend} />
          ))}
        </ul>
      </section>
      <section aria-labelledby="aman-tour-can-heading" className="flex flex-col gap-3">
        <h2 id="aman-tour-can-heading" className="font-serif text-[1.75rem] font-normal text-text-primary">
          What Aman can do
        </h2>
        <ul className="grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 md:grid-cols-3">
          {capabilityPrompts.map(item => (
            <TourPromptButton key={item.key} item={item} disabled={!canSend} onSend={onSend} />
          ))}
        </ul>
      </section>
      <div className="flex justify-center">
        <Button type="button" variant="ghost" size="small" onClick={onHide}>
          Hide the tour
        </Button>
      </div>
    </div>
  );
}
