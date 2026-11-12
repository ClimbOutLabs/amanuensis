'use client';

import { Button } from '@/atoms/primitives/Button.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import type {
  MemoryTidyRun,
  PageSortMode,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryHelpersCatalog.js';
import { useToasterOptional } from '../ToasterContainer.js';
import { useMemoryNightlySetting, useMemoryPageSortingSetting } from './memoryHelperSettings.js';

function sortChoices(assistant: string): { mode: PageSortMode; label: string; explain: string }[] {
  return [
    {
      mode: 'off',
      label: 'Off',
      explain: `${assistant} does not sort anything onto pages. What it saves stays in the daily notes.`,
    },
    {
      mode: 'report',
      label: 'Only note what it would do',
      explain: `${assistant} works out where each saved note would go and writes that down. It changes no pages.`,
    },
    {
      mode: 'on',
      label: 'On',
      explain: `${assistant} puts each saved note on the right page. What ${assistant} read can only ever be added as not confirmed.`,
    },
  ];
}

function PageSortingControl() {
  const assistant = useAssistantDisplayName();
  const setting = useMemoryPageSortingSetting();
  const toaster = useToasterOptional();
  const disabled = setting.saving || setting.mode === null;
  const choices = sortChoices(assistant);
  const selected = setting.mode;

  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="text-sm font-medium text-text-primary">Sort what Aman saves onto pages</legend>
      <p className="mt-0.5 text-xs text-text-secondary">This uses the model while you are not chatting.</p>
      <div className="mt-2 flex flex-col gap-2">
        {choices.map(choice => (
          <label key={choice.mode} className="flex items-start gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="memory-page-sorting"
              className="mt-1"
              value={choice.mode}
              checked={selected === choice.mode}
              onChange={() => {
                void setting.setMode(choice.mode).then(saved => {
                  if (saved) toaster?.showSuccess({ title: 'Sorting setting saved' });
                });
              }}
            />
            <span>
              <span className="font-medium">{choice.label}</span>
              <span className="block text-xs text-text-secondary">{choice.explain}</span>
            </span>
          </label>
        ))}
      </div>
      {setting.error === null ? null : (
        <p className="mt-1.5 text-xs text-danger" role="alert">
          {setting.error}
        </p>
      )}
    </fieldset>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** An hour of the day as a clock time: 0 is midnight, 12 is noon. */
function hourLabel(hour: number): string {
  if (hour === 0) return '12:00 AM (midnight)';
  if (hour === 12) return '12:00 PM (noon)';
  return hour < 12 ? `${String(hour)}:00 AM` : `${String(hour - 12)}:00 PM`;
}

function count(amount: number, { one, many }: { one: string; many: string }): string {
  return `${String(amount)} ${amount === 1 ? one : many}`;
}

/** One plain sentence on what a tidy-up asked for now did. */
function tidyResultCopy({ run, assistant }: { run: MemoryTidyRun; assistant: string }): string {
  if (run.status === 'busy') {
    return 'A tidy-up is already running. Try again in a few minutes.';
  }
  const done = [
    ...(run.movedToEarlier > 0
      ? [`moved ${count(run.movedToEarlier, { one: 'ended line', many: 'ended lines' })} to Earlier`]
      : []),
    ...(run.notesSorted > 0 ? [`sorted ${count(run.notesSorted, { one: 'note', many: 'notes' })} onto pages`] : []),
    ...(run.pairsListed > 0
      ? [`listed ${count(run.pairsListed, { one: 'pair of lines', many: 'pairs of lines' })} that disagree`]
      : []),
  ];
  return done.length === 0
    ? 'Done. Nothing needed tidying.'
    : `Done. ${assistant} ${new Intl.ListFormat('en', { type: 'conjunction' }).format(done)}.`;
}

function NightlyControl() {
  const assistant = useAssistantDisplayName();
  const setting = useMemoryNightlySetting();
  const toaster = useToasterOptional();
  const disabled = setting.saving || setting.enabled === null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="memory-nightly-toggle" className="text-sm font-medium text-text-primary">
            Tidy pages once a day
          </label>
          <p className="mt-0.5 text-xs text-text-secondary">
            Once a day, {assistant} moves lines that have ended to Earlier, sorts notes that were missed, and lists
            lines that disagree. This uses the model while you are not chatting.
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            Sorting missed notes follows the sorting choice above. With sorting off, {assistant} only moves ended lines.
          </p>
          {setting.error === null ? null : (
            <p className="mt-1.5 text-xs text-danger" role="alert">
              {setting.error}
            </p>
          )}
        </div>
        <Switch
          id="memory-nightly-toggle"
          checked={setting.enabled === true}
          disabled={disabled}
          onCheckedChange={next => {
            void setting.setEnabled(next).then(saved => {
              if (saved) toaster?.showSuccess({ title: next ? 'Daily tidy-up is on' : 'Daily tidy-up is off' });
            });
          }}
          aria-label="Tidy pages once a day"
        />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="memory-nightly-hour" className="text-xs font-medium text-text-secondary">
            Start the daily tidy-up at
          </label>
          <select
            id="memory-nightly-hour"
            className="rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
            value={setting.hour ?? 0}
            disabled={disabled}
            onChange={event => {
              const next = Number(event.target.value);
              void setting.setHour(next).then(saved => {
                if (saved) toaster?.showSuccess({ title: `Daily tidy-up starts at ${hourLabel(next)}` });
              });
            }}
          >
            {HOURS.map(hour => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-secondary">This is the time on the computer {assistant} runs on.</p>
        </div>
        <Button.Secondary
          type="button"
          size="small"
          disabled={setting.tidying}
          onClick={() => {
            void setting.tidyNow();
          }}
        >
          {setting.tidying ? 'Tidying…' : 'Tidy now'}
        </Button.Secondary>
      </div>
      {setting.tidied === null ? null : (
        <p className="text-xs text-text-secondary" role="status">
          {tidyResultCopy({ run: setting.tidied, assistant })}
        </p>
      )}
      {setting.tidyError === null ? null : (
        <p className="text-xs text-danger" role="alert">
          {setting.tidyError}
        </p>
      )}
    </div>
  );
}

/** Settings > Memory: the two helpers that work on pages while nobody is chatting. Both start off. */
export function MemoryHelpersCard() {
  const sorting = useMemoryPageSortingSetting();
  const nightly = useMemoryNightlySetting();
  // Hidden when the server is not this app's own: no heading, no empty box.
  if (!sorting.supported && !nightly.supported) return null;
  return (
    <section aria-labelledby="memory-helpers-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id="memory-helpers-heading" className="text-sm font-medium text-text-primary">
        Sorting and tidying
      </h4>
      <p className="mt-1 text-sm text-text-secondary">Both of these start off. Switch them on when you want them.</p>
      <div className="mt-4 border-t border-border pt-4">
        <PageSortingControl />
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <NightlyControl />
      </div>
    </section>
  );
}
