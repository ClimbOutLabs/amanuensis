import { cn } from './cn.js';

const baseClasses =
  'w-full cursor-text rounded-md border border-input-border bg-input-box-bg px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-focus-ring/40 disabled:cursor-not-allowed';

/**
 * Shared text-input / textarea className helper. Callers add height, shadow, or
 * layout via `className` (e.g. `auiInputClass('h-11 shadow-sm')`) so the token
 * surface, border, and focus ring stay identical across every settings form.
 */
export function auiInputClass(className?: string): string {
  return cn(baseClasses, className);
}

const settingsClasses =
  'w-full rounded-md border border-border/70 bg-input-box-bg px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus-visible:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring/50';

/**
 * The settings-form input look: the taller field with a soft border and a
 * border-shifting focus state that the personalization, persona, and learned
 * profile forms share. Callers add sizing via `className`, as with `auiInputClass`.
 */
export function auiSettingsInputClass(className?: string): string {
  return cn(settingsClasses, className);
}
