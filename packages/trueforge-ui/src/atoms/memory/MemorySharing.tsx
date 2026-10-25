'use client';

import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { useRef, useState } from 'react';

import {
  personaVaultNamespace,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

export type MemorySharingPersona = { id: string; displayName: string };

/** One persona row: who reads, and the key its grants are saved under. */
type SharingRow = { key: string; label: string; main: boolean; namespace: string | null };

/** One box on a row: a collection of notes the row's persona can also read. */
type SharingChoice = { value: string; label: string };

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

/**
 * Which other personas' notes each persona can read. Everything the person says about themselves is
 * shared with every persona already; this only adds a persona's own notes to another's reading. Each
 * change saves as it is made.
 */
export function MemorySharing(props: {
  personas: MemorySharingPersona[];
  /** The main assistant's display name; it reads the shared notes and keeps none of its own. */
  assistant: string;
  /** Display names of the personas that have notes of their own. */
  personasWithNotes: ReadonlySet<string>;
  /** Topic collections, offered on every row after the personas. */
  namespaces: Array<{ value: string; label: string }>;
  sharing: MemoryVaultSharing;
  onSave: (sharing: MemoryVaultSharing) => Promise<void>;
}) {
  const [shares, setShares] = useState<Record<string, string[]>>(() => ({ ...props.sharing.shares }));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const confirmed = useRef<Record<string, string[]>>({ ...props.sharing.shares });
  // Saves run one after another, so a quick second change never lands before the first.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The Help persona is listed only when it keeps notes of its own, and then by what it is for.
  const listed = props.personas
    .filter(persona => persona.displayName !== AMAN_GUIDE_NAME || props.personasWithNotes.has(AMAN_GUIDE_NAME))
    .map(persona => ({
      key: persona.id,
      label: persona.displayName === AMAN_GUIDE_NAME ? 'Help' : persona.displayName,
      main: false,
      namespace: personaVaultNamespace(persona.displayName),
    }));
  const rows: SharingRow[] = [
    { key: MAIN_ASSISTANT_SHARING_KEY, label: props.assistant, main: true, namespace: null },
    ...listed,
  ];

  function choicesFor(row: SharingRow): SharingChoice[] {
    return [
      ...listed.filter(other => other.key !== row.key).map(other => ({ value: other.namespace, label: other.label })),
      ...props.namespaces,
    ];
  }

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
      <ul aria-label="Which notes each persona can read" className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(row => {
          const choices = choicesFor(row);
          const granted = shares[row.key] ?? [];
          const anyOn = choices.some(choice => granted.includes(choice.value));
          const lead = `${row.label} can also read notes from`;
          return (
            <li
              key={row.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[0.75rem] border border-border bg-card-bg px-3 py-2.5 text-[0.875rem] text-text-primary"
            >
              <span>{lead}:</span>
              <div role="group" aria-label={lead} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {choices.map(choice => (
                  <label key={choice.value} className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="aui-sharing-box size-4 accent-primary-button-bg"
                      checked={granted.includes(choice.value)}
                      onChange={event => toggle({ row, choice, on: event.target.checked })}
                    />
                    {choice.label}
                  </label>
                ))}
              </div>
              {anyOn ? null : (
                <span className="text-text-muted">{row.main ? 'Only the shared notes' : 'Only its own notes'}</span>
              )}
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
