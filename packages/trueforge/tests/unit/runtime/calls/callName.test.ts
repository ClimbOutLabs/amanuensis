import { callName } from '../../../../src/runtime/calls/callName';

describe('a name a call may say', () => {
  it('keeps a plain name, and gives nothing when no plain name is left or it holds a phone number', () => {
    expect(callName('Dana')).toBe('Dana');
    expect(callName("Dana O'Neil-Reyes")).toBe("Dana O'Neil-Reyes");
    expect(callName(null)).toBeUndefined();
    expect(callName('🙂 123')).toBeUndefined();
    expect(callName('Call 555 0100 now')).toBeUndefined();
  });

  it('spells letters that have no accent to strip, instead of dropping them', () => {
    expect(callName('Søren')).toBe('Soren');
    expect(callName('Łukasz')).toBe('Lukasz');
    expect(callName('Đặng')).toBe('Dang');
    expect(callName('Æsop Straße')).toBe('Aesop Strasse');
    expect(callName('Þór')).toBe('Thor');
    expect(callName('Œuvre Ħamid')).toBe('Oeuvre Hamid');
  });

  it('drops a dash or an apostrophe that is not between two letters, also where the name was cut', () => {
    expect(callName('Anna-Maria Gonzalez-Lopez')).toBe('Anna-Maria');
    expect(callName('Abcdefghijklmnopqrs-tuv')).toBeUndefined();
    expect(callName('Jo - Bot')).toBeUndefined();
    expect(callName("'Tis Dana'")).toBeUndefined();
    expect(callName('--')).toBeUndefined();
    expect(callName("Dana O'Neil-Reyes")).toBe("Dana O'Neil-Reyes");
  });
});
