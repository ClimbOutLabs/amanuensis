'use client';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { Fragment, type ReactNode } from 'react';

import {
  MORNING_BRIEF,
  WAITING_PROMPT,
  WATCHING_PROMPT,
  starterPrompts,
  type TourCapabilities,
} from './tourPrompts.js';

const LINK_CLASS =
  'cursor-pointer border-0 bg-transparent p-0 font-medium text-gold-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

const STARTER_CLASS =
  'cursor-pointer border-0 bg-transparent p-0 text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60';

function waitingTitle(count: number): string {
  if (count === 0) return 'Nothing needs you';
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

function scheduleLine(count: number): string {
  if (count === 0) return 'Nothing runs on a schedule yet';
  return count === 1 ? '1 thing runs on a schedule' : `${count} things run on a schedule`;
}

export type AmanHomeStatusProps = {
  assistantName: string;
  waitingCount: number;
  scheduleCount: number;
  canSend: boolean;
  onSend: (prompt: string) => void;
};

/**
 * The home's one status line: the brief, what waits on the person, and the schedules. Each part
 * with somewhere to go carries a plain text link that sends its prompt.
 */
export function AmanHomeStatus({ assistantName, waitingCount, scheduleCount, canSend, onSend }: AmanHomeStatusProps) {
  const disabled = !canSend;
  const parts: ReactNode[] = [
    <span key="brief">
      Your brief is ready (
      <button type="button" className={LINK_CLASS} disabled={disabled} onClick={() => onSend(MORNING_BRIEF.prompt)}>
        Open the brief
      </button>
      )
    </span>,
    <span key="waiting">
      {waitingTitle(waitingCount)} (
      <button type="button" className={LINK_CLASS} disabled={disabled} onClick={() => onSend(WAITING_PROMPT.prompt)}>
        Check what is waiting
      </button>
      )
    </span>,
    <span key="schedule">{scheduleLine(scheduleCount)}</span>,
    <button
      key="watching"
      type="button"
      className={LINK_CLASS}
      disabled={disabled}
      onClick={() => onSend(WATCHING_PROMPT.prompt)}
    >
      Ask what {assistantName} has noticed
    </button>,
  ];
  return (
    <p className="m-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm text-text-secondary">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index === 0 ? null : (
            <span aria-hidden="true" className="text-text-secondary">
              ·
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

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
