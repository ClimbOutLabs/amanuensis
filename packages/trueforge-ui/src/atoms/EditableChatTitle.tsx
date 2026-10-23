'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { CHAT_TITLE_MAX_LENGTH, normalizeChatTitle, useSaveChatTitle } from '../hooks/useChatTitleSave.js';
import { auiInputClass } from './lib/inputClasses.js';

/**
 * Chat title in the header. Tap to rename: Enter or leaving the field saves, Escape cancels.
 * Blank titles are never saved; leaving the field with a blank title restores the old name.
 */
export function EditableChatTitle({ sessionId, title }: { sessionId: string; title: string }) {
  const saveTitle = useSaveChatTitle();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once an edit has been saved or cancelled, so a blur that follows Enter or Escape does nothing.
  const settledRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && !busy) inputRef.current?.focus();
  }, [busy, editing]);

  const startEditing = () => {
    settledRef.current = false;
    setDraft(title);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setError(null);
    setEditing(false);
  };

  const submit = async ({ fromBlur }: { fromBlur: boolean }) => {
    if (settledRef.current || saveTitle === null) return;
    const next = normalizeChatTitle(draft);
    if (next.length === 0) {
      if (fromBlur) cancel();
      return;
    }
    if (next === title) {
      cancel();
      return;
    }
    settledRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveTitle({ sessionId, title: next });
      setEditing(false);
    } catch (saveError) {
      settledRef.current = false;
      setError(
        saveError instanceof Error && saveError.message ? saveError.message : 'Could not rename this chat. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void submit({ fromBlur: false });
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label="Rename chat"
        title="Rename chat"
        onClick={startEditing}
        className="focus-visible:ring-focus-ring/40 min-w-0 truncate rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {title}
      </button>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void submit({ fromBlur: true })}
        maxLength={CHAT_TITLE_MAX_LENGTH}
        aria-label="Chat title"
        aria-invalid={error !== null}
        disabled={busy}
        className={auiInputClass('h-9 w-80 max-w-full min-w-0 text-base font-semibold')}
      />
      {error !== null ? (
        <span role="alert" className="text-xs font-normal text-failure-bg">
          {error}
        </span>
      ) : null}
    </span>
  );
}
