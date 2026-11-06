import { textName } from '../../../../src/runtime/texts/assistantName';

describe('the assistant name in a text', () => {
  it('keeps a plain name as it is', () => {
    expect(textName('Mannie')).toBe('Mannie');
    expect(textName("O'Neil-Smith")).toBe("O'Neil-Smith");
    expect(textName('Mannie.example.com')).toBe('Mannie example com');
  });

  it('drops accents, digits, symbols and emoji, keeps it to 20 characters, and drops a name that holds a phone number', () => {
    expect(textName('José')).toBe('Jose');
    expect(textName('Call 4 or visit bank.example')).toBe('Call or visit bank e');
    expect(textName('Call 555-0199 now')).toBe('Your assistant');
    expect(textName('🎉 Juniper 🎉')).toBe('Juniper');
    expect(textName('x'.repeat(400))).toHaveLength(20);
  });

  it('falls back to the plain name when nothing is left', () => {
    expect(textName(null)).toBe('Your assistant');
    expect(textName('   ')).toBe('Your assistant');
    expect(textName('🎉🎉 123')).toBe('Your assistant');
  });
});
