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
      explain: `Nothing is filed for you. Saved notes stay on the Memories tab, and a page changes only when you ask.`,
    },
    {
      mode: 'report',
      label: 'Only note what it would do',
      explain: `A trial run. ${assistant} writes down which page each note would go on, and changes no pages.`,
    },
    {
      mode: 'on',
      label: 'On',
      explain: `${assistant} files each saved note on the right page. Anything it read elsewhere, such as in an email, is added as not confirmed until you confirm it.`,
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
      <p className="mt-0.5 text-xs text-text-secondary">
        After a chat, {assistant} can file what it saved onto the page it belongs to, such as your sister&apos;s page.
      </p>
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

/** The waits offered; a value stored another way is added to the list so it still shows. */
const MODEL_WAIT_MINUTES = [1, 3, 5, 10, 15, 20];

function minutesLabel(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/** An hour of the day as a clock time: 0 is midnight, 12 is noon. */
function hourLabel(hour: number): string {
  if (hour === 0) return '12:00 AM (midnight)';
  if (hour === 12) return '12:00 PM (noon)';
  return hour < 12 ? `${String(hour)}:00 AM` : `${String(hour - 12)}:00 PM`;
}

function count(amount: number, { one, many }: { one: string; many: string }): string {
  return `${String(amount)} ${amount === 1 ? one : many}`;
}

/** A plain sentence part for a cause the server names; a cause this page does not know reads as a general failure. */
function unsortedReasonCopy({ cause, assistant }: { cause: string; assistant: string }): string {
  const known: Record<string, string> = {
    model_slow: 'the model took too long to answer',
    model_error: 'the model returned an error',
    reply_empty: 'the model gave no answer',
    reply_cut_short: "the model's answer was cut short",
    reply_too_long: "the model's answer was too long",
    reply_wrong_form: `the model's answer was not in the form ${assistant} asked for`,
    reply_broke_rule: "the model's answer asked for a change that is not allowed",
    note_empty: 'the note was empty',
    pages_unreadable: 'a page could not be read',
    write_failed: 'a page could not be saved',
  };
  return known[cause] ?? 'something went wrong';
}

/** Plain sentences on what a finished tidy-up did. */
function tidyResultCopy({ run, assistant }: { run: MemoryTidyRun; assistant: string }): string {
  const unread = run.notesAsked - run.notesSorted;
  const reasons = [...new Set(run.unsortedReasons.map(cause => unsortedReasonCopy({ cause, assistant })))];
  const why =
    reasons.length > 0 ? ` The reason: ${new Intl.ListFormat('en', { type: 'conjunction' }).format(reasons)}.` : '';
  const unreadNote =
    unread > 0
      ? ` It could not file ${count(unread, { one: 'other note', many: 'other notes' })}. Those stay on the Memories tab.${why}`
      : '';
  const done = [
    ...(run.movedToEarlier > 0
      ? [`moved ${count(run.movedToEarlier, { one: 'ended line', many: 'ended lines' })} to Earlier`]
      : []),
    ...(run.notesSorted > 0
      ? [
          run.sorting === 'report'
            ? `wrote down where ${count(run.notesSorted, { one: 'note', many: 'notes' })} would go, without changing a page`
            : `went through ${count(run.notesSorted, { one: 'saved note', many: 'saved notes' })} and filed what belongs on a page`,
        ]
      : []),
    ...(run.pairsListed > 0
      ? [`listed ${count(run.pairsListed, { one: 'pair of lines', many: 'pairs of lines' })} that disagree`]
      : []),
  ];
  if (done.length > 0) {
    return `Done. ${assistant} ${new Intl.ListFormat('en', { type: 'conjunction' }).format(done)}.${unreadNote}`;
  }
  if (run.modelMissing) {
    return `Nothing changed. ${assistant} found no model to work with, so it only looked for facts that are over, and found none. Choose a model in Settings, then try again.`;
  }
  if (unread > 0) {
    return `Nothing changed. ${assistant} looked at ${count(unread, { one: 'saved note', many: 'saved notes' })} but could not file ${unread === 1 ? 'it' : 'any'}. Your notes stay on the Memories tab.${why} Try again, or choose another model in Settings.`;
  }
  return run.sorting === 'off'
    ? `Done. Nothing changed. Sorting is off, so ${assistant} only looked for facts that are over, and found none.`
    : 'Done. Nothing needed tidying. Every saved note was already looked at.';
}

function NightlyControl() {
  const assistant = useAssistantDisplayName();
  const setting = useMemoryNightlySetting();
  const toaster = useToasterOptional();
  const disabled = setting.saving || setting.enabled === null;
  const modelWait = setting.modelWaitMinutes ?? 10;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="memory-nightly-toggle" className="text-sm font-medium text-text-primary">
            Tidy pages once a day
          </label>
          <p className="mt-0.5 text-xs text-text-secondary">
            Once a day, {assistant} moves facts that are over, such as a trip that has ended, to the Earlier part of
            their page.
          </p>
          <p className="mt-1 text-xs text-text-secondary">When sorting above is not off, it also:</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-text-secondary">
            <li>files any saved notes that were not filed yet</li>
            <li>points out two facts that cannot both be true, so you can fix one</li>
          </ul>
          <p className="mt-1 text-xs text-text-secondary">It never deletes anything.</p>
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
            void setting.tidyNow().then(run => {
              if (run !== null) toaster?.showSuccess({ title: tidyResultCopy({ run, assistant }) });
            });
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
      <div className="flex flex-col gap-1">
        <label htmlFor="memory-helper-model-wait" className="text-xs font-medium text-text-secondary">
          Wait for the model up to
        </label>
        <select
          id="memory-helper-model-wait"
          className="w-fit rounded-md border border-border bg-primary-bg px-2 py-1.5 text-sm text-text-primary"
          value={modelWait}
          disabled={disabled}
          onChange={event => {
            const next = Number(event.target.value);
            void setting.setModelWaitMinutes(next).then(saved => {
              if (saved)
                toaster?.showSuccess({ title: `${assistant} waits up to ${minutesLabel(next)} for the model` });
            });
          }}
        >
          {[...new Set([...MODEL_WAIT_MINUTES, modelWait])]
            .sort((a, b) => a - b)
            .map(minutes => (
              <option key={minutes} value={minutes}>
                {minutesLabel(minutes)}
              </option>
            ))}
        </select>
        <p className="text-xs text-text-secondary">
          This is for each note {assistant} sorts or tidies. Choose longer when your model is slow. {assistant} stops
          sooner when the model goes silent.
        </p>
      </div>
    </div>
  );
}

/** Settings > Memory: the two helpers that work on pages while nobody is chatting. Both start on. */
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
      <p className="mt-1 text-sm text-text-secondary">
        Two helpers that keep your pages in order. Both are on unless you turn them off. They work in the background and
        use your model.
      </p>
      <div className="mt-4 border-t border-border pt-4">
        <PageSortingControl />
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <NightlyControl />
      </div>
    </section>
  );
}
