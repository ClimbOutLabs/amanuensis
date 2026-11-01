import { DEFAULT_ASSISTANT_NAME } from '@truefoundry/trueforge-core/core/personas/assistantName';

/** The assistant's name as the person chose it, or the default when they have not chosen one. */
export function assistantDisplayName(assistantName: string | null | undefined): string {
  return assistantName?.trim() || DEFAULT_ASSISTANT_NAME;
}
