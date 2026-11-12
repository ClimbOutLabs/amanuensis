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
type SharingRow = { key: string; label: string; main: boolean };

/** One column of the grid: a collection of notes a row's persona can be granted. A persona column
 * knows its persona's key, so the crossing with that persona's own row can be left blank. */
type SharingColumn = { value: string; label: string; personaKey: string | null };

/** One grant a box can change: a collection of notes, by the name a person sees for it. */
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
    { key: MAIN_ASSISTANT_SHARING_KEY, label: props.assistant, main: true },
    ...listed.map(persona => ({ key: persona.key, label: persona.label, main: false })),
  ];

  // The main assistant keeps no notes of its own, so it is a row but never a column. Topic
  // collections follow the persona columns, as they followed the persona boxes before.
  const columns: SharingColumn[] = [
    ...listed.map(persona => ({ value: persona.namespace, label: persona.label, personaKey: persona.key })),
    ...props.namespaces.map(namespace => ({ value: namespace.value, label: namespace.label, personaKey: null })),
  ];
  const firstTopicIndex = listed.length;

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
      {/* Relative so the scroll box clips the hidden "Its own notes" labels; otherwise they widen the page. */}
      <div className="relative overflow-x-auto rounded-[0.75rem] border border-border bg-card-bg">
        <table
          aria-label="Which notes each persona can read"
          className="w-full border-collapse text-left text-[0.875rem] text-text-primary"
        >
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="sticky left-0 min-w-[10rem] bg-card-bg px-3 py-2.5 font-medium text-text-secondary"
              >
                Can also read notes from
              </th>
              {columns.map((column, index) => (
                <th
                  key={column.value}
                  scope="col"
                  className={`min-w-[4rem] px-2 py-2.5 text-center font-medium${
                    index === firstTopicIndex && firstTopicIndex > 0 ? ' border-l border-border' : ''
                  }`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(row => {
              const granted = shares[row.key] ?? [];
              const anyOn = columns.some(column => column.personaKey !== row.key && granted.includes(column.value));
              return (
                <tr key={row.key}>
                  <th scope="row" className="sticky left-0 bg-card-bg px-3 py-2.5 align-top font-normal">
                    <span className="block">{row.label}</span>
                    {anyOn ? null : (
                      <span className="block text-text-muted">
                        {row.main ? 'Only the shared notes' : 'Only its own notes'}
                      </span>
                    )}
                  </th>
                  {columns.map((column, index) => (
                    <td
                      key={column.value}
                      className={`px-2 py-2.5 text-center${
                        index === firstTopicIndex && firstTopicIndex > 0 ? ' border-l border-border' : ''
                      }`}
                    >
                      {column.personaKey === row.key ? (
                        <>
                          <span aria-hidden="true" className="text-text-muted">
                            ·
                          </span>
                          <span className="sr-only">Its own notes</span>
                        </>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={column.label}
                          className="aui-sharing-box size-4 cursor-pointer accent-primary-button-bg"
                          checked={granted.includes(column.value)}
                          onChange={event => toggle({ row, choice: column, on: event.target.checked })}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
