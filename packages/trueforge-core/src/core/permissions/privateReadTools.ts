/**
 * Which tools read the person's own stores: mail, calendar, spaces and document text. Who their results name as
 * sender, recipient or guest is the person's own contact.
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

/** Whether a tool reads the person's own stores. */
export function isPrivateReadToolName(tool_name: string): boolean {
  return PRIVATE_READ_TOOL_NAMES.some(name => tool_name.endsWith(name));
}
