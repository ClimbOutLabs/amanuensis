import { LIST_EVENTS_TOOL_NAME } from '../../../src/core/calendar/toolContract';
import { READ_EMAIL_TOOL_NAME } from '../../../src/core/email/gmail/toolContract';
import { NO_HOST_STAMP, readSourceOf, type HostToolStamp } from '../../../src/core/permissions/webSearch';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../src/documents/toolContract';

/** The stamp of a call to one of the designated provider's declared search tools. */
const SEARCH_STAMP: HostToolStamp = { ...NO_HOST_STAMP, search_provider: true, search_result: true };
/** The stamp of a call to one of the designated provider's declared page-read tools. */
const PAGE_STAMP: HostToolStamp = { ...NO_HOST_STAMP, search_provider: true, page_reader: true };

describe('readSourceOf', () => {
  it('names the kind of content a tool returns, with or without a server prefix', () => {
    expect(readSourceOf(READ_EMAIL_TOOL_NAME, NO_HOST_STAMP)).toBe('email');
    expect(readSourceOf(`gmail__${READ_EMAIL_TOOL_NAME}`, NO_HOST_STAMP)).toBe('email');
    expect(readSourceOf('get_emails_content', NO_HOST_STAMP)).toBe('email');
    expect(readSourceOf(LIST_EVENTS_TOOL_NAME, NO_HOST_STAMP)).toBe('event');
    expect(readSourceOf(EXTRACT_DOCUMENT_TEXT_TOOL_NAME, NO_HOST_STAMP)).toBe('file');
  });

  it('calls a result a page only when the host stamp names the call a declared search or page read', () => {
    expect(readSourceOf('web_search', SEARCH_STAMP)).toBe('page');
    expect(readSourceOf('web_fetch', PAGE_STAMP)).toBe('page');
    expect(readSourceOf('moon_search', SEARCH_STAMP)).toBe('page');
    // A connector tool that only shares a search tool's name earns nothing from the name.
    expect(readSourceOf('web_search', NO_HOST_STAMP)).toBe('tool_result');
    expect(readSourceOf('web_fetch', NO_HOST_STAMP)).toBe('tool_result');
  });

  it('counts a tool it does not know as an ordinary tool result', () => {
    expect(readSourceOf('run_route_search', NO_HOST_STAMP)).toBe('tool_result');
    expect(readSourceOf('', NO_HOST_STAMP)).toBe('tool_result');
  });
});
