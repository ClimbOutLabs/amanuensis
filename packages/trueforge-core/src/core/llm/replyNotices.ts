import type { UnbackedClaimKind } from '../runtime/replyActionChecks';

/** The line that ends a reply a repetition guard stopped. */
export const REPEAT_STOP_NOTE = 'Stopped: the reply was repeating itself.';

/**
 * The line added to a reply that claims work no step in its turn did, by the kind of claim. The
 * reply stays as written; the line says plainly what did not happen.
 */
export const UNBACKED_CLAIM_NOTES: Readonly<Record<UnbackedClaimKind, string>> = {
  clone: 'Note: no step in this reply cloned or downloaded anything, so this has not been done.',
  run: 'Note: no step in this reply ran a command, so this has not been done.',
  read: 'Note: no step in this reply read a file or page, so these details were not checked.',
  workspace: 'Note: code execution is off in this chat, so nothing was put in a workspace.',
  change: 'Nothing was changed yet: no action ran in this reply.',
};

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
