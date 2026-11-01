import {
  factDateBounds,
  factHasEnded,
  formatFactMarker,
  parseFactMarker,
  splitFactMarker,
  type FactMarker,
} from '../../../../src/runtime/memory/memoryNotes';

describe('fact marker grammar', () => {
  const full: FactMarker = { id: 'f_01', src: 'mail', since: '2026-10-30', until: '2026-11-01' };

  it('renders keys in a fixed order and parses back the same object', () => {
    const line = formatFactMarker(full);
    expect(line).toBe('<!-- fact: id=f_01 src=mail since=2026-10-30 until=2026-11-01 -->');
    expect(parseFactMarker(line)).toEqual(full);
  });

  it('round-trips every optional key combination exactly', () => {
    const markers: FactMarker[] = [
      { id: 'f_a', src: 'you_said' },
      { id: 'f_a', src: 'you_said', since: '2024' },
      { id: 'f_a', src: 'you_said', since: '2024-01', until: '2026-03' },
      { id: 'f_a', src: 'read_content', seen: '2026-10-29' },
      { id: 'f_zz9', src: 'you_edited', since: '2026-10-31', until: '2026-10-31', seen: '2026-10-01' },
    ];
    for (const marker of markers) {
      expect(parseFactMarker(formatFactMarker(marker))).toEqual(marker);
      expect(formatFactMarker(parseFactMarker(formatFactMarker(marker)) ?? marker)).toBe(formatFactMarker(marker));
    }
  });

  it('accepts extra spaces inside the comment but renders them away', () => {
    const sloppy = '<!--  fact:   id=f_01  src=mail   since=2026-10-30 -->';
    expect(parseFactMarker(sloppy)).toEqual({ id: 'f_01', src: 'mail', since: '2026-10-30' });
  });

  it('rejects unknown sources, unknown keys, bad dates, bad ids and repeated keys', () => {
    expect(parseFactMarker('<!-- fact: id=f_01 src=model -->')).toBeUndefined();
    expect(parseFactMarker('<!-- fact: id=f_01 src=mail extra=1 -->')).toBeUndefined();
    expect(parseFactMarker('<!-- fact: id=f_01 src=mail since=2026-13-01 -->')).toBeUndefined();
    expect(parseFactMarker('<!-- fact: id=f_01 src=mail since=2026-02-30 -->')).toEqual({
      id: 'f_01',
      src: 'mail',
      since: '2026-02-30',
    });
    expect(parseFactMarker('<!-- fact: id=01 src=mail -->')).toBeUndefined();
    expect(parseFactMarker('<!-- fact: id=f_01 id=f_02 src=mail -->')).toBeUndefined();
    expect(parseFactMarker('<!-- fact: src=mail -->')).toBeUndefined();
    expect(parseFactMarker('<!-- note: email 2026-10-30 -->')).toBeUndefined();
  });

  it('splits a bullet into its text and marker, leaving a marker-less bullet whole', () => {
    expect(splitFactMarker('- Worked at Acme. <!-- fact: id=f_04 src=you_said since=2024-01 -->')).toEqual({
      text: '- Worked at Acme.',
      marker: { id: 'f_04', src: 'you_said', since: '2024-01' },
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
