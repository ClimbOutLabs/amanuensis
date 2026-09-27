/** Plain-text content of an assistant model message, `openai` chat-completion shaped. */
export function formatAssistantMessageText(
  content: string | ({ type: 'text'; text: string } | { type: 'refusal'; refusal: string })[] | null | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!content) {
    return '';
  }
  return content.map(part => (part.type === 'text' ? part.text : part.refusal)).join('\n');
}
