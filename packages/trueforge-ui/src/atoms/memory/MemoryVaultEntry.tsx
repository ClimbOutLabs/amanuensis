'use client';

import { useEffect, useState } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { Icon } from '@/icons/Icon.js';
import type { MemoryVaultEntry } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

/** One fact in the vault: read view, inline edit, and delete. */
export function MemoryVaultEntryRow(props: {
  entry: MemoryVaultEntry;
  onSave: (options: { entryId: string; text: string }) => Promise<void>;
  onDelete: (entryId: string) => Promise<void>;
}) {
  const { entry } = props;
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(entry.text);
    }
  }, [entry.text, editing]);

  async function handleSave() {
    const text = draft.trim();
    if (text === '' || text === entry.text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ entryId: entry.id, text });
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this fact.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDelete(entry.id);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete this fact.');
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const date = new Date(entry.timestamp);
  const timestampLabel = Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString();

  return (
    <li className="rounded-xl border border-border bg-card-bg p-4">
      {editing ? (
        <div className="flex flex-col gap-3">
          <label htmlFor={`vault-edit-${entry.id}`} className="text-xs font-medium text-text-secondary">
            Edit fact
          </label>
          <textarea
            id={`vault-edit-${entry.id}`}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            rows={3}
            disabled={busy}
            className={cn(
              'w-full rounded-md border border-border bg-primary-bg px-3 py-2 text-sm text-text-primary',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
            )}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || draft.trim() === '' || draft.trim() === entry.text}
              className={auiButtonClass({ variant: 'primary', size: 'small' })}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(entry.text);
                setError(null);
              }}
              disabled={busy}
              className={auiButtonClass({ variant: 'ghost', size: 'small' })}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-primary whitespace-pre-wrap">{entry.text}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">{timestampLabel}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={`Edit fact ${entry.id}`}
                title="Edit"
                onClick={() => {
                  setEditing(true);
                  setConfirmingDelete(false);
                  setError(null);
                }}
                className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
              >
                <Icon name="pencil" className="h-4 w-4" />
              </button>
              {confirmingDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={busy}
                    className={auiButtonClass({ variant: 'destructive', size: 'small' })}
                  >
                    {busy ? 'Deleting…' : 'Delete this fact'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    className={auiButtonClass({ variant: 'ghost', size: 'small' })}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete fact ${entry.id}`}
                  title="Delete"
                  onClick={() => {
                    setConfirmingDelete(true);
                    setError(null);
                  }}
                  className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {error !== null && !editing ? (
        <p role="alert" className="mt-2 text-xs text-error-text">
          {error}
        </p>
      ) : null}
      {error !== null && editing ? (
        <p role="alert" className="text-xs text-error-text">
          {error}
        </p>
      ) : null}
    </li>
  );
}
