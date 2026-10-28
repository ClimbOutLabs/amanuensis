import { isCallToolResponseResult, type CallToolResponse } from '../../mcp/IMCPServer';

/**
 * The one owner of how a recipient refusal from the mail sidecar is recognised. The Email connector
 * replaces the sidecar's raw wording with a plain stop before the result goes anywhere, so a reader
 * downstream can meet either form: the raw words, or the plain stop itself.
 */

/** The ways the sidecar words its refusal when a recipient is not on the Email list. */
export const RECIPIENT_REFUSAL_WORDS = ['recipient policy denied', 'not in allowlist'];

/**
 * The plain stop that replaces the sidecar's raw refusal. The list can change between the approval check
 * and the call, or the sidecar can still be loading it, so the raw refusal can still arrive.
 */
export const RECIPIENT_NOT_LISTED =
  'The mail service refused this because a recipient is not on the Email list. Nothing was saved or sent. Do not leave the recipient off, and do not ask the person to change a list: try the same call again with every recipient named, so the person can be asked on a card. If it keeps failing, tell the person.';

/** The plain stop in the lower case the refusal checks read a result in. */
const RECIPIENT_NOT_LISTED_SAID = RECIPIENT_NOT_LISTED.toLowerCase();

/** The words of a finished call's error result, or undefined when the call did not fail. */
function errorWords(response: CallToolResponse): string | undefined {
  if (!isCallToolResponseResult(response) || response.result.isError !== true) {
    return undefined;
  }
  return response.result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .toLowerCase();
}

/** Whether a finished call's result is the sidecar's own wording of the refusal, before the plain stop replaces it. */
export function isRecipientRefusal(response: CallToolResponse): boolean {
  const said = errorWords(response);
  return said !== undefined && RECIPIENT_REFUSAL_WORDS.some(words => said.includes(words));
}

/**
 * Whether a finished call's result is the mail service refusing a recipient on policy grounds, in
 * whichever wording the dispatch settled with: the sidecar's own words, or the plain stop the Email
 * connector put in their place.
 */
export function isRecipientPolicyDenial(response: CallToolResponse): boolean {
  const said = errorWords(response);
  return (
    said !== undefined &&
    (RECIPIENT_REFUSAL_WORDS.some(words => said.includes(words)) || said.includes(RECIPIENT_NOT_LISTED_SAID))
  );
}
