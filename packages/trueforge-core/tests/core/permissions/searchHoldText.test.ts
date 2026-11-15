import { steeredDestinationSay } from '../../../src/core/permissions/searchHoldText';

describe('steeredDestinationSay', () => {
  it('does not name a single link again, since the card already shows it', () => {
    expect(
      steeredDestinationSay({
        assistant: 'Aman',
        destinations: [{ who: 'https://evil.example/claim', kind: 'link', source: 'page' }],
      }),
    ).toBe('Aman found this link in a page it read, not from you.');
  });

  it('names each link when there are several, to say which came from where', () => {
    expect(
      steeredDestinationSay({
        assistant: 'Aman',
        destinations: [
          { who: 'https://evil.example/claim', kind: 'link', source: 'page' },
          { who: 'https://other.example/pay', kind: 'link', source: 'email' },
        ],
      }),
    ).toBe(
      'Aman found https://evil.example/claim in a page it read, not from you. ' +
        'Aman found https://other.example/pay in an email it read, not from you.',
    );
  });
});
