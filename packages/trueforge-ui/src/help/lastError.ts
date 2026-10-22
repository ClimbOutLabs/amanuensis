/**
 * The text of the last error message the person saw, so the help chat can say what went wrong.
 * It lives in memory only and is never stored, sent or logged by the app.
 */
let lastErrorText: string | null = null;

export function rememberErrorText(text: string): void {
  const trimmed = text.trim();
  lastErrorText = trimmed === '' ? null : trimmed;
}

export function readLastErrorText(): string | null {
  return lastErrorText;
}
