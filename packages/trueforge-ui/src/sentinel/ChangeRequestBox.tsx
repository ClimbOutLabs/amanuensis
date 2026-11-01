'use client';

import { useEffect, useId, useRef, useState, type FC, type FormEvent } from 'react';

import { Button } from '../atoms/primitives/Button.js';

export type ChangeRequestBoxProps = {
  /** Gets the trimmed text. The box never sends an empty request. */
  onSend: (text: string) => void;
  onCancel: () => void;
  disabled?: boolean;
};

/** A small text box that asks for a change. Enter sends, Escape cancels. */
export const ChangeRequestBox: FC<ChangeRequestBoxProps> = ({ onSend, onCancel, disabled = false }) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const trimmed = text.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || trimmed === '') return;
    onSend(trimmed);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded border border-border bg-primary-bg px-3 py-2">
      <label htmlFor={inputId} className="font-medium text-text-primary">
        What should change?
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        value={text}
        disabled={disabled}
        onChange={event => {
          setText(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onCancel();
        }}
        className="h-8 rounded border border-input-border bg-card-bg px-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-focus-ring"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="small" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="small" disabled={disabled || trimmed === ''}>
          Send
        </Button>
      </div>
    </form>
  );
};
