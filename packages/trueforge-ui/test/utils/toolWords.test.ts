import { describe, expect, it } from 'vitest';

import { TOOL_DONE_FALLBACK, toolDoingWords, toolDoneWords, toolStepTitle } from '@/utils/toolWords.js';

describe('toolWords', () => {
  it('reads a known tool in plain words while it runs and once it is done', () => {
    expect(toolDoingWords('edit_space')).toBe('Updating the space');
    expect(toolDoneWords('edit_space')).toBe('Changed a space');
    // update_space is retired: it has no wording of its own any more.
    expect(toolDoingWords('update_space')).toBeUndefined();
    expect(toolDoneWords('update_space')).toBe(TOOL_DONE_FALLBACK);
    expect(toolDoingWords('read_email')).toBe('Reading your email');
    expect(toolDoneWords('gmail_read')).toBe('Read your email');
    expect(toolDoneWords('web_search')).toBe('Searched the web');
  });

  it('reads a Google setup check as checking the connection', () => {
    expect(toolDoingWords('google_setup_status')).toBe('Checking your Google connection');
    expect(toolDoneWords('google_setup_status')).toBe('Checked your Google connection');
    expect(toolDoneWords('google_setup_read')).toBe('Checked your Google connection');
  });

  it('never shows a raw tool name for a tool it does not know', () => {
    expect(toolDoingWords('some_new_tool')).toBeUndefined();
    expect(toolDoneWords('some_new_tool')).toBe(TOOL_DONE_FALLBACK);
  });

  it('reads an unnamed persona check and switch as a persona, never a specialist', () => {
    expect(toolDoingWords('list_personas')).toBe('Checking the personas');
    expect(toolDoneWords('list_personas')).toBe('Checked a persona');
    expect(toolDoneWords('persona_read')).toBe('Checked a persona');
    expect(toolDoingWords('use_persona')).toBe('Switching persona');
    expect(toolDoneWords('use_persona')).toBe('Switched persona');
    expect(toolDoneWords('persona_switch')).toBe('Switched persona');
    expect(toolStepTitle({ toolName: 'use_persona', state: 'not_done' })).toBe('A persona switch');
    for (const toolName of ['list_personas', 'persona_read', 'use_persona', 'persona_switch', 'create_persona']) {
      expect(toolDoneWords(toolName)).not.toMatch(/specialist/i);
    }
  });

  it('titles a step that did not run by what it is, never as underway or done', () => {
    expect(toolStepTitle({ toolName: 'web_search', state: 'running' })).toBe('Searching the web');
    expect(toolStepTitle({ toolName: 'web_search', state: 'done' })).toBe('Searched the web');
    expect(toolStepTitle({ toolName: 'web_search', state: 'not_done' })).toBe('A web search');
    expect(toolStepTitle({ toolName: 'send_draft', state: 'not_done' })).toBe('An email');
  });
});
