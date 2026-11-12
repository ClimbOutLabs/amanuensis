import { textName } from '../../../../src/runtime/texts/assistantName';

describe('the assistant name in a text', () => {
  it('keeps a plain name as it is', () => {
    expect(textName('Mannie')).toBe('Mannie');
    expect(textName("O'Neil-Smith")).toBe("O'Neil-Smith");
  });

  it('drops accents, digits, symbols and emoji, keeps it to 20 characters, and drops a name that holds a phone number, a site or an address', () => {
    expect(textName('José')).toBe('Jose');
    expect(textName('Call 4 or visit the bank today please')).toBe('Call or visit the');
    expect(textName('Call 555-0199 now')).toBe('Your assistant');
    expect(textName('Mannie.example.com')).toBe('Your assistant');
    expect(textName('Visit bank dot com')).toBe('Your assistant');
    expect(textName('Mail help@bank.example')).toBe('Your assistant');
    expect(textName('www evil com')).toBe('Your assistant');
    expect(textName('Juniper five five five')).toBe('Your assistant');
    expect(textName('🎉 Juniper 🎉')).toBe('Juniper');
    expect(textName('x'.repeat(400))).toHaveLength(20);
  });

  it('checks the name again as it will be sent, so leaving out signs or cutting it cannot make a site or a spelling', () => {
    expect(textName('w 1 w 2 w')).toBe('Your assistant');
    expect(textName('c 1 o 2 m')).toBe('Your assistant');
    expect(textName('Visit evilxx xyz comet')).toBe('Your assistant');
    expect(textName('Bob 2015-12-31')).toBe('Your assistant');
    expect(textName('Bob 3 - 4')).toBe('Bob');
  });

  it('falls back to the plain name when nothing is left', () => {
    expect(textName(null)).toBe('Your assistant');
    expect(textName('   ')).toBe('Your assistant');
    expect(textName('🎉🎉 123')).toBe('Your assistant');
  });
});
