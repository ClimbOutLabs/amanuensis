'use client';

import { Switch } from '@/atoms/primitives/Switch.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import type { PageSortMode } from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryHelpersCatalog.js';
import { useToasterOptional } from '../ToasterContainer.js';
import { useMemoryNightlySetting, useMemoryPageSortingSetting } from './memoryHelperSettings.js';

const NEEDS_MARKDOWN =
  'This needs memory kept as Markdown files. This server keeps memory another way, so this stays off. Ask whoever runs this server to switch memory to Markdown files.';

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

function PageSortingControl({ markdown }: { markdown: boolean }) {
  const assistant = useAssistantDisplayName();
  const setting = useMemoryPageSortingSetting();
  const toaster = useToasterOptional();
  const disabled = !markdown || setting.saving || setting.mode === null;
  const choices = sortChoices(assistant);
  const selected = markdown ? setting.mode : 'off';

  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="text-sm font-medium text-text-primary">Sort what Aman saves onto pages</legend>
      <p className="mt-0.5 text-xs text-text-secondary">This uses the model while you are not chatting.</p>
      {markdown ? null : <p className="mt-1.5 text-xs text-text-secondary">{NEEDS_MARKDOWN}</p>}
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

function NightlyControl({ markdown }: { markdown: boolean }) {
  const assistant = useAssistantDisplayName();
  const setting = useMemoryNightlySetting();
  const toaster = useToasterOptional();
  const disabled = !markdown || setting.saving || setting.enabled === null;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="memory-nightly-toggle" className="text-sm font-medium text-text-primary">
          Tidy pages once a day
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">
          In the night, {assistant} moves lines that have ended to Earlier, sorts notes that were missed, and lists
          lines that disagree. This uses the model while you are not chatting.
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          Sorting missed notes follows the sorting choice above. With sorting off, {assistant} only moves ended lines.
        </p>
        {markdown ? null : <p className="mt-1.5 text-xs text-text-secondary">{NEEDS_MARKDOWN}</p>}
        {setting.error === null ? null : (
          <p className="mt-1.5 text-xs text-danger" role="alert">
            {setting.error}
          </p>
        )}
      </div>
      <Switch
        id="memory-nightly-toggle"
        checked={markdown && setting.enabled === true}
        disabled={disabled}
        onCheckedChange={next => {
          void setting.setEnabled(next).then(saved => {
            if (saved) toaster?.showSuccess({ title: next ? 'Daily tidy-up is on' : 'Daily tidy-up is off' });
          });
        }}
        aria-label="Tidy pages once a day"
      />
    </div>
  );
}

/** Settings > Memory: the two helpers that work on pages while nobody is chatting. Both start off. */
export function MemoryHelpersCard({ markdown }: { markdown: boolean }) {
  const sorting = useMemoryPageSortingSetting();
  const nightly = useMemoryNightlySetting();
  // Hidden when the server is not this app's own: no heading, no empty box.
  if (!sorting.supported && !nightly.supported) return null;
  return (
    <section aria-labelledby="memory-helpers-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id="memory-helpers-heading" className="text-sm font-medium text-text-primary">
        Pages
      </h4>
      <p className="mt-1 text-sm text-text-secondary">Both of these start off. Switch them on when you want them.</p>
      <div className="mt-4 border-t border-border pt-4">
        <PageSortingControl markdown={markdown} />
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <NightlyControl markdown={markdown} />
      </div>
    </section>
  );
}
