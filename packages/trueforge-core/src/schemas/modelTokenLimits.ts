// Explicit .js: trueforge-ui compiles this file under nodenext resolution.
import { TOKEN_BUDGET_SAFETY_MARGIN } from '../core/capabilities/builtins/tokenBudgetConstants.js';

/**
 * Single owner of the model token-limit validation rule.
 * The runtime pre-flight guard fails a turn once input + max output + the
 * safety margin reaches the context length, so a model whose max output plus
 * the margin already reaches it fails every turn. The server schema, the
 * provider-reported limits mapper, and the UI form all use this helper.
 */

/**
 * Returns the error message when max output tokens plus the safety margin
 * reaches the context length, or null when the combination is valid.
 */
export function getModelOutputExceedsContextError(properties: {
  context_length?: number | null | undefined;
  max_output_tokens?: number | null | undefined;
}): string | null {
  const { context_length: contextLength, max_output_tokens: maxOutputTokens } = properties;
  if (
    contextLength != null &&
    maxOutputTokens != null &&
    maxOutputTokens + TOKEN_BUDGET_SAFETY_MARGIN >= contextLength
  ) {
    return `Max output tokens must be less than the context length (${contextLength.toLocaleString('en-US')}) minus a small reserve.`;
  }
  return null;
}
