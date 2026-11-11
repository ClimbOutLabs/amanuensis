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
      'the assistant’s reply',
      { origin: 'tool_ingested', note_source: 'assistant_response' },
      { kind: 'read', source: 'inferred' },
      'inferred',
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
  ])('reads %s', (_name, metadata, origin, source) => {
    expect(noteOriginOf(metadata)).toEqual(origin);
    expect(statementSourceOf(noteOriginOf(metadata))).toBe(source);
  });
});
