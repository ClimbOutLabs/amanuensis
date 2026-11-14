import { noteOriginOf, statementSourceOf } from '../../../../src/runtime/memory/pageSortOrigin';

describe('whose words a note holds', () => {
  it.each([
    ['the person’s own words', { origin: 'user_stated' }, { kind: 'own_words' }, 'you_said'],
    ['a sent message', { origin: 'tool_ingested', note_source: 'sent_mail' }, { kind: 'sent_mail' }, 'sent_mail'],
    ['mail', { origin: 'tool_ingested', note_source: 'email' }, { kind: 'read', source: 'mail' }, 'mail'],
    [
      'the calendar',
      { origin: 'tool_ingested', note_source: 'calendar' },
      { kind: 'read', source: 'calendar' },
      'calendar',
    ],
    [
      'the web',
      { origin: 'tool_ingested', note_source: 'web' },
      { kind: 'read', source: 'read_content' },
      'read_content',
    ],
    [
      'a fact from a turn that read outside text',
      { origin: 'tool_ingested' },
      { kind: 'read', source: 'read_content' },
      'read_content',
    ],
    ['no readable origin', {}, { kind: 'read', source: 'read_content' }, 'read_content'],
    [
      'an unknown source',
      { origin: 'tool_ingested', note_source: 'mystery' },
      { kind: 'read', source: 'read_content' },
      'read_content',
    ],
    [
      'a note that claims to be sent mail but has the person’s origin',
      { origin: 'user_stated', note_source: 'sent_mail' },
      { kind: 'read', source: 'read_content' },
      'read_content',
    ],
  ])('reads %s', (_name, metadata, expected, source) => {
    const origin = noteOriginOf(metadata);
    expect(origin).toEqual(expected);
    if (origin.kind === 'assistant_reply') {
      throw new Error('This origin has no statement source.');
    }
    expect(statementSourceOf(origin)).toBe(source);
  });

  it.each([
    ['a reply note', { origin: 'tool_ingested', note_source: 'assistant_response' }],
    [
      'a reply from a chat that had read nothing',
      { origin: 'tool_ingested', note_source: 'assistant_response', reply_read_nothing: 'true' },
    ],
    ['a reply note with no origin at all', { note_source: 'assistant_response' }],
  ])('reads %s as the assistant’s own reply, which has no place on a page', (_name, metadata) => {
    expect(noteOriginOf(metadata)).toEqual({ kind: 'assistant_reply' });
  });

  it('never reads a note that carries the person’s origin as a reply, so their own words are still sorted', () => {
    expect(noteOriginOf({ origin: 'user_stated' })).toEqual({ kind: 'own_words' });
  });
});
