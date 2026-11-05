import {
  isNoteTooOld,
  noteLabel,
  noteProvenance,
  noteRetainContent,
  parseMarker,
  READ_CONTENT_NOTE_MAX_AGE_DAYS,
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

describe('isNoteTooOld', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const note = (date: string) => ({ note_source: 'email', note_date: date });

  it('keeps the read-content limit in one named constant of 14 days', () => {
    expect(READ_CONTENT_NOTE_MAX_AGE_DAYS).toBe(14);
  });

  it("ages read content out after 14 days but keeps the assistant's own replies at any age", () => {
    expect(isNoteTooOld({ metadata: note('2026-10-15'), text: '', now })).toBe(false);
    expect(isNoteTooOld({ metadata: note('2026-10-14'), text: '', now })).toBe(true);
    expect(
      isNoteTooOld({ metadata: { note_source: 'assistant_response', note_date: '2026-09-29' }, text: '', now }),
    ).toBe(false);
    const oldReply = noteRetainContent({
      text: 'Take the earlier train.',
      source: 'assistant_response',
      date: '2026-09-29',
    });
    expect(isNoteTooOld({ metadata: undefined, text: oldReply, now })).toBe(false);
  });

  it('is false for a recent note, a note at the limit, and an item that is not a note', () => {
    expect(isNoteTooOld({ metadata: note('2026-10-29'), text: '', now })).toBe(false);
    expect(isNoteTooOld({ metadata: note('2026-10-15'), text: '', now })).toBe(false);
    expect(isNoteTooOld({ metadata: { origin: 'user_stated' }, text: '', now })).toBe(false);
    expect(isNoteTooOld({ metadata: undefined, text: 'Plain', now })).toBe(false);
  });

  it('is true past the limit, and when the date cannot be read', () => {
    expect(isNoteTooOld({ metadata: note('2026-10-14'), text: '', now })).toBe(true);
    expect(isNoteTooOld({ metadata: note('not a date'), text: '', now })).toBe(true);
    expect(isNoteTooOld({ metadata: { note_source: 'email' }, text: '', now })).toBe(true);
  });

  it('reads the day from the text marker when no metadata came back', () => {
    const old = noteRetainContent({ text: 'Old', source: 'web', date: '2026-10-01' });
    const fresh = noteRetainContent({ text: 'Fresh', source: 'web', date: '2026-10-28' });
    expect(isNoteTooOld({ metadata: undefined, text: old, now })).toBe(true);
    expect(isNoteTooOld({ metadata: undefined, text: fresh, now })).toBe(false);
  });

  it('treats a day in the future as today, so it expires like any other', () => {
    expect(isNoteTooOld({ metadata: note('2027-06-01'), text: '', now })).toBe(false);
    expect(isNoteTooOld({ metadata: note('2027-06-01'), text: '', now: new Date('2026-11-13T00:00:00.000Z') })).toBe(
      false,
    );
    expect(isNoteTooOld({ metadata: note('2026-10-29'), text: '', now: new Date('2026-11-13T00:00:00.000Z') })).toBe(
      true,
    );
  });
});
