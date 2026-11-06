import { plainName, textName } from '../../../../src/runtime/texts/assistantName';

describe('the assistant name in a text', () => {
  it('keeps a plain name as it is', () => {
    expect(textName('Mannie')).toBe('Mannie');
    expect(textName("O'Neil-Smith")).toBe("O'Neil-Smith");
  });

  it('drops accents, digits, symbols and emoji, keeps it to 20 characters, and drops a name that holds a phone number, a site or an address', () => {
    expect(textName('José')).toBe('Jose');
    expect(textName('Call 4 or visit the bank today please')).toBe('Call or visit the ba');
    expect(textName('Call 555-0199 now')).toBe('Your assistant');
    expect(textName('Mannie.example.com')).toBe('Your assistant');
    expect(textName('Visit bank dot com')).toBe('Your assistant');
    expect(textName('Mail help@bank.example')).toBe('Your assistant');
    expect(textName('🎉 Juniper 🎉')).toBe('Juniper');
    expect(textName('x'.repeat(400))).toHaveLength(20);
  });

  it('falls back to the plain name when nothing is left', () => {
    expect(textName(null)).toBe('Your assistant');
    expect(textName('   ')).toBe('Your assistant');
    expect(textName('🎉🎉 123')).toBe('Your assistant');
  });
});

describe('a name from the person’s settings, said on a call', () => {
  it('keeps a plain name, and gives nothing when no plain name is left or it holds a phone number', () => {
    expect(plainName('Dana')).toBe('Dana');
    expect(plainName("Dana O'Neil-Reyes")).toBe("Dana O'Neil-Reyes");
    expect(plainName(null)).toBeUndefined();
    expect(plainName('🙂 123')).toBeUndefined();
    expect(plainName('Call 555 0100 now')).toBeUndefined();
  });
});
