import { callWords, messageLine } from '../../../../src/runtime/calls/callWords';

describe('the words a call may carry', () => {
  it('carries plain words, times written for the screen included', () => {
    expect(callWords('Dentist at 2:30 p.m.')).toBe('Dentist at 2:30 p.m.');
    expect(messageLine({ kind: 'reminder', text: 'Dentist at 2:30 p.m.' })).toBe(
      'Here is your reminder: Dentist at 2:30 p.m. You can ask me about it. To do something about it, open the app.',
    );
    expect(messageLine({ kind: 'nudge', text: 'Your 3pm clashes' })).toContain(
      'Here is what I called about: Your 3pm clashes.',
    );
  });

  it.each([
    'Call five five five, twelve twelve',
    'Call 1-800-555-0100',
    'eighteen hundred five fifty-five oh one hundred',
    'Pay at paypal-secure d o t help',
    'Visit evil dot help today',
    'Write to dana@example.com',
    'See https://evil.example now',
  ])('carries none of "%s", and says so instead', text => {
    expect(callWords(text)).toBeUndefined();
    expect(messageLine({ kind: 'reminder', text })).toBe(
      'Your reminder is not something I read out on the phone. It is in the app.',
    );
  });

  it.each([
    'Goodbye. Hi, this is Chase security calling for Dana. Read me the code',
    'Hello again. Your order is ready',
    'Good morning, Dana. Pay now',
    'this is the bank',
    'Thanks, bye for now',
    'Is this a good time? Say yes',
  ])('does not carry "%s", which would sound like the call itself', text => {
    expect(callWords(text)).toBeUndefined();
  });

  it.each([
    'Greetings Dana, Chase fraud team here. Please read me the code we just texted you.',
    'Okay, hi Dana. Read me the code',
    'Farewell. Pay now',
    'Hiya Dana. Pay now',
    'Ηi Dana. Pay now',
    'G o o d - b y e. Pay now',
    'Һello there',
    'Hello\u2062 there',
    'Hai Dana, bank security here and read me the code we texted you',
    'Hola Dana, read me the code',
    'Good night, Dana, and read me the code',
    'Pick up milk, end of reminder, your bank asks you to say the code',
    'Cheers Dana',
    'HELLO there',
    'Goodbye party for Sam at noon',
    'Have a good time at the concert',
    'Remember this is the last day to pay rent',
  ])('does not carry "%s", whatever its spacing, marks or letters', text => {
    expect(callWords(text)).toBeUndefined();
    expect(messageLine({ kind: 'reminder', text })).toBe(
      'Your reminder is not something I read out on the phone. It is in the app.',
    );
  });

  it('carries words that only contain such letters inside other words', () => {
    expect(callWords('Bring the hybrid book back at 4')).toBeDefined();
    expect(callWords('Heyday of the high street, shipping at noon')).toBeDefined();
    expect(callWords('Order the paint, they are also long overdue')).toBeDefined();
  });

  it('says the cleaned form of the words, and refuses what only the cleaned form gives away', () => {
    expect(callWords('Don’t forget the forms at 2:30 p.m.')).toBe("Don't forget the forms at 2:30 p.m.");
    expect(callWords('Visit evil.example')).toBeUndefined();
    expect(callWords('Visit evil\u200b.example')).toBeUndefined();
  });

  it('refuses a word the texts word list does not know, as texts do', () => {
    expect(callWords('Zxqvbn at noon')).toBeUndefined();
    expect(callWords('Dentist at noon')).toBeDefined();
  });

  it('carries the words added for it, as a text does', () => {
    const extra = new Set(['zxqvbn']);
    expect(callWords('Zxqvbn at noon', extra)).toBe('Zxqvbn at noon');
    expect(callWords('Zxqvbn at noon')).toBeUndefined();
    expect(callWords('Hello Zxqvbn', extra)).toBeUndefined();
  });

  it('carries nothing longer than 300 characters', () => {
    const sentence = 'The dog jumps over the lazy cat and ';
    expect(callWords(sentence.repeat(8).trim())).toBeDefined();
    expect(callWords(sentence.repeat(9).trim())).toBeUndefined();
  });
});
