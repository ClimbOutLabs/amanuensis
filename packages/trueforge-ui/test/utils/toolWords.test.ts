import { describe, expect, it } from 'vitest';

import { TOOL_DONE_FALLBACK, toolDoingWords, toolDoneWords } from '@/utils/toolWords.js';

describe('toolWords', () => {
  it('reads a known tool in plain words while it runs and once it is done', () => {
    expect(toolDoingWords('update_space')).toBe('Updating the space');
    expect(toolDoneWords('update_space')).toBe('Changed a space');
    expect(toolDoingWords('read_email')).toBe('Reading your email');
    expect(toolDoneWords('gmail_read')).toBe('Read your email');
    expect(toolDoneWords('web_search')).toBe('Searched the web');
  });

  it('never shows a raw tool name for a tool it does not know', () => {
    expect(toolDoingWords('some_new_tool')).toBeUndefined();
    expect(toolDoneWords('some_new_tool')).toBe(TOOL_DONE_FALLBACK);
  });
});
