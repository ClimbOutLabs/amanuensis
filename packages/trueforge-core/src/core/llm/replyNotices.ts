/** The line that ends a reply a repetition guard stopped. */
export const REPEAT_STOP_NOTE = 'Stopped: the reply was repeating itself.';

/** The line added to a reply that says an action was done when no write call succeeded in its turn. */
export const UNBACKED_CLAIM_NOTE = 'Nothing was changed yet: no action ran in this reply.';

/** The line added when the model wrote an action as text, that text was not run, and no write succeeded. */
export const TOOL_MARKUP_NOTICE =
  'The model wrote an action as text instead of doing it, so nothing was changed. Ask again, or switch to another model in Settings, Models.';

/** The text to append that sets a notice off from the answer text before it by a paragraph break. */
export function noticeAfter({ text, notice }: { text: string; notice: string }): string {
  if (text === '' || text.endsWith('\n\n')) {
    return notice;
  }
  return `${text.endsWith('\n') ? '\n' : '\n\n'}${notice}`;
}
