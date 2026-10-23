'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { assistantDisplayName } from '../utils/assistantName.js';
import { TourIllustration } from './tourIllustrations.js';
import { HELP_AREAS, firstFrameCardPrompts, type TourCapabilities, type TourPrompt } from './tourPrompts.js';

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
  'cursor-pointer rounded-full border border-border bg-card-bg px-2.5 py-1.5 text-sm text-text-primary hover:border-gold-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring aria-checked:border-gold-ink aria-checked:bg-gold-ink aria-checked:text-card-bg';

const TICKET_BUTTON_CLASS =
  'flex h-full w-full cursor-pointer items-center gap-2 rounded-[inherit] border-0 bg-transparent px-3 py-2 text-left text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The Tour's "What would help you most?" pick is one area at a time. A new pick replaces the
 * others, and picking the chosen area again clears it.
 */
export function pickHelpArea({ current, id }: { current: readonly HelpAreaId[]; id: HelpAreaId }): HelpAreaId[] {
  return current[0] === id ? [] : [id];
}

const ARROW_STEPS: Partial<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * A ticket that is a button: the label is visible, and the full prompt is the button's accessible
 * description, so a screen reader hears what the tap sends.
 */
function TicketButton({
  prompt,
  description = prompt,
  disabled,
  onSend,
  children,
}: {
  prompt: string;
  /** What a screen reader hears when the prompt is not plain words. */
  description?: string;
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
        {description}
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
        <h2 id="aman-tour-help-heading" className="aui-section-heading m-0">
          What would help you most?
        </h2>
        <HelpAreaPills labelId="aman-tour-help-heading" helpAreas={helpAreas} onChange={onHelpAreasChange} />
      </section>

      <section aria-labelledby="aman-tour-can-heading" className="flex flex-col gap-2">
        <h2 id="aman-tour-can-heading" className="aui-section-heading m-0">
          Some things {assistant} can do
        </h2>
        <ul className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
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

/**
 * A radio group of area pills: one is chosen at a time. Tab lands on the chosen pill, and the
 * arrow keys move to the next or previous pill and choose it.
 */
function HelpAreaPills({
  labelId,
  helpAreas,
  onChange,
}: {
  labelId: string;
  helpAreas: readonly HelpAreaId[];
  onChange: (next: HelpAreaId[]) => void;
}) {
  const selected = helpAreas[0] ?? null;
  const pills = useRef<(HTMLButtonElement | null)[]>([]);
  const tabStop = selected === null ? 0 : HELP_AREA_IDS.indexOf(selected);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = ARROW_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + HELP_AREA_IDS.length) % HELP_AREA_IDS.length;
    const id = HELP_AREA_IDS[next];
    if (id === undefined) return;
    pills.current[next]?.focus();
    onChange([id]);
  }

  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
      {HELP_AREA_IDS.map((id, index) => (
        <button
          key={id}
          ref={element => {
            pills.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={id === selected}
          tabIndex={index === tabStop ? 0 : -1}
          onClick={() => onChange(pickHelpArea({ current: helpAreas, id }))}
          onKeyDown={event => onKeyDown(event, index)}
          className={CHIP_CLASS}
        >
          {HELP_AREAS[id].label}
        </button>
      ))}
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
      <TicketButton prompt={item.prompt} description={item.description} disabled={disabled} onSend={onSend}>
        {item.illustration === undefined ? null : (
          <TourIllustration name={item.illustration} className="size-6 shrink-0" />
        )}
        <span>{item.label}</span>
      </TicketButton>
    </li>
  );
}
