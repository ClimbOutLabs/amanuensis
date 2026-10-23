'use client';

import type { ReactNode } from 'react';

import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { cn } from '../atoms/lib/cn.js';
import { Icon } from '../icons/Icon.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { HELP_AREAS, MORNING_BRIEF, visibleTourPrompts, type TourCapabilities } from './tourPrompts.js';

/** Morning, afternoon or evening, by the local hour. */
function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The greeting in two parts: the time of day, and the first name, which alone takes the underline. */
export function greetingParts({ now, name }: { now: Date; name: string | null | undefined }): {
  hello: string;
  firstName: string | null;
} {
  const firstName = name?.trim().split(/\s+/)[0] ?? '';
  return { hello: greetingFor(now), firstName: firstName === '' ? null : firstName };
}

/** "Good morning, Priya" by the local hour; just the greeting when there is no name. */
export function greetingLine({ now, name }: { now: Date; name: string | null | undefined }): string {
  const { hello, firstName } = greetingParts({ now, name });
  return firstName === null ? hello : `${hello}, ${firstName}`;
}

/** A hand-drawn underline for the first name: a stroke as wide as the name, drawn in the one highlight. */
function NameUnderline() {
  return (
    <svg className="aui-name-underline" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      <path d="M1 5 C 25 1, 60 7, 99 3" />
    </svg>
  );
}

type HomeCard = { key: string; title: string; detail: string; prompt: string; icon: string };

/** The four cards under "Some things {name} can do". A click fills the composer; the person sends it. */
function homeCards(): readonly HomeCard[] {
  return [
    {
      key: 'reply',
      title: 'Draft a reply',
      detail: 'Reads the thread, writes it, asks before sending',
      prompt:
        'Help me draft a reply to my most recent email that needs one. Read the whole thread first, and ask me before you send anything.',
      icon: 'square-pen',
    },
    {
      key: 'plan',
      title: 'Plan your day',
      detail: 'Finds conflicts and travel time on your calendar',
      prompt:
        'Help me plan my day. Check my calendar for conflicts and travel time, then suggest an order for my tasks.',
      icon: 'calendar-clock',
    },
    {
      key: 'places',
      title: 'Find places and routes',
      detail: 'A map with the stops, and how long it takes',
      prompt: 'Help me find places I need to go today. Show the stops on a map, and how long each route takes.',
      icon: 'map-pin',
    },
    {
      key: 'schedule',
      title: 'Run things on a schedule',
      detail: 'A brief every morning, a check every Friday',
      prompt:
        'Help me set something up to run on a schedule: a brief every morning, and a check every Friday. Ask me what to look at first.',
      icon: 'clock',
    },
  ];
}

const PILL_CLASS =
  'inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-full border px-3 font-[inherit] text-[0.8125rem] text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

const CARD_CLASS =
  'flex cursor-pointer flex-col gap-1 rounded-[0.625rem] border border-border bg-card-bg px-3.5 py-3 text-left font-[inherit] text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring';

/** The map pin is not in the icon set; drawn in the same stroke style. */
function MapPinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[1.125rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z" />
      <circle cx="12" cy="11" r="2.25" />
    </svg>
  );
}

export type AmanTourProps = {
  capabilities: TourCapabilities;
  /** The person's name, for the greeting. */
  userName?: string | null;
  /** The name the assistant goes by; Aman when not chosen. */
  assistantName?: string | null;
  /** The clock the greeting reads; the host's clock when omitted. */
  now?: Date;
  /** Whether a morning brief exists yet; the Productivity pill is gold once it does. */
  hasBrief: boolean;
  /** On a first run the prompt line, the setup ticket and Skip show; otherwise they do not. */
  firstRun: boolean;
  /** The setup ticket, shown on a first run. */
  setupTicket: ReactNode;
  /** Puts the first-run lines away for good. Omitted when the host cannot remember that. */
  onSkip?: () => void;
  /** Starts a chat with the prompt. */
  onSend: (prompt: string) => void;
  /** Puts the prompt in the composer so the person can change it before sending. */
  onFill: (prompt: string) => void;
  /** False until the host reports a model; a prompt cannot run without one. */
  canSend: boolean;
};

/**
 * The home on an ordinary new chat. The greeting comes first and the rest orders after the
 * composer, which the thread renders between the two.
 */
export function AmanTour({
  capabilities,
  userName,
  assistantName,
  now = new Date(),
  hasBrief,
  firstRun,
  setupTicket,
  onSkip,
  onSend,
  onFill,
  canSend,
}: AmanTourProps) {
  const assistant = assistantDisplayName(assistantName);
  const { hello, firstName } = greetingParts({ now, name: userName });
  const cards = homeCards();

  return (
    <>
      <h1 className="aui-face-serif order-0 m-0 px-4 pt-[clamp(7rem,22vh,14rem)] pb-5 text-center text-[1.75rem] leading-[1.2] font-normal text-text-primary">
        {hello}
        {firstName === null ? null : (
          <>
            {', '}
            <span className="relative inline-block">
              {firstName}
              <NameUnderline />
            </span>
          </>
        )}
      </h1>

      <div className="order-1 mx-auto flex w-full max-w-160 flex-col gap-5 px-4 pb-6">
        {canSend ? null : (
          <p className="m-0 text-center text-[0.8125rem] text-text-secondary">
            Choose a model in Settings before you start a chat.
          </p>
        )}

        {firstRun ? (
          <p className="m-0 text-center text-[0.8125rem] text-text-secondary">
            What would help you most? Pick one and {assistant} starts there.
          </p>
        ) : null}

        <ul aria-label="What would help you most?" className="m-0 flex list-none flex-wrap justify-center gap-2 p-0">
          <li>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => onSend(MORNING_BRIEF.prompt)}
              className={cn(PILL_CLASS, hasBrief ? 'border-gold-line bg-gold-soft' : 'border-border bg-card-bg')}
            >
              {hasBrief ? <span className="size-1.5 rounded-full bg-gold" aria-hidden="true" /> : null}
              Productivity
            </button>
          </li>
          {HELP_AREA_IDS.map(id => {
            const first = visibleTourPrompts(HELP_AREAS[id].cards, capabilities)[0];
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={!canSend || first === undefined}
                  onClick={() => {
                    if (first !== undefined) onSend(first.prompt);
                  }}
                  className={cn(PILL_CLASS, 'border-border bg-card-bg')}
                >
                  {HELP_AREAS[id].label}
                </button>
              </li>
            );
          })}
        </ul>

        {firstRun ? setupTicket : null}

        <section className="flex flex-col gap-2.5" aria-labelledby="aman-home-cards-heading">
          <h2 id="aman-home-cards-heading" className="m-0 text-[0.8125rem] font-normal text-text-secondary">
            Some things {assistant} can do
          </h2>
          <ul className="m-0 grid list-none grid-cols-2 gap-2.5 p-0">
            {cards.map(card => (
              <li key={card.key}>
                <button type="button" className={cn(CARD_CLASS, 'h-full w-full')} onClick={() => onFill(card.prompt)}>
                  <span className="text-gold-ink">
                    {card.icon === 'map-pin' ? (
                      <MapPinIcon />
                    ) : (
                      <Icon name={card.icon} size="1.125rem" aria-hidden="true" />
                    )}
                  </span>
                  <span className="aui-face-serif text-[0.9375rem]">{card.title}</span>
                  <span className="text-[0.8125rem] text-text-secondary">{card.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {firstRun && onSkip !== undefined ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onSkip}
              className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[0.8125rem] text-text-secondary underline underline-offset-2"
            >
              Skip the tour
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
