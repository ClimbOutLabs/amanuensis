import {
  noteLabel,
  noteProvenance,
  noteRetainContent,
  parseMarker,
  withoutNoteTrailer,
} from '../../../../src/runtime/memory/memoryNotes';

describe('noteLabel', () => {
  it('says where a finding came from and the day it was found', () => {
    expect(noteLabel({ source: 'email', date: '2026-10-29', assistantName: undefined })).toBe(
      'From an email, found Oct 29',
    );
    expect(noteLabel({ source: 'calendar', date: '2026-01-05', assistantName: undefined })).toBe(
      'From the calendar, found Jan 5',
    );
    expect(noteLabel({ source: 'web', date: '2026-10-29', assistantName: undefined })).toBe(
      'From the web, found Oct 29',
    );
    expect(noteLabel({ source: 'attachment', date: '2026-10-29', assistantName: undefined })).toBe(
      'From an attachment, found Oct 29',
    );
    expect(noteLabel({ source: 'other', date: '2026-10-29', assistantName: undefined })).toBe(
      'From another tool, found Oct 29',
    );
  });

  it('names the assistant that replied, or says "the assistant" when no name is known', () => {
    expect(noteLabel({ source: 'assistant_response', date: '2026-10-29', assistantName: 'Nata' })).toBe(
      "From Nata's reply, Oct 29",
    );
    expect(noteLabel({ source: 'assistant_response', date: '2026-10-29', assistantName: undefined })).toBe(
      "From the assistant's reply, Oct 29",
    );
  });
});

describe('note markers in the stored text', () => {
  const content = noteRetainContent({
    text: 'From an email, found Oct 29: Priya asked.',
    source: 'email',
    date: '2026-10-29',
  });

  it('writes the marker as the last line and reads it back', () => {
    expect(content).toBe('From an email, found Oct 29: Priya asked.\n\n<!-- note: email 2026-10-29 -->');
    expect(parseMarker('<!-- note: email 2026-10-29 -->')).toEqual({
      kind: 'note',
      source: 'email',
      date: '2026-10-29',
    });
    expect(parseMarker('<!-- note: made_up 2026-10-29 -->')).toBeUndefined();
    expect(withoutNoteTrailer(content)).toBe('From an email, found Oct 29: Priya asked.');
    expect(withoutNoteTrailer('Plain text')).toBe('Plain text');
  });

  it('trusts the metadata first, reads the text only when no metadata came back, and never reads the person', () => {
    expect(noteProvenance({ metadata: undefined, text: content })).toEqual({ source: 'email', date: '2026-10-29' });
    expect(noteProvenance({ metadata: { note_source: 'web', note_date: '2026-10-01' }, text: content })).toEqual({
      source: 'web',
      date: '2026-10-01',
    });
    expect(noteProvenance({ metadata: { origin: 'tool_ingested' }, text: content })).toBeUndefined();
    expect(noteProvenance({ metadata: { note_source: 'web', note_date: '2026-10-01' }, text: 'Plain' })).toEqual({
      source: 'web',
      date: '2026-10-01',
    });
    expect(noteProvenance({ metadata: { note_source: 'made_up' }, text: 'Plain' })).toBeUndefined();
    expect(noteProvenance({ metadata: undefined, text: 'The dentist is Dr Rivera.' })).toBeUndefined();
  });
});
