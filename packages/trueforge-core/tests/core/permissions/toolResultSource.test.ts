import { LIST_EVENTS_TOOL_NAME } from '../../../src/core/calendar/toolContract';
import { READ_EMAIL_TOOL_NAME } from '../../../src/core/email/gmail/toolContract';
import { toolResultSource } from '../../../src/core/permissions/webSearch';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../src/documents/toolContract';

describe('toolResultSource', () => {
  it('names the kind of place a result came from, with or without a server prefix', () => {
    expect(toolResultSource(READ_EMAIL_TOOL_NAME)).toBe('email');
    expect(toolResultSource(`gmail__${READ_EMAIL_TOOL_NAME}`)).toBe('email');
    expect(toolResultSource('get_emails_content')).toBe('email');
    expect(toolResultSource(LIST_EVENTS_TOOL_NAME)).toBe('calendar');
    expect(toolResultSource('web_search')).toBe('web');
    expect(toolResultSource('web_fetch')).toBe('web');
    expect(toolResultSource(EXTRACT_DOCUMENT_TEXT_TOOL_NAME)).toBe('attachment');
  });

  it('counts a tool it does not know as another tool', () => {
    expect(toolResultSource('run_route_search')).toBe('other');
    expect(toolResultSource('')).toBe('other');
  });
});
