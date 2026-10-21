'use client';

import type { ReactNode } from 'react';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { WelcomeScreen } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';

import { CAPABILITY_PROMPTS, tryADayPrompts, visibleTourPrompts, type TourCapabilities } from './tourPrompts.js';

export const TOUR_HEADLINE = 'Aman is your chief of staff.';
export const TOUR_SUBLINE =
  'It keeps track of your life and checks with you before taking important actions. It runs on your own computer.';

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
          <h2 id="aman-tour-day-heading" className="text-base font-semibold tracking-tight text-text-primary">
            Try a day with Aman
          </h2>
          <p className="text-sm text-text-secondary">Tap a card and Aman starts a chat with that message.</p>
        </div>
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
          {dayPrompts.map(item => (
            <li key={item.key}>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => onSend(item.prompt)}
                className="flex h-full w-full flex-col items-start gap-1 rounded-xl border border-border bg-card-bg p-4 text-left transition-colors hover:border-primary-button-bg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="text-sm font-medium text-text-primary">{item.label}</span>
                <span className="text-sm text-text-secondary">{item.prompt}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="aman-tour-can-heading" className="flex flex-col gap-3">
        <h2 id="aman-tour-can-heading" className="text-base font-semibold tracking-tight text-text-primary">
          What Aman can do
        </h2>
        <ul className="grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 md:grid-cols-3">
          {capabilityPrompts.map(item => (
            <li key={item.key}>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => onSend(item.prompt)}
                className="flex h-full w-full items-center rounded-lg border border-border bg-secondary-bg px-3 py-2 text-left text-sm text-text-primary transition-colors hover:border-primary-button-bg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {item.label}
              </button>
            </li>
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
