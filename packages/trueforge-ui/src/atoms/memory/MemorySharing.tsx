'use client';

import { useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import type { MemoryVaultSharing } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

export type MemorySharingPersona = { id: string; displayName: string };

/**
 * Cross-persona sharing: which vault namespaces each persona may read.
 * Positive descriptions only: every toggle says what the persona gains.
 */
export function MemorySharing(props: {
  personas: MemorySharingPersona[];
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

  if (props.personas.length === 0) {
    return (
      <p className="text-sm text-text-secondary">No personas are configured yet, so there is nothing to share with.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Choose which vaults each persona can read. A persona always reads the shared vault; these toggles grant access
        to additional vaults.
      </p>
      {props.personas.map(persona => (
        <fieldset key={persona.id} className="rounded-xl border border-border bg-card-bg p-4">
          <legend className="px-1 text-sm font-medium text-text-primary">{persona.displayName}</legend>
          <div className="flex flex-col gap-3">
            {props.namespaces.map(namespace => {
              const enabled = (draft[persona.id] ?? []).includes(namespace.value);
              return (
                <label key={namespace.value} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-text-primary">Can read the {namespace.label} vault</span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={checked => toggle(persona.id, namespace.value, checked)}
                    disabled={saving}
                    aria-label={`${persona.displayName} can read the ${namespace.label} vault`}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
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
