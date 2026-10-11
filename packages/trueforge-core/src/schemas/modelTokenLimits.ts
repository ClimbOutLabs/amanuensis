/**
 * Single owner of the model token-limit validation rule.
 * A model that reserves its whole context window for output leaves no room
 * for input, so every turn fails the token pre-flight guard. Both the server
 * schema and the UI form use this helper instead of duplicating the rule.
 */

/** Error shown when max output tokens covers the whole context window. */
export const MODEL_OUTPUT_EXCEEDS_CONTEXT_MESSAGE = 'Max output must be smaller than the context length.';

/**
 * Returns the error message when max output tokens is greater than or equal
 * to the context length, or null when the combination is valid.
 */
export function getModelOutputExceedsContextError(properties: {
  context_length: number | null | undefined;
  max_output_tokens: number | null | undefined;
}): string | null {
  const { context_length: contextLength, max_output_tokens: maxOutputTokens } = properties;
  if (contextLength != null && maxOutputTokens != null && maxOutputTokens >= contextLength) {
    return MODEL_OUTPUT_EXCEEDS_CONTEXT_MESSAGE;
  }
  return null;
}
