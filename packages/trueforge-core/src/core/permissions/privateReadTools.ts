/**
 * Which tools read the user's private data: mail, calendar, spaces and document text. Each result of these
 * tools is kept as text for the checks on later searches and maps.
 */
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../documents/toolContract';
import { CALENDAR_READ_TOOL_NAMES } from '../calendar/toolContract';
import { GMAIL_READ_TOOL_NAMES } from '../email/gmail/toolContract';
import { SPACE_READ_TOOL_NAMES } from '../spaces/toolContract';

const PRIVATE_READ_TOOL_NAMES: readonly string[] = [
  ...GMAIL_READ_TOOL_NAMES,
  ...CALENDAR_READ_TOOL_NAMES,
  ...SPACE_READ_TOOL_NAMES,
  EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
];

/** Whether a tool reads the user's private data, so its results are checked before a later web request. */
export function isPrivateReadToolName(tool_name: string): boolean {
  return PRIVATE_READ_TOOL_NAMES.some(name => tool_name.endsWith(name));
}
