'use client';

import { useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { Icon } from '@/icons/Icon.js';
import {
  personaVaultNamespace,
  type MemoryVaultSharing,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

export type MemorySharingPersona = { id: string; displayName: string };

/** One chip on a specialist's row. `subject` completes "X can see …" for the accessible name. */
type SharingChoice = { value: string; label: string; subject: string };

/** The choices a specialist can be given: the other specialists, then the topics. */
function sharingChoices(options: {
  persona: MemorySharingPersona;
  personas: MemorySharingPersona[];
  topics: Array<{ value: string; label: string }>;
}): { specialists: SharingChoice[]; topics: SharingChoice[] } {
  const specialists = options.personas
    .filter(other => other.id !== options.persona.id)
    .map(other => ({
      value: personaVaultNamespace(other.displayName),
      label: other.displayName,
      subject: `${other.displayName}'s memories`,
    }));
  const topics = options.topics.map(topic => ({
    value: topic.value,
    label: topic.label,
    subject: `the ${topic.label} memories`,
  }));
  return { specialists, topics };
}

/**
 * Cross-specialist sharing: which memory namespaces each specialist may read.
 * Each row is one specialist; its chips are the memories it can also see.
 */
export function MemorySharing(props: {
  personas: MemorySharingPersona[];
  /** Topic memories, offered to every specialist alongside the other specialists. */
  namespaces: Array<{ value: string; label: string }>;
  sharing: MemoryVaultSharing;
  onSave: (sharing: MemoryVaultSharing) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string[]>>(() => ({ ...props.sharing.shares }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(personaId: string, namespace: string, enabled: boolean) {
    setSaved(false);
    setDraft(previous => {
      const current = previous[personaId] ?? [];
      const next = enabled ? Array.from(new Set([...current, namespace])) : current.filter(item => item !== namespace);
      const copy = { ...previous };
      if (next.length === 0) {
        delete copy[personaId];
      } else {
        copy[personaId] = next;
      }
      return copy;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await props.onSave({ shares: draft });
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save sharing settings.');
    } finally {
      setSaving(false);
    }
  }

  function renderChip(persona: MemorySharingPersona, choice: SharingChoice, granted: string[]) {
    const on = granted.includes(choice.value);
    return (
      <button
        key={choice.value}
        type="button"
        aria-pressed={on}
        aria-label={`${persona.displayName} can see ${choice.subject}`}
        disabled={saving}
        onClick={() => toggle(persona.id, choice.value, !on)}
        className="aui-chip focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring disabled:opacity-60"
      >
        {on ? <Icon name="check" className="h-3 w-3 shrink-0" /> : null}
        {choice.label}
      </button>
    );
  }

  if (props.personas.length === 0) {
    return <p className="text-sm text-text-secondary">No specialists are set up yet, so there is nothing to share.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Every specialist sees the shared memories. Choose whose own memories each one can also see.
      </p>
      <ul aria-label="Memory sharing by specialist" className="flex flex-col gap-3">
        {props.personas.map(persona => {
          const { specialists, topics } = sharingChoices({
            persona,
            personas: props.personas,
            topics: props.namespaces,
          });
          const granted = draft[persona.id] ?? [];
          const anyOn = [...specialists, ...topics].some(choice => granted.includes(choice.value));
          return (
            <li key={persona.id} className="aui-row aui-row--2 aui-row--stack aui-row--sharing">
              <div className="min-w-0">
                <span className="text-sm font-medium text-text-primary">{persona.displayName}</span>
                {anyOn ? null : <span className="block text-xs text-text-secondary">None</span>}
              </div>
              {specialists.length === 0 && topics.length === 0 ? (
                <p className="text-sm text-text-secondary">No other specialists to share with yet.</p>
              ) : (
                <div className="flex min-w-0 flex-col gap-2">
                  {specialists.length > 0 ? (
                    <div
                      className="flex min-w-0 flex-wrap gap-1.5"
                      role="group"
                      aria-label={`What ${persona.displayName} can see`}
                    >
                      {specialists.map(choice => renderChip(persona, choice, granted))}
                    </div>
                  ) : null}
                  {topics.length > 0 ? (
                    <div
                      className="flex min-w-0 flex-wrap items-center gap-1.5"
                      role="group"
                      aria-label={`Topics ${persona.displayName} can see`}
                    >
                      <span className="text-xs text-text-secondary">Topics:</span>
                      {topics.map(choice => renderChip(persona, choice, granted))}
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className={auiButtonClass({ variant: 'primary', size: 'large' })}
        >
          {saving ? 'Saving…' : 'Save sharing'}
        </button>
        {saved ? (
          <span role="status" className="text-xs text-success-bg">
            Sharing saved.
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-error-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
