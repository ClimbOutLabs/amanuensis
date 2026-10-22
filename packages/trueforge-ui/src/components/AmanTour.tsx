'use client';

import { useId, type ReactNode } from 'react';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { assistantDisplayName } from '../utils/assistantName.js';
import { toggleHelpArea } from './HelpAreaChoices.js';
import { TourIllustration } from './tourIllustrations.js';
import { HELP_AREAS, firstFrameCardPrompts, type TourCapabilities, type TourPrompt } from './tourPrompts.js';

/** The one line a first-run person sees under the greeting: what the assistant does. */
export const TOUR_SUBLINE = 'It keeps track of your day and checks with you before it acts.';

/** Morning, afternoon or evening, by the local hour. */
export function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "Good morning, Priya." by the local hour; just the greeting when there is no name. */
export function greetingLine({ now, name }: { now: Date; name: string | null | undefined }): string {
  const trimmed = name?.trim();
  return `${greetingFor(now)}${trimmed ? `, ${trimmed}` : ''}.`;
}

const CHIP_CLASS =
  'cursor-pointer rounded-full border border-border bg-card-bg px-2.5 py-1.5 text-sm text-text-primary hover:border-gold-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring aria-pressed:border-gold-ink aria-pressed:bg-gold-ink aria-pressed:text-card-bg';

const TICKET_BUTTON_CLASS =
  'flex h-full w-full cursor-pointer flex-col gap-1.5 rounded-[inherit] border-0 bg-transparent p-3 text-left text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

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

export type AmanTourProps = {
  capabilities: TourCapabilities;
  /** The areas the person picked, in the order picked. */
  helpAreas: readonly HelpAreaId[];
  /** Saves the chooser's new set of areas. */
  onHelpAreasChange: (next: HelpAreaId[]) => void;
  /** The name the assistant goes by, on the chooser and the capability heading; Aman when not chosen. */
  assistantName?: string | null;
  /** False until the host reports a model; a prompt cannot run without one. */
  canSend: boolean;
  /** Sends the prompt through the composer, which starts the chat when it is the first message. */
  onSend: (prompt: string) => void;
  onHide: () => void;
};

/** The tour panel: the help areas chooser and the capability cards, with a way to hide it again. */
export function AmanTour({
  capabilities,
  helpAreas,
  onHelpAreasChange,
  assistantName,
  canSend,
  onSend,
  onHide,
}: AmanTourProps) {
  const assistant = assistantDisplayName(assistantName);
  const cards = firstFrameCardPrompts({ helpAreas, capabilities, assistantName: assistant });
  const disabled = !canSend;

  return (
    <div data-testid="aman-tour" className="flex w-full flex-col gap-4">
      <section aria-labelledby="aman-tour-help-heading" className="flex flex-col gap-2">
        <h2
          id="aman-tour-help-heading"
          className="m-0 font-mono text-[0.68rem] uppercase tracking-[0.1em] text-text-secondary"
        >
          What would help you most?
        </h2>
        <div role="group" aria-labelledby="aman-tour-help-heading" className="flex flex-wrap gap-1.5">
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
          What {assistant} can do
        </h2>
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-4">
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
