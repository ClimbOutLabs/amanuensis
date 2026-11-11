/**
 * Tier rules for the notes folder tools. The folder is the person's own notes on the computer
 * Aman runs on, and nothing in it reaches anyone else, so reads and the two add-only writes run
 * without asking (Tier 1), the same way a reminder does. One exception lives in the classifier,
 * not here: once a chat has read content that is not the person's own words, a write asks
 * first with a card, because the write may have been asked for by that content. The writes are shaped so they cannot
 * change a word the person already wrote: an append only adds an entry to the one inbox file
 * the person named, and a create only makes a file that does not exist yet. An unknown notes
 * tool fails closed.
 */
import {
  APPEND_TO_INBOX_TOOL_NAME,
  isNotesFolderReadToolName,
  isNotesFolderWriteToolName,
  SEARCH_NOTES_TOOL_NAME,
} from '../notes/toolContract';
import type { SentinelAction } from './classifier';
import { failClosedDecision, tier1Decision, type TierDecision } from './tier';

export function classifyNotesFolderTool(action: SentinelAction): TierDecision {
  if (isNotesFolderReadToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'notes_read',
      reason_detail: action.tool_name === SEARCH_NOTES_TOOL_NAME ? 'Searched your notes.' : 'Read one of your notes.',
      sensitive_read: true,
    });
  }
  if (isNotesFolderWriteToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'notes_write',
      reason_detail:
        action.tool_name === APPEND_TO_INBOX_TOOL_NAME
          ? 'Added an entry to your notes inbox.'
          : 'Made a new note in your notes folder.',
      sensitive_read: false,
    });
  }
  return failClosedDecision({ reason_detail: 'Unknown notes folder tool.' });
}
