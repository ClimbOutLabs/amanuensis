'use client';

export const CARD = 'border-border rounded-xl border p-4';
export const INPUT = 'border-border bg-transparent text-text-primary rounded-lg border px-2 py-1 text-sm';
export const BUTTON =
  'text-text-primary border-border hover:bg-ghost-button-hover rounded-lg border px-3 py-1.5 text-sm';

export function Check({
  label,
  checked,
  disabled = false,
  note,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  note?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="text-text-primary">
        {label}
        {note === undefined ? null : <span className="text-text-secondary block">{note}</span>}
      </span>
    </label>
  );
}
