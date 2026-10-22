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

describe('resolveComposerPlaceholder', () => {
  it('keeps the earlier line for the same chat and does not draw again', () => {
    const first = resolveComposerPlaceholder({ current: null, chatId: 'chat-a', random: fixedRandom(0) });
    let draws = 0;
    const again = resolveComposerPlaceholder({
      current: first,
      chatId: 'chat-a',
      random: () => {
        draws += 1;
        return 0.9;
      },
    });

    expect(again).toBe(first);
    expect(draws).toBe(0);
  });

  it('picks a new line when the chat changes', () => {
    const first = resolveComposerPlaceholder({ current: null, chatId: 'chat-a', random: fixedRandom(0) });
    const second = resolveComposerPlaceholder({ current: first, chatId: 'chat-b', random: fixedRandom(0.9) });

    expect(second.chatId).toBe('chat-b');
    expect(second.line).toBe(COMPOSER_PLACEHOLDER_LINES[9]);
    expect(second.line).not.toBe(first.line);
  });
});
