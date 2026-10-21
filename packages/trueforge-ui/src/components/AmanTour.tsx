'use client';

import { useId, type ReactNode } from 'react';

import { WelcomeScreen } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';

export const TOUR_HEADLINE = 'Aman is your chief of staff.';
export const TOUR_SUBLINE =
  'It keeps track of your life and checks with you before taking important actions. It runs on your own computer.';

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
  {
    key: 'brief',
    label: 'Your morning brief',
    prompt:
      "Good morning! What do I need to know today? Go through my calendar, email and tasks, and tell me what's coming up, what's due, and anything that looks off.",
  },
  {
    key: 'clear-head',
    label: 'Help me clear my head',
    prompt:
      "I have too much going on. Ask me what's on my mind, then sort it into today, this week, and later, and keep that list for me.",
  },
  {
    key: 'break-task',
    label: 'Help me break a task into steps',
    prompt:
      'Help me break a task into steps. Ask me what the task is, then split it into small steps I can each do in about 10 minutes, and keep the list so we can tick them off together.',
  },
  {
    key: 'plan-day',
    label: 'Help me plan my day',
    prompt:
      "Help me plan my day. Look at my calendar and my to-do list, put things in a sensible order with times, and find a good place for lunch near where I'll be.",
  },
  {
    key: 'appointment',
    label: "Help me with doctor's appointments",
    prompt:
      "Help me with my doctor's appointments. Find any coming up in my calendar and email, tell me what to bring and what to ask, and remind me of anything I still need to book.",
    needs: 'calendar',
  },
  {
    key: 'meals',
    label: "Plan this week's meals",
    prompt: "Plan this week's meals around what we already have, and make the shopping list.",
  },
];

export const CAPABILITY_PROMPTS: readonly TourPrompt[] = [
  {
    // Naming the guide invokes it, so the reply comes from the Aman guide persona.
    key: 'get-to-know',
    label: 'Get to know Aman',
    prompt: 'Aman guide, introduce yourself and show me how to get started.',
  },
  {
    key: 'email',
    label: 'Handle your email',
    prompt: 'Go through my unread email and tell me what needs a reply first.',
    needs: 'email',
  },
  {
    key: 'subscriptions',
    label: 'Find forgotten subscriptions',
    prompt:
      "Look through my email for subscriptions and renewals. List what I'm paying for, how much and how often, and flag anything I may have forgotten about.",
    needs: 'email',
  },
  {
    key: 'reply',
    label: 'Reply to an email',
    prompt: 'Help me reply to my most recent email that needs an answer.',
    needs: 'email',
  },
  { key: 'schedule', label: 'Run things on a schedule', prompt: 'Every weekday at 7:30, send me my morning brief.' },
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
    prompt: "What's in the news today? Give me the five stories that matter, two lines each.",
  },
  {
    key: 'documents',
    label: 'Keep living documents',
    prompt: 'Start a packing list for a weekend trip that we can keep updating.',
  },
  {
    key: 'specialists',
    label: 'Bring in specialists',
    prompt: "Get a travel specialist to plan a long weekend somewhere I've never been.",
  },
  {
    key: 'code',
    label: 'Read files and run code',
    prompt: 'Add up my expenses by category and make a chart: rent 900, groceries 210, transport 45, eating out 80.',
    needs: 'sandbox',
  },
  { key: 'memory', label: 'Remember what matters', prompt: 'What do you remember about me so far?' },
  {
    key: 'skills',
    label: 'Learn new skills',
    prompt: 'Learn how to turn a photo of a receipt into a line in my expense list.',
    needs: 'sandbox',
  },
  {
    key: 'move',
    label: 'Move with you',
    prompt: 'How do I use you from my phone?',
  },
  { key: 'cost', label: 'Show what it costs', prompt: 'Show me what my chats have cost so far this month.' },
];

/** The prompts whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourPrompts(prompts: readonly TourPrompt[], capabilities: TourCapabilities): TourPrompt[] {
  return prompts.filter(item => item.needs === undefined || capabilities[item.needs]);
}

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
            <TourPromptButton key={item.key} item={item} disabled={!canSend} onSend={onSend} />
          ))}
        </ul>
      </section>
      <section aria-labelledby="aman-tour-can-heading" className="flex flex-col gap-3">
        <h2 id="aman-tour-can-heading" className="text-base font-semibold tracking-tight text-text-primary">
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
