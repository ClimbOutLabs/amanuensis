import { LIST_EVENTS_TOOL_NAME } from '../../../src/core/calendar/toolContract';
import { READ_EMAIL_TOOL_NAME } from '../../../src/core/email/gmail/toolContract';
import { readSourceOf } from '../../../src/core/permissions/webSearch';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../src/documents/toolContract';

describe('readSourceOf', () => {
  it('names the kind of content a tool returns, with or without a server prefix', () => {
    expect(readSourceOf(READ_EMAIL_TOOL_NAME)).toBe('email');
    expect(readSourceOf(`gmail__${READ_EMAIL_TOOL_NAME}`)).toBe('email');
    expect(readSourceOf('get_emails_content')).toBe('email');
    expect(readSourceOf(LIST_EVENTS_TOOL_NAME)).toBe('event');
    expect(readSourceOf('web_search')).toBe('page');
    expect(readSourceOf('web_fetch')).toBe('page');
    expect(readSourceOf(EXTRACT_DOCUMENT_TEXT_TOOL_NAME)).toBe('file');
  });

  it('counts a tool it does not know as an ordinary tool result', () => {
    expect(readSourceOf('run_route_search')).toBe('tool_result');
    expect(readSourceOf('')).toBe('tool_result');
  });
});
