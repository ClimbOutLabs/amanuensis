import { isProfileEcho } from '../../../../src/runtime/memory/memoryRetain';

const profileLines = ['Likes tea.', 'Works in Lisbon.', 'Has a dog named Rex.'];

describe('isProfileEcho', () => {
  it('rejects a summary that equals the profile', () => {
    expect(isProfileEcho({ facts: ['Likes tea.', 'Works in Lisbon.', 'Has a dog named Rex.'], profileLines })).toBe(
      true,
    );
  });

  it('rejects a summary that is a line-for-line subset of the profile, whatever the case or bullets', () => {
    expect(isProfileEcho({ facts: ['- likes tea.', 'Has a dog named Rex.'], profileLines })).toBe(true);
    expect(isProfileEcho({ facts: ['Works in Lisbon.\nLikes tea.'], profileLines })).toBe(true);
  });

  it('keeps a summary with at least one new fact', () => {
    expect(isProfileEcho({ facts: ['Likes tea.', 'Flies to Rome on 2026-11-02.'], profileLines })).toBe(false);
  });

  it('never rejects when there is no profile, or no facts', () => {
    expect(isProfileEcho({ facts: ['Likes tea.'], profileLines: undefined })).toBe(false);
    expect(isProfileEcho({ facts: ['Likes tea.'], profileLines: [] })).toBe(false);
    expect(isProfileEcho({ facts: [], profileLines })).toBe(false);
  });
});
