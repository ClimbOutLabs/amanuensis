/** The assistant name used when the person has not set one. The server prompt and the UI both read it from here. */
export const DEFAULT_ASSISTANT_NAME = 'Aman';

/** The assistant name the person sees: the one they set, or the default when it is missing or blank. */
export function assistantDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === '' ? DEFAULT_ASSISTANT_NAME : trimmed;
}
