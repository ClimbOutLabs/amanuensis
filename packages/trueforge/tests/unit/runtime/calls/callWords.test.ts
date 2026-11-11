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
    'Write to dana@example.com',
    'See https://evil.example now',
  ])('carries none of "%s", and says so instead', text => {
    expect(callWords(text)).toBeUndefined();
    expect(messageLine({ kind: 'reminder', text })).toBe(
      'Your reminder has a number or a link, or is too long, so I will not read it out. It is in the app.',
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

  it('carries words that only contain such letters inside other words', () => {
    expect(callWords('Say hi to Sam at 4')).toBe('Say hi to Sam at 4');
    expect(callWords('Bring the hybrid bike back')).toBeDefined();
  });

  it('carries nothing longer than 300 characters', () => {
    const sentence = 'The fox jumps over the lazy dog. ';
    expect(callWords(sentence.repeat(9).trim())).toBeDefined();
    expect(callWords(sentence.repeat(10).trim())).toBeUndefined();
  });
});
