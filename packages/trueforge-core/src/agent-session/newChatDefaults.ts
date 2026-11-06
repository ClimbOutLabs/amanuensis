/**
 * What a brand-new chat starts on, wherever it is made: the app's first chat, a chat the server opens itself, or a
 * model just picked. The skills are names only; they mount only where the sandbox is on.
 */
export const DEFAULT_NEW_CHAT_SKILLS: readonly string[] = ['web-artifacts-builder'];

/**
 * The reasoning effort a new chat starts at: "medium" when the model offers it, else the lowest real effort listed
 * (catalog lists are ordered lowest first), else "none" when that is the only one. Undefined when the model lists
 * none.
 */
export function defaultReasoningEffort(efforts: readonly string[] | null | undefined): string | undefined {
  if (efforts?.includes('medium') === true) {
    return 'medium';
  }
  return efforts?.find(effort => effort !== 'none') ?? efforts?.[0];
}
