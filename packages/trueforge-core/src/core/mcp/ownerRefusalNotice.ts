/**
 * The one plain line the person reads when a tool call did not run. The reason the call failed is
 * written for the model and stays in the call's result; it names tools and gives instructions that
 * mean nothing to the person.
 */
export function stepNotFinishedNotice(assistantName: string): string {
  return `${assistantName} couldn't finish one of the steps in this reply. Ask again to try once more.`;
}
