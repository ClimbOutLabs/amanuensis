import { describe, expect, it } from 'vitest';

import { TOOL_DONE_FALLBACK, toolDoingWords, toolDoneWords, toolStepTitle } from '@/utils/toolWords.js';

describe('toolWords', () => {
  it('reads a known tool in plain words while it runs and once it is done', () => {
    expect(toolDoingWords('edit_space')).toBe('Updating the space');
    expect(toolDoneWords('edit_space')).toBe('Changed a space');
    expect(toolDoingWords('move_space')).toBe('Moving a space to a folder');
    expect(toolDoneWords('move_space')).toBe('Moved a space to a folder');
    // update_space is retired: it has no wording of its own any more.
    expect(toolDoingWords('update_space')).toBeUndefined();
    expect(toolDoneWords('update_space')).toBe(TOOL_DONE_FALLBACK);
    expect(toolDoingWords('read_email')).toBe('Reading your email');
    expect(toolDoneWords('gmail_read')).toBe('Read your email');
    expect(toolDoneWords('web_search')).toBe('Searched the web');
  });

  it('reads Drive tools and their reasons in plain words', () => {
    expect(toolDoingWords('list_files')).toBe('Checking your Google Drive files');
    expect(toolDoneWords('read_drive_file')).toBe('Read your Google Drive files');
    expect(toolDoneWords('google_drive_read')).toBe('Read your Google Drive files');
    expect(toolDoingWords('create_doc')).toBe('Changing your Google Drive files');
    expect(toolDoneWords('append_rows')).toBe('Changed your Google Drive files');
    expect(toolDoneWords('google_drive_write')).toBe('Changed your Google Drive files');
  });

  it('reads a Google setup check as checking the connection', () => {
    expect(toolDoingWords('google_setup_status')).toBe('Checking your Google connection');
    expect(toolDoneWords('google_setup_status')).toBe('Checked your Google connection');
    expect(toolDoneWords('google_setup_read')).toBe('Checked your Google connection');
  });

  it('reads the notes folder tools in plain words', () => {
    expect(toolDoingWords('search_notes')).toBe('Searching your notes');
    expect(toolDoneWords('search_notes')).toBe('Searched your notes');
    expect(toolDoingWords('read_note')).toBe('Reading a note');
    expect(toolDoneWords('read_note')).toBe('Read note');
    expect(toolDoingWords('append_to_inbox')).toBe('Adding to your notes inbox');
    expect(toolDoneWords('append_to_inbox')).toBe('Added to your notes inbox');
    expect(toolDoingWords('create_note')).toBe('Making a note');
    expect(toolDoneWords('create_note')).toBe('Made a note');
    expect(toolDoneWords('notes_read')).toBe('Searched your notes');
    expect(toolDoneWords('notes_write')).toBe('Added to your notes inbox');
  });

  it('reads the feed’s activity rows in plain words', () => {
    expect(toolDoneWords('delivery.created')).toBe('Sent you a notice');
    expect(toolDoneWords('delivery.web_push')).toBe('Sent a notice to your device');
    expect(toolDoneWords('delivery.sms')).toBe('Sent you a text');
    expect(toolDoneWords('delivery.sms_stop')).toBe('Turned texts off after a STOP');
    expect(toolDoneWords('delivery.sms_new_number_stopped')).toBe('Dropped a new number after a STOP');
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
