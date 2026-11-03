import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHAT_FONT_SIZE_STORAGE_KEY,
  chatFontSizeStyle,
  isChatFontSize,
  readChatFontSize,
  setChatFontSize,
} from '@/utils/chatFontSizePreference.js';

describe('chatFontSizePreference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads as the default size when nothing is stored', () => {
    expect(readChatFontSize()).toBe('default');
  });

  it('remembers the picked size in this browser', () => {
    setChatFontSize('larger');
    expect(window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY)).toBe('larger');
    expect(readChatFontSize()).toBe('larger');
  });

  it('reads a stored value it does not know as the default size', () => {
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, 'enormous');
    expect(readChatFontSize()).toBe('default');
  });

  it('knows its own size ids and no others', () => {
    expect(isChatFontSize('smaller')).toBe(true);
    expect(isChatFontSize('default')).toBe(true);
    expect(isChatFontSize('larger')).toBe(true);
    expect(isChatFontSize('largest')).toBe(true);
    expect(isChatFontSize('enormous')).toBe(false);
  });

  it('gives the default size no style, so the chat renders as it does today', () => {
    expect(chatFontSizeStyle('default')).toEqual({});
  });

  it('gives each other size the whole chat type scale, one notch per step', () => {
    expect(chatFontSizeStyle('smaller')).toEqual({
      '--text-xs': '0.6875rem',
      '--text-sm': '0.75rem',
      '--text-base': '0.875rem',
      '--text-lg': '1rem',
      '--text-xl': '1.125rem',
      '--text-2xl': '1.375rem',
    });
    expect(chatFontSizeStyle('larger')).toEqual({
      '--text-xs': '0.8125rem',
      '--text-sm': '0.9375rem',
      '--text-base': '1.0625rem',
      '--text-lg': '1.1875rem',
      '--text-xl': '1.375rem',
      '--text-2xl': '1.625rem',
    });
    expect(chatFontSizeStyle('largest')).toEqual({
      '--text-xs': '0.875rem',
      '--text-sm': '1rem',
      '--text-base': '1.1875rem',
      '--text-lg': '1.3125rem',
      '--text-xl': '1.5rem',
      '--text-2xl': '1.75rem',
    });
  });
});
