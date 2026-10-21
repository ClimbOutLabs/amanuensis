'use client';

import { useId, type ReactNode } from 'react';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { Highlight } from '../atoms/Reward.js';
import { useHighlightedCard } from '../hooks/useRewardLedger.js';
import { AmanPandaRoundTicket } from './AmanPanda.js';
import { toggleHelpArea } from './HelpAreaChoices.js';
import { TourIllustration } from './tourIllustrations.js';
import {
  HELP_AREAS,
  MORNING_BRIEF,
  WAITING_PROMPT,
  WATCHING_PROMPT,
  firstFrameCardPrompts,
  type TourCapabilities,
  type TourPrompt,
} from './tourPrompts.js';

export const TOUR_SUBLINE =
  'It keeps track of your life and checks with you before taking important actions. It runs on your own computer.';

/** Morning, afternoon or evening, by the local hour. */
export function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const TICKET_BUTTON_CLASS =
  'flex h-full w-full cursor-pointer flex-col gap-1.5 rounded-[inherit] border-0 bg-transparent p-3 text-left text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

const CHIP_CLASS =
  'cursor-pointer rounded-full border border-border bg-card-bg px-3 py-1.5 text-sm text-text-primary hover:border-gold-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring aria-pressed:border-gold-ink aria-pressed:bg-gold-ink aria-pressed:text-card-bg';

const STUB_LINE_CLASS = 'font-mono text-[0.68rem] uppercase tracking-[0.1em] text-text-secondary';

/**
 * A ticket that is a button: the label is visible, and the full prompt is the button's accessible
 * description, so a screen reader hears what the tap sends.
 */
function TicketButton({
  prompt,
  disabled,
  onSend,
  children,
}: {
  prompt: string;
  disabled: boolean;
  onSend: (prompt: string) => void;
  children: ReactNode;
}) {
  const promptId = useId();
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={promptId}
        onClick={() => onSend(prompt)}
        className={TICKET_BUTTON_CLASS}
      >
        {children}
      </button>
      <span id={promptId} hidden>
        {prompt}
      </span>
    </>
  );
}

function waitingTitle(count: number): string {
  if (count === 0) return 'Nothing needs you';
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

function scheduleLine(count: number): string {
  if (count === 0) return 'Nothing runs on a schedule yet';
  return count === 1 ? '1 thing runs on a schedule' : `${count} things run on a schedule`;
}

export type AmanTourProps = {
  capabilities: TourCapabilities;
  /** The areas the person picked, in the order picked. */
  helpAreas: readonly HelpAreaId[];
  /** Saves the chooser's new set of areas. */
  onHelpAreasChange: (next: HelpAreaId[]) => void;
  /** The person's name, for the greeting. */
  userName?: string | null;
  /** The clock the greeting and the day label read; the host's clock when omitted. */
  now?: Date;
  /** What is waiting on the person now, and the id of the first of them. */
  waiting: { count: number; firstId: string | null };
  /** How many things run on a schedule for the person. */
  scheduleCount: number;
  /** Sends the prompt through the composer, which starts the chat when it is the first message. */
  onSend: (prompt: string) => void;
  /** False until the host reports a model; a prompt cannot run without one. */
  canSend: boolean;
  onHide: () => void;
  /** The compact setup line under "Quietly watching", or nothing once setup is complete. */
  setup: ReactNode;
  /** The panda picture's URL; the round panda ticket shows on phones only. */
  pandaSrc?: string | null;
};

/** The empty-chat first frame: the day ticket, three tickets, the chooser and what Aman can do. */
export function AmanTour({
  capabilities,
  helpAreas,
  onHelpAreasChange,
  userName,
  now = new Date(),
  waiting,
  scheduleCount,
  onSend,
  canSend,
  onHide,
  setup,
  pandaSrc = null,
}: AmanTourProps) {
  const highlighted = useHighlightedCard({ firstWaitingApprovalId: waiting.firstId, nextAppointmentId: null });
  const name = userName?.trim();
  const greeting = `${greetingFor(now)}${name ? `, ${name}` : ''}.`;
  const dayLabel = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const cards = firstFrameCardPrompts({ helpAreas, capabilities });
  const needsSelected = waiting.firstId !== null && highlighted === waiting.firstId;
  const disabled = !canSend;

  return (
    <div data-testid="aman-tour" className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4">
      <section aria-label="Your day" className="aui-ticket aui-ticket--stub aui-settle">
        <div className="flex flex-col gap-2 p-3">
          <p className="aui-ticket__sub">Aman is your chief of staff</p>
          <h1 className="aui-day-title m-0">
            <span className="aui-underline">{greeting}</span>
          </h1>
          <p className="text-sm leading-normal text-text-secondary">{TOUR_SUBLINE}</p>
        </div>
        <div className="aui-ticket__stub aui-lay">
          <p className={STUB_LINE_CLASS}>{dayLabel}</p>
          <p className="text-sm text-text-primary">{scheduleLine(scheduleCount)}</p>
          <p className={`${STUB_LINE_CLASS} text-text-primary`}>
            {waiting.count === 0 ? (
              'Nothing needs you'
            ) : (
              <Highlight play>{waitingTitle(waiting.count).toUpperCase()}</Highlight>
            )}
          </p>
        </div>
      </section>

      {pandaSrc === null ? null : <AmanPandaRoundTicket src={pandaSrc} className="sm:hidden" />}

      {canSend ? null : (
        <p className="text-center text-sm text-text-secondary">Choose a model in Settings before you start a chat.</p>
      )}

      <ul className="grid list-none gap-3 p-0 sm:grid-cols-3">
        <li className="aui-ticket aui-ticket--punch aui-settle">
          <TicketButton prompt={MORNING_BRIEF.prompt} disabled={disabled} onSend={onSend}>
            <span className="aui-ticket__title">Your brief is ready</span>
            <span className="text-sm text-text-secondary">Today&apos;s stops, with what needs you first.</span>
            <span className="text-sm font-medium text-gold-ink underline underline-offset-2">Open the brief →</span>
          </TicketButton>
        </li>
        <li
          className={`aui-ticket aui-ticket--punch aui-settle ${needsSelected ? 'aui-ticket--selected' : ''}`}
          data-selected={needsSelected ? 'true' : 'false'}
        >
          <TicketButton prompt={WAITING_PROMPT.prompt} disabled={disabled} onSend={onSend}>
            <span className="aui-ticket__title">{waitingTitle(waiting.count)}</span>
            <span className="text-sm text-text-secondary">
              {waiting.count === 0
                ? 'Aman asks before it sends or changes anything.'
                : 'Look them over before anything goes out.'}
            </span>
            <span className="text-sm font-medium text-gold-ink underline underline-offset-2">
              Check what is waiting →
            </span>
          </TicketButton>
        </li>
        <li className="aui-ticket aui-ticket--punch flex flex-col aui-settle">
          <TicketButton prompt={WATCHING_PROMPT.prompt} disabled={disabled} onSend={onSend}>
            <span className="aui-ticket__title">Quietly watching</span>
            <span className="text-sm text-text-secondary">
              Aman keeps an eye on what you set up, and checks with you first.
            </span>
            <span className="text-sm font-medium text-gold-ink underline underline-offset-2">
              Ask what Aman has noticed →
            </span>
          </TicketButton>
          <div className="px-3 pb-2">{setup}</div>
        </li>
      </ul>

      <section aria-labelledby="aman-tour-help-heading" className="flex flex-col gap-2">
        <h2
          id="aman-tour-help-heading"
          className="m-0 font-mono text-[0.68rem] uppercase tracking-[0.1em] text-text-secondary"
        >
          What would help you most?
        </h2>
        <div role="group" aria-labelledby="aman-tour-help-heading" className="flex flex-wrap gap-2">
          {HELP_AREA_IDS.map(id => (
            <button
              key={id}
              type="button"
              aria-pressed={helpAreas.includes(id)}
              onClick={() => onHelpAreasChange(toggleHelpArea(helpAreas, id))}
              className={CHIP_CLASS}
            >
              {HELP_AREAS[id].label}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="aman-tour-can-heading" className="flex flex-col gap-2">
        <h2 id="aman-tour-can-heading" className="aui-ticket__title m-0">
          What Aman can do
        </h2>
        <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
          {cards.map(item => (
            <CapabilityTicket key={item.key} item={item} disabled={disabled} onSend={onSend} />
          ))}
        </ul>
      </section>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={onHide}
          className="cursor-pointer border-0 bg-transparent text-sm text-text-secondary underline underline-offset-2"
        >
          Hide the tour
        </button>
      </div>
    </div>
  );
}

function CapabilityTicket({
  item,
  disabled,
  onSend,
}: {
  item: TourPrompt;
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  return (
    <li className="aui-ticket aui-ticket--punch flex flex-col aui-settle">
      <TicketButton prompt={item.prompt} disabled={disabled} onSend={onSend}>
        {item.illustration === undefined ? null : <TourIllustration name={item.illustration} />}
        <span className="text-sm font-medium">{item.label}</span>
      </TicketButton>
    </li>
  );
}
