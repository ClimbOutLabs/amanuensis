'use client';

import { useId, useState, type FC } from 'react';

import { auiInputClass } from '../atoms/lib/inputClasses.js';
import type { SentinelApprovalCard } from './types.js';

export type MailFromPickerProps = {
  /** Every account the person could pick; the picker shows only when there are at least two. */
  choices: readonly string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

/**
 * The From picker on a mail approval card: which connected account the mail goes from. Changing it
 * here, before approving, is the only way the account changes; the send itself always uses the
 * account the approval names.
 */
export const MailFromPicker: FC<MailFromPickerProps> = ({ choices, value, onChange, disabled = false }) => {
  const id = useId();
  if (choices.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-text-secondary">
        From
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        className={auiInputClass('h-9 min-w-0 flex-1')}
      >
        {choices.map(choice => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    </div>
  );
};

/** The pick state a mail card holds: the account it starts on, and the pick to send with an approval. */
export function useMailFromPick(card: SentinelApprovalCard): {
  choices: readonly string[];
  value: string;
  onChange: (value: string) => void;
  /** The picked account when the card offers a choice; undefined when there is nothing to pick. */
  picked: string | undefined;
} {
  const choices = card.mail_from_choices ?? [];
  const [value, setValue] = useState<string>(card.mail_from ?? choices[0] ?? '');
  return {
    choices,
    value,
    onChange: setValue,
    picked: choices.length > 1 && value !== '' ? value : undefined,
  };
}
