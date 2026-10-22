/** The name the assistant goes by before the person picks one. */
export const DEFAULT_ASSISTANT_NAME = 'Aman';

/** The assistant's name as the person chose it, or the default when they have not chosen one. */
export function assistantDisplayName(assistantName: string | null | undefined): string {
  return assistantName?.trim() || DEFAULT_ASSISTANT_NAME;
}
