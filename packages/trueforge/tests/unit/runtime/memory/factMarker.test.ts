import fc from 'fast-check';
import {
  FACT_SOURCES,
  factDateBounds,
  factHasEnded,
  formatMarker,
  parseMarker,
  splitFactMarker,
  type FactMarker,
  type Marker,
} from '../../../../src/runtime/memory/memoryNotes';

describe('note marker grammar', () => {
  it('parses the lines already in users daily logs and writes them back byte for byte', () => {
    for (const line of [
      '<!-- note: email 2026-10-29 -->',
      '<!-- note: assistant_response 2026-01-05 -->',
      '<!-- note: web 2025-12-31 -->',
    ]) {
      const marker = parseMarker(line);
      expect(marker?.kind).toBe('note');
      expect(marker === undefined ? undefined : formatMarker(marker)).toBe(line);
    }
    expect(parseMarker('<!-- note: web 2026-10-29 -->  ')).toEqual({ kind: 'note', source: 'web', date: '2026-10-29' });
  });

  it('rejects anything that is not exactly the written form', () => {
    for (const line of [
      '<!-- note: made_up 2026-10-29 -->',
      '<!-- note: email 2026-10-29 extra -->',
      '<!-- note: email -->',
      '<!-- note: email 2026-1-29 -->',
      '<!--  note: email 2026-10-29 -->',
      '<!-- note:  email  2026-10-29 -->',
      ' <!-- note: email 2026-10-29 -->',
      '<!-- note: email=x 2026-10-29 -->',
      '<!-- other: email 2026-10-29 -->',
    ]) {
      expect(parseMarker(line)).toBeUndefined();
    }
  });
});

describe('fact marker grammar', () => {
  const full: FactMarker = { kind: 'fact', id: 'f_01', src: 'mail', since: '2026-10-30', until: '2026-11-01' };

  it('renders keys in a fixed order and parses back the same object', () => {
    const line = formatMarker(full);
    expect(line).toBe('<!-- fact: id=f_01 src=mail since=2026-10-30 until=2026-11-01 -->');
    expect(parseMarker(line)).toEqual(full);
  });

  it('round-trips every optional key combination exactly', () => {
    const markers: FactMarker[] = [
      { kind: 'fact', id: 'f_a', src: 'you_said' },
      { kind: 'fact', id: 'f_a', src: 'you_said', since: '2024' },
      { kind: 'fact', id: 'f_a', src: 'you_said', since: '2024-01', until: '2026-03' },
      { kind: 'fact', id: 'f_a', src: 'read_content', seen: '2026-10-29' },
      { kind: 'fact', id: 'f_zz9', src: 'you_edited', since: '2026-10-31', until: '2026-10-31', seen: '2026-10-01' },
    ];
    for (const marker of markers) {
      expect(parseMarker(formatMarker(marker))).toEqual(marker);
      expect(formatMarker(parseMarker(formatMarker(marker)) ?? marker)).toBe(formatMarker(marker));
    }
  });

  it('accepts extra spaces inside the comment but renders them away', () => {
    const sloppy = '<!--  fact:   id=f_01  src=mail   since=2026-10-30 -->';
    expect(parseMarker(sloppy)).toEqual({ kind: 'fact', id: 'f_01', src: 'mail', since: '2026-10-30' });
  });

  it('rejects unknown sources, unknown keys, bad dates, bad ids and repeated keys', () => {
    expect(parseMarker('<!-- fact: id=f_01 src=model -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: id=f_01 src=mail extra=1 -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: id=f_01 src=mail since=2026-13-01 -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: id=f_01 src=mail since=2026-02-30 -->')).toEqual({
      kind: 'fact',
      id: 'f_01',
      src: 'mail',
      since: '2026-02-30',
    });
    expect(parseMarker('<!-- fact: id=01 src=mail -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: id=f_01 id=f_02 src=mail -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: src=mail -->')).toBeUndefined();
  });

  it('parses both kinds from the one grammar and keeps them apart', () => {
    expect(parseMarker('<!-- fact: id=f_01 src=mail -->')?.kind).toBe('fact');
    expect(parseMarker('<!-- note: mail 2026-10-30 -->')).toBeUndefined();
    expect(parseMarker('<!-- fact: email 2026-10-30 -->')).toBeUndefined();
    expect(splitFactMarker('- Text <!-- note: email 2026-10-30 -->')).toEqual({
      text: '- Text <!-- note: email 2026-10-30 -->',
      marker: undefined,
    });
  });

  it('splits a bullet into its text and marker, leaving a marker-less bullet whole', () => {
    expect(splitFactMarker('- Worked at Acme. <!-- fact: id=f_04 src=you_said since=2024-01 -->')).toEqual({
      text: '- Worked at Acme.',
      marker: { kind: 'fact', id: 'f_04', src: 'you_said', since: '2024-01' },
    });
    expect(splitFactMarker('- Mentions <!-- an aside --> in text')).toEqual({
      text: '- Mentions <!-- an aside --> in text',
      marker: undefined,
    });
    expect(splitFactMarker('- Says <!-- fact: id=f_1 src=mail --> but goes on')).toEqual({
      text: '- Says <!-- fact: id=f_1 src=mail --> but goes on',
      marker: undefined,
    });
  });

  it('expands partial dates to day ranges', () => {
    expect(factDateBounds('2024')).toEqual({ first: '2024-01-01', last: '2024-12-31' });
    expect(factDateBounds('2024-02')).toEqual({ first: '2024-02-01', last: '2024-02-29' });
    expect(factDateBounds('2023-02')).toEqual({ first: '2023-02-01', last: '2023-02-28' });
    expect(factDateBounds('2026-10-31')).toEqual({ first: '2026-10-31', last: '2026-10-31' });
  });

  it('ends a fact only once its last covered day is behind today', () => {
    expect(factHasEnded({ until: '2026-10', today: '2026-10-31' })).toBe(false);
    expect(factHasEnded({ until: '2026-10', today: '2026-11-01' })).toBe(true);
    expect(factHasEnded({ until: '2026-10-31', today: '2026-10-31' })).toBe(false);
    expect(factHasEnded({ until: '2026-10-31', today: '2026-11-01' })).toBe(true);
  });
});

describe('marker round trip', () => {
  const factDate = fc.oneof(
    fc.integer({ min: 2000, max: 2030 }).map(String),
    fc
      .tuple(fc.integer({ min: 2000, max: 2030 }), fc.integer({ min: 1, max: 12 }))
      .map(([y, m]) => `${String(y)}-${String(m).padStart(2, '0')}`),
    fc
      .tuple(fc.integer({ min: 2000, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
      .map(([y, m, d]) => `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
  );
  const factMarker: fc.Arbitrary<Marker> = fc.record(
    {
      kind: fc.constant<'fact'>('fact'),
      id: fc.stringMatching(/^f_[a-z0-9]{1,16}$/),
      src: fc.constantFrom(...FACT_SOURCES),
      since: factDate,
      until: factDate,
      seen: factDate,
    },
    { requiredKeys: ['kind', 'id', 'src'] },
  );
  const noteMarker: fc.Arbitrary<Marker> = fc.record({
    kind: fc.constant<'note'>('note'),
    source: fc.constantFrom('email', 'calendar', 'web', 'attachment', 'other', 'assistant_response'),
    date: fc.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });

  it('formats, parses and formats again to the identical bytes for both kinds', () => {
    fc.assert(
      fc.property(fc.oneof(factMarker, noteMarker), marker => {
        const line = formatMarker(marker);
        const parsed = parseMarker(line);
        expect(parsed).toEqual(marker);
        expect(parsed === undefined ? undefined : formatMarker(parsed)).toBe(line);
      }),
    );
  });
});
