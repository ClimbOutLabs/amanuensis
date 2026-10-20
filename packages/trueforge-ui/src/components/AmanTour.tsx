'use client';

import type { ReactNode } from 'react';

import { WelcomeScreen } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';

export const TOUR_HEADLINE = 'Aman is your chief of staff.';
export const TOUR_SUBLINE =
  'It keeps track of your life. It runs on your own computer, and nothing leaves without your OK.';

/** What this instance can do, so the tour only offers prompts that will work here. */
export type TourCapabilities = {
  /** Gmail read is granted. */
  email: boolean;
  /** Calendar read is granted. */
  calendar: boolean;
  /** A sandbox is configured, so Aman can run code and skills. */
  sandbox: boolean;
};

export type TourPrompt = {
  key: string;
  label: string;
  prompt: string;
  /** The capability a prompt needs; left out when it works on any instance. */
  needs?: keyof TourCapabilities;
};

export const TRY_A_DAY_PROMPTS: readonly TourPrompt[] = [
  { key: 'brief', label: 'Your morning brief', prompt: 'Good morning! Give me my brief for today.' },
  {
    key: 'scam-check',
    label: 'Check for scams',
    prompt: 'Is anything in my inbox a scam?',
    needs: 'email',
  },
  {
    key: 'reply',
    label: 'Reply to an email',
    prompt: 'Help me reply to my most recent email that needs an answer.',
    needs: 'email',
  },
  {
    key: 'plan-day',
    label: 'Plan my day',
    prompt: "Plan my day around what's on my list, with lunch somewhere nearby.",
  },
  {
    key: 'appointment',
    label: 'Get ready for an appointment',
    prompt: 'Help me get ready for my next appointment.',
    needs: 'calendar',
  },
];

export const CAPABILITY_PROMPTS: readonly TourPrompt[] = [
  {
    key: 'email',
    label: 'Handle your email',
    prompt: 'Go through my unread email and tell me what needs a reply first.',
    needs: 'email',
  },
  { key: 'schedule', label: 'Run things on a schedule', prompt: 'Set up a routine that checks my bills every Friday.' },
  {
    key: 'calendar',
    label: 'Keep your calendar',
    prompt: 'What is on my calendar this week?',
    needs: 'calendar',
  },
  {
    key: 'places',
    label: 'Find places and plan routes',
    prompt: 'Find a quiet coffee shop near me and plan the walk there.',
  },
  {
    key: 'web',
    label: 'Research the live web',
    prompt: 'Look up the latest news on a topic I care about and sum it up for me.',
  },
  {
    key: 'documents',
    label: 'Keep living documents',
    prompt: 'Start a living document for my packing list that I can update later.',
  },
  {
    key: 'specialists',
    label: 'Bring in specialists',
    prompt: 'Bring in a specialist to help me plan my next trip.',
  },
  {
    key: 'code',
    label: 'Read files and run code',
    prompt: 'Add up these expenses and show me the total: 12.50, 8, 31.20.',
    needs: 'sandbox',
  },
  { key: 'memory', label: 'Remember what matters', prompt: 'What do you remember about me so far?' },
  {
    key: 'skills',
    label: 'Learn new skills',
    prompt: 'Learn a new skill that turns my receipts into a monthly expense list.',
    needs: 'sandbox',
  },
  {
    key: 'move',
    label: 'Move with you',
    prompt: 'What can you do for me when I am away from my desk?',
  },
  { key: 'cost', label: 'Show what it costs', prompt: 'Show me what my chats have cost so far this month.' },
];

/** The prompts whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourPrompts(prompts: readonly TourPrompt[], capabilities: TourCapabilities): TourPrompt[] {
  return prompts.filter(item => item.needs === undefined || capabilities[item.needs]);
}

export type AmanTourProps = {
  capabilities: TourCapabilities;
  /** Sends the prompt through the composer, which starts the chat when it is the first message. */
  onSend: (prompt: string) => void;
  /** False until the host reports a model; a prompt cannot run without one. */
  canSend: boolean;
  onHide: () => void;
  /** The "Get set up" block, or nothing once setup is complete. */
  setup: ReactNode;
};

/** The empty-chat tour: what Aman is, a setup block while it is needed, and prompts a click can run. */
export function AmanTour({ capabilities, onSend, canSend, onHide, setup }: AmanTourProps) {
  const dayPrompts = visibleTourPrompts(TRY_A_DAY_PROMPTS, capabilities);
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
