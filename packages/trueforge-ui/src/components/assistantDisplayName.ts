/** The name the assistant answers to until the person names it; shown wherever a name is needed. */
export const DEFAULT_ASSISTANT_DISPLAY_NAME = 'Aman';

/** The assistant's name as the person set it, or the shared default when none is usable. */
export function assistantDisplayName(assistantName: string | null | undefined): string {
  const trimmed = assistantName?.trim();
  return trimmed ? trimmed : DEFAULT_ASSISTANT_DISPLAY_NAME;
}
