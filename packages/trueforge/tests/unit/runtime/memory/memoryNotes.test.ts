import {
  isNoteTooOld,
  noteLabel,
  RECALLED_NOTE_MAX_AGE_DAYS,
  recalledNoteSource,
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

describe('isNoteTooOld', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const note = (date: string) => ({ note_source: 'email', note_date: date });

  it('keeps the limit in one named constant of 14 days', () => {
    expect(RECALLED_NOTE_MAX_AGE_DAYS).toBe(14);
  });

  it('is false for a recent note, a note at the limit, and an item that is not a note', () => {
    expect(isNoteTooOld({ metadata: note('2026-10-29'), now })).toBe(false);
    expect(isNoteTooOld({ metadata: note('2026-10-15'), now })).toBe(false);
    expect(isNoteTooOld({ metadata: { origin: 'user_stated' }, now })).toBe(false);
    expect(isNoteTooOld({ metadata: undefined, now })).toBe(false);
  });

  it('is true past the limit, and when the date cannot be read', () => {
    expect(isNoteTooOld({ metadata: note('2026-10-14'), now })).toBe(true);
    expect(isNoteTooOld({ metadata: note('not a date'), now })).toBe(true);
    expect(isNoteTooOld({ metadata: { note_source: 'email' }, now })).toBe(true);
  });
});

describe('recalledNoteSource', () => {
  it('reads a known source and ignores anything else', () => {
    expect(recalledNoteSource({ note_source: 'web' })).toBe('web');
    expect(recalledNoteSource({ note_source: 'assistant_response' })).toBe('assistant_response');
    expect(recalledNoteSource({ note_source: 'made_up' })).toBeUndefined();
    expect(recalledNoteSource(undefined)).toBeUndefined();
  });
});
