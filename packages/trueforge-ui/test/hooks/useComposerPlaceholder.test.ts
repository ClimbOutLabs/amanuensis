import { describe, expect, it } from 'vitest';

import {
  COMPOSER_PLACEHOLDER_LINES,
  pickComposerPlaceholder,
  resolveComposerPlaceholder,
} from '@/hooks/useComposerPlaceholder.js';

/** A random source that always returns the same number, so the pick is known in advance. */
function fixedRandom(value: number): () => number {
  return () => value;
}

describe('COMPOSER_PLACEHOLDER_LINES', () => {
  it('holds exactly the ten agreed lines, in order', () => {
    expect(COMPOSER_PLACEHOLDER_LINES).toEqual([
      "What's on your mind?",
      'What can I take off your plate?',
      'What are we working on today?',
      'How can I help?',
      'Where should we start?',
      'What would make today easier?',
      "What's next?",
      'Tell me what you need.',
      'Anything I can help with?',
      'Ask me anything, big or small.',
    ]);
  });

  it('never names the assistant', () => {
    for (const line of COMPOSER_PLACEHOLDER_LINES) {
      expect(line).not.toMatch(/\b(Iris|Aman)\b/);
    }
  });
});

describe('pickComposerPlaceholder', () => {
  it('returns the line at the position the random source selects', () => {
    expect(pickComposerPlaceholder(fixedRandom(0))).toBe(COMPOSER_PLACEHOLDER_LINES[0]);
    expect(pickComposerPlaceholder(fixedRandom(0.5))).toBe(COMPOSER_PLACEHOLDER_LINES[5]);
  });

  it('always returns one of the listed lines', () => {
    for (const value of [0, 0.1, 0.33, 0.66, 0.999]) {
      expect(COMPOSER_PLACEHOLDER_LINES).toContain(pickComposerPlaceholder(fixedRandom(value)));
    }
  });

  it('stays in range if the random source returns exactly 1', () => {
    expect(pickComposerPlaceholder(fixedRandom(1))).toBe(COMPOSER_PLACEHOLDER_LINES[9]);
  });
});

// The store lives for the page, so each test uses its own chat ids.
describe('resolveComposerPlaceholder', () => {
  it('keeps the line through a composer remount in the same chat and does not draw again', () => {
    const first = resolveComposerPlaceholder({ chatId: 'remount-chat', random: fixedRandom(0) });
    let draws = 0;
    const afterRemount = resolveComposerPlaceholder({
      chatId: 'remount-chat',
      random: () => {
        draws += 1;
        return 0.9;
      },
    });

    expect(first).toBe(COMPOSER_PLACEHOLDER_LINES[0]);
    expect(afterRemount).toBe(first);
    expect(draws).toBe(0);
  });

  it('keeps the line for chat A when switching A to B and back to A', () => {
    const chatA = resolveComposerPlaceholder({ chatId: 'switch-a', random: fixedRandom(0) });
    const chatB = resolveComposerPlaceholder({ chatId: 'switch-b', random: fixedRandom(0.9) });
    const chatAAgain = resolveComposerPlaceholder({ chatId: 'switch-a', random: fixedRandom(0.9) });

    expect(chatB).toBe(COMPOSER_PLACEHOLDER_LINES[9]);
    expect(chatAAgain).toBe(chatA);
  });

  it('keeps a new chat line across the first send, since its local id does not change', () => {
    const beforeSend = resolveComposerPlaceholder({ chatId: 'new-chat-local-id', random: fixedRandom(0.5) });
    const afterSend = resolveComposerPlaceholder({ chatId: 'new-chat-local-id', random: fixedRandom(0) });

    expect(beforeSend).toBe(COMPOSER_PLACEHOLDER_LINES[5]);
    expect(afterSend).toBe(beforeSend);
  });
});
