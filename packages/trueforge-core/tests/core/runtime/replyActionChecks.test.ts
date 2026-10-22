import { claimsUnbackedAction } from '../../../src/core/runtime/replyActionChecks';

describe('claimsUnbackedAction', () => {
  it.each([
    "Done, I've set a 9:10 reminder.",
    'I have added the dentist visit to your calendar.',
    'I added a note for Tuesday.',
    'I just scheduled the call for 3pm.',
    'It has been saved to your notes.',
    'The invite has been sent.',
  ])('flags "%s" when no write call ran in the turn', text => {
    expect(claimsUnbackedAction({ text, successfulWrites: 0 })).toBe(true);
  });

  it('does not flag the same claim once a write call ran in the turn', () => {
    expect(claimsUnbackedAction({ text: "Done, I've set a 9:10 reminder.", successfulWrites: 1 })).toBe(false);
  });

  it.each([
    'Here is the list of events for Tuesday.',
    "I haven't set anything up yet.",
    'Would you like me to set a reminder?',
    'Your reminder is at 9:10.',
    'The meeting was moved to Thursday.',
  ])('leaves "%s" alone', text => {
    expect(claimsUnbackedAction({ text, successfulWrites: 0 })).toBe(false);
  });
});
