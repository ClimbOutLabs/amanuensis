'use client';

import type { ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Icon } from '../icons/Icon.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { useHomeTopic } from './homeTopic.js';
import { composerTextFor, HOME_TOPIC_IDS, HOME_TOPICS, homeCardsFor, type TourCapabilities } from './tourPrompts.js';

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

const PILL_CLASS =
  'inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-full border px-3 font-[inherit] text-[0.8125rem] text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring';

/** Icon and serif title on one line, the description below it in at most two lines. */
const CARD_CLASS =
  'flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-[0.625rem] border border-border bg-card-bg px-3 py-2 text-left font-[inherit] text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring';

/** The map pin is not in the icon set; drawn in the same stroke style. */
function MapPinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4.5"
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
  /** On a first run the prompt line, the setup ticket and Skip show; otherwise they do not. */
  firstRun: boolean;
  /** The setup ticket, shown on a first run. */
  setupTicket: ReactNode;
  /** Puts the first-run lines away for good. Omitted when the host cannot remember that. */
  onSkip?: () => void;
  /** Sends the text as the first message of a turn. */
  onSend: (text: string) => void;
  /** Puts the text in the composer instead, when no model is set and nothing can run. */
  onFill: (text: string) => void;
  /** False until the host reports a model; a chat cannot run without one. */
  canSend: boolean;
};

/**
 * The home on an ordinary new chat. The greeting and the setup ticket come first; the rest
 * orders after the composer, which the thread renders between the two.
 */
export function AmanTour({
  capabilities,
  userName,
  assistantName,
  now = new Date(),
  firstRun,
  setupTicket,
  onSkip,
  onSend,
  onFill,
  canSend,
}: AmanTourProps) {
  const assistant = assistantDisplayName(assistantName);
  const { hello, firstName } = greetingParts({ now, name: userName });
  const [topic, setTopic] = useHomeTopic();
  const cards = homeCardsFor({ topic, capabilities });

  return (
    <>
      <h1 className="aman-home-greeting aui-face-serif order-0 m-0 pt-[clamp(3rem,8vh,8rem)] text-left text-[1.75rem] leading-[1.2] font-normal text-text-primary">
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

      {/* With the greeting, ahead of the composer: the ticket never splits the pills from their cards. */}
      {firstRun ? setupTicket : null}

      {/* Shares the home column's edges: no width or side padding of its own (see .aman-home-greeting in styles.css). */}
      <div className="order-1 flex w-full flex-col gap-5 pb-4">
        {canSend ? null : (
          <p className="m-0 text-[0.8125rem] text-text-secondary">
            Choose a model in Settings before you start a chat.
          </p>
        )}

        {firstRun ? (
          <p className="m-0 text-[0.8125rem] text-text-secondary">
            What would help you most? Pick one to see what {assistant} can do there.
          </p>
        ) : null}

        <ul aria-label="What would help you most?" className="m-0 flex list-none flex-wrap justify-start gap-2 p-0">
          {HOME_TOPIC_IDS.map(id => {
            const chosen = topic === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => setTopic(chosen ? null : id)}
                  className={cn(PILL_CLASS, chosen ? 'border-gold-line bg-gold-soft' : 'border-border bg-card-bg')}
                >
                  {HOME_TOPICS[id].label}
                </button>
              </li>
            );
          })}
        </ul>

        <section className="mt-7 flex flex-col gap-5" aria-labelledby="aman-home-cards-heading">
          <h2 id="aman-home-cards-heading" className="m-0 text-[0.8125rem] font-normal text-text-secondary">
            Some things {assistant} can do
          </h2>
          <ul className="m-0 grid list-none grid-cols-2 gap-2.5 p-0">
            {cards.map(card => (
              <li key={card.title}>
                <button
                  type="button"
                  className={cn(CARD_CLASS, 'h-full w-full')}
                  onClick={() => (canSend ? onSend : onFill)(composerTextFor(card))}
                >
                  <span className="flex min-w-0 items-start gap-2" data-role="home-card-title">
                    <span className="flex h-[1.2em] shrink-0 items-center text-[0.9375rem] text-gold-ink">
                      {card.icon === 'map-pin' ? (
                        <MapPinIcon />
                      ) : (
                        <Icon name={card.icon} size="1.125rem" aria-hidden="true" />
                      )}
                    </span>
                    <span className="aui-face-serif text-[0.9375rem] leading-[1.2] font-normal text-text-primary">
                      {card.title}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[0.8125rem] text-text-secondary">{card.detail(assistant)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {firstRun && onSkip !== undefined ? (
          <div className="flex">
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
