'use client';

import { useEffect, useState } from 'react';

import { Markdown } from '@/atoms/Markdown.js';
import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { copyText } from '@/utils/copyText.js';
import type { ExplorerMemory } from './memoryExplorer.js';

const COPIED_NOTE_MS = 2000;

function ownerLabel(memory: ExplorerMemory): string {
  if (memory.owner === 'persona') return memory.persona ?? 'Persona';
  return memory.owner === 'you' ? 'You' : 'Shared topic';
}

/** The time of day a memory was saved; its day is the heading it sits under. */
function savedLabel(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const SOURCE_LINE_PATTERN = /\n+> (From you|External source: [^\n]+)\s*$/;

/** A memory's text without its closing "where it came from" line, and that line's words when it has one. */
export function splitSourceLine(text: string): { body: string; source: string | null } {
  const match = SOURCE_LINE_PATTERN.exec(text);
  return match === null ? { body: text, source: null } : { body: text.slice(0, match.index), source: match[1] ?? null };
}

/** One memory: formatted text, select, edit in place, copy, and forget. Forgetting is undone from the list. */
export function MemoryVaultEntryRow(props: {
  entry: ExplorerMemory;
  /** Text to mark in the rendered memory; empty when no search is active. */
  highlight: string;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  onSave: (options: { entryId: string; text: string }) => Promise<void>;
  onForget: (id: string) => void;
}) {
  const { entry } = props;
  const shown = splitSourceLine(entry.text);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(entry.text);
    }
  }, [entry.text, editing]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleSave() {
    const text = draft.trim();
    if (text === '' || text === entry.text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ entryId: entry.id, text });
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this memory. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    setError(null);
    try {
      await copyText(entry.text);
      setCopied(true);
    } catch {
      setError('Could not copy this memory. Try again.');
    }
  }

  return (
    <li className="flex gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={props.selected}
        onChange={() => props.onToggleSelected(entry.id)}
        aria-label="Select this memory"
        className="mt-1 h-4 w-4 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {editing ? (
          <div className="flex flex-col gap-3">
            <label htmlFor={`memory-edit-${entry.id}`} className="text-xs font-medium text-text-secondary">
              Edit memory
            </label>
            <textarea
              id={`memory-edit-${entry.id}`}
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
          <>
            <Markdown content={shown.body} highlight={props.highlight} readOnly className="text-sm" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-text-secondary">
                {shown.source === null ? '' : `${shown.source} · `}
                {ownerLabel(entry)} · {savedLabel(entry.timestamp)}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {copied ? (
                  <span role="status" className="text-xs text-text-secondary">
                    Copied
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className={auiButtonClass({ variant: 'ghost', size: 'small' })}
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setError(null);
                  }}
                  className={auiButtonClass({ variant: 'ghost', size: 'small' })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => props.onForget(entry.id)}
                  className={auiButtonClass({ variant: 'ghost', size: 'small' })}
                >
                  Forget
                </button>
              </div>
            </div>
          </>
        )}
        {error !== null ? (
          <p role="alert" className="text-xs text-error-text">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
