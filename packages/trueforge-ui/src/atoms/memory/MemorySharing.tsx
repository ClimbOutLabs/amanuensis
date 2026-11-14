'use client';

import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { useRef, useState } from 'react';

import {
  personaVaultNamespace,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

export type MemorySharingPersona = { id: string; displayName: string };

/** One reader: the main assistant or a persona, and the key its grants are saved under. */
type SharingRow = { key: string; label: string; main: boolean };

/** One set of notes a reader can be granted. A persona's set knows its persona's key, so a reader is
 * never offered its own notes. */
type SharingChoice = { value: string; label: string; personaKey: string | null };

const SAVE_FAILED_LINE = 'That change was not saved. Check your connection, then try again.';

/** The shares with one grant turned on or off; a row with nothing granted is left out. */
function withGrant({
  shares,
  key,
  namespace,
  on,
}: {
  shares: Record<string, string[]>;
  key: string;
  namespace: string;
  on: boolean;
}): Record<string, string[]> {
  const current = shares[key] ?? [];
  const next = on ? Array.from(new Set([...current, namespace])) : current.filter(item => item !== namespace);
  const copy = { ...shares };
  if (next.length === 0) delete copy[key];
  else copy[key] = next;
  return copy;
}

/** "Ada", "Ada and Ben", "Ada, Ben and Cy", then "Ada, Ben and 3 more": a line that stays short. */
function namesInWords(names: readonly string[]): string {
  const [first = '', second = '', third = ''] = names;
  if (names.length <= 1) return first;
  if (names.length === 2) return `${first} and ${second}`;
  if (names.length === 3) return `${first}, ${second} and ${third}`;
  return `${first}, ${second} and ${String(names.length - 2)} more`;
}

/**
 * Which other personas' notes each persona can read. Everything the person says about themselves is
 * shared with every persona already; this only adds a persona's own notes to another's reading. Each
 * reader is one row that says what it reads in words; its boxes open on request, so the screen stays
 * short however many personas there are. Each change saves as it is made.
 */
export function MemorySharing(props: {
  personas: MemorySharingPersona[];
  /** The main assistant's display name; it reads the shared notes and keeps none of its own. */
  assistant: string;
  /** Display names of the personas that have notes of their own. */
  personasWithNotes: ReadonlySet<string>;
  /** Topic collections, offered to every reader after the personas. */
  namespaces: Array<{ value: string; label: string }>;
  sharing: MemoryVaultSharing;
  onSave: (sharing: MemoryVaultSharing) => Promise<void>;
}) {
  const [shares, setShares] = useState<Record<string, string[]>>(() => ({ ...props.sharing.shares }));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  /** The reader whose boxes are open; one at a time keeps the list short. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const confirmed = useRef<Record<string, string[]>>({ ...props.sharing.shares });
  // Saves run one after another, so a quick second change never lands before the first.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The Help persona is listed only when it keeps notes of its own, and then by what it is for.
  const listed = props.personas
    .filter(persona => persona.displayName !== AMAN_GUIDE_NAME || props.personasWithNotes.has(AMAN_GUIDE_NAME))
    .map(persona => ({
      key: persona.id,
      label: persona.displayName === AMAN_GUIDE_NAME ? 'Help' : persona.displayName,
      namespace: personaVaultNamespace(persona.displayName),
    }));
  const rows: SharingRow[] = [
    { key: MAIN_ASSISTANT_SHARING_KEY, label: props.assistant, main: true },
    ...listed.map(persona => ({ key: persona.key, label: persona.label, main: false })),
  ];

  // The main assistant keeps no notes of its own, so it reads but is never offered.
  const personaChoices: SharingChoice[] = listed.map(persona => ({
    value: persona.namespace,
    label: persona.label,
    personaKey: persona.key,
  }));
  const topicChoices: SharingChoice[] = props.namespaces.map(namespace => ({
    value: namespace.value,
    label: namespace.label,
    personaKey: null,
  }));

  function toggle({ row, choice, on }: { row: SharingRow; choice: SharingChoice; on: boolean }) {
    const next = withGrant({ shares, key: row.key, namespace: choice.value, on });
    setShares(next);
    setStatus('saving');
    queue.current = queue.current.then(async () => {
      try {
        await props.onSave({ shares: next });
        confirmed.current = next;
        setStatus('saved');
      } catch {
        // Show what is really saved, and say what to do.
        setShares(confirmed.current);
        setStatus('failed');
      }
    });
  }

  if (listed.length === 0) {
    return (
      <p className="text-[0.875rem] text-text-secondary">
        No personas keep notes of their own yet, so there is nothing to share.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 font-sans">
      <p className="m-0 text-[0.875rem] text-text-secondary">
        Everything you tell any persona about yourself is shared with all of them. Each persona also keeps its own
        notes. Choose which other personas’ notes each one can read.
      </p>
      <ul
        aria-label="Which notes each persona can read"
        className="m-0 list-none divide-y divide-border rounded-[0.75rem] border border-border bg-card-bg p-0 text-[0.875rem] text-text-primary"
      >
        {rows.map(row => {
          const granted = shares[row.key] ?? [];
          const offered = [...personaChoices, ...topicChoices].filter(choice => choice.personaKey !== row.key);
          const reading = offered.filter(choice => granted.includes(choice.value)).map(choice => choice.label);
          const open = openKey === row.key;
          const boxes = (choices: SharingChoice[]) =>
            choices
              .filter(choice => choice.personaKey !== row.key)
              .map(choice => {
                const on = granted.includes(choice.value);
                return (
                  <label
                    key={choice.value}
                    className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 ${
                      on ? 'border-text-primary bg-secondary-bg' : 'border-border'
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={choice.label}
                      className="aui-sharing-box size-4 cursor-pointer accent-primary-button-bg"
                      checked={on}
                      onChange={event => toggle({ row, choice, on: event.target.checked })}
                    />
                    <span aria-hidden="true">{choice.label}</span>
                  </label>
                );
              });
          return (
            <li key={row.key} aria-label={row.label} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="block font-medium">{row.label}</span>
                  {reading.length === 0 ? (
                    <span className="block text-text-muted">
                      {row.main ? 'Only the shared notes' : 'Only its own notes'}
                    </span>
                  ) : (
                    <span className="block text-text-secondary">Also reads notes from {namesInWords(reading)}</span>
                  )}
                </div>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={open ? `Close the choices for ${row.label}` : `Select what ${row.label} can read`}
                  className="shrink-0 cursor-pointer rounded-full border border-border bg-transparent px-3 py-1.5 text-[0.8125rem] text-text-primary hover:bg-ghost-button-hover"
                  onClick={() => setOpenKey(open ? null : row.key)}
                >
                  {open ? 'Done' : 'Select'}
                </button>
              </div>
              {open ? (
                <div className="mt-3 flex flex-col gap-3">
                  <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
                    <legend className="mb-2 p-0 text-[0.8125rem] text-text-secondary">Can also read notes from</legend>
                    {boxes(personaChoices)}
                  </fieldset>
                  {topicChoices.length > 0 ? (
                    <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
                      <legend className="mb-2 p-0 text-[0.8125rem] text-text-secondary">Topics</legend>
                      {boxes(topicChoices)}
                    </fieldset>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p role="status" aria-live="polite" className="m-0 min-h-[1.25rem] text-[0.8125rem] text-text-secondary">
        {status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : ''}
      </p>
      {status === 'failed' ? (
        <p role="alert" className="m-0 text-[0.8125rem] text-error-text">
          {SAVE_FAILED_LINE}
        </p>
      ) : null}
    </div>
  );
}
