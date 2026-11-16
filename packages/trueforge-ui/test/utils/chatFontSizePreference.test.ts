import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHAT_FONT_SIZE_STORAGE_KEY,
  chatFontSizeStyle,
  isChatFontSize,
  readChatFontSize,
  setChatFontSize,
} from '@/utils/chatFontSizePreference.js';

/** The built-in themes' shared type scale, as the theme tokens resolve for them. */
const BUILT_IN_TEXT_SCALE = {
  textXs: '0.75rem',
  textSm: '0.8125rem',
  textBase: '0.9375rem',
  textLg: '1.0625rem',
  textXl: '1.25rem',
  text2xl: '1.5rem',
};

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
    expect(chatFontSizeStyle('default', BUILT_IN_TEXT_SCALE)).toEqual({});
  });

  it('derives each other size from the theme tokens, one factor per step', () => {
    expect(chatFontSizeStyle('smaller', BUILT_IN_TEXT_SCALE)).toEqual({
      '--text-xs': '0.7rem',
      '--text-sm': '0.7583rem',
      '--text-base': '0.875rem',
      '--text-lg': '0.9917rem',
      '--text-xl': '1.1667rem',
      '--text-2xl': '1.4rem',
    });
    expect(chatFontSizeStyle('larger', BUILT_IN_TEXT_SCALE)).toEqual({
      '--text-xs': '0.85rem',
      '--text-sm': '0.9208rem',
      '--text-base': '1.0625rem',
      '--text-lg': '1.2042rem',
      '--text-xl': '1.4167rem',
      '--text-2xl': '1.7rem',
    });
    expect(chatFontSizeStyle('largest', BUILT_IN_TEXT_SCALE)).toEqual({
      '--text-xs': '0.95rem',
      '--text-sm': '1.0292rem',
      '--text-base': '1.1875rem',
      '--text-lg': '1.3458rem',
      '--text-xl': '1.5833rem',
      '--text-2xl': '1.9rem',
    });
  });

  it('scales a host theme text size instead of replacing it', () => {
    expect(chatFontSizeStyle('larger', { textBase: '1.25rem', textSm: '1rem' })).toEqual({
      '--text-base': '1.4167rem',
      '--text-sm': '1.1333rem',
    });
  });

  it('scales a text size that is not a plain rem value with calc(), and skips sizes the theme does not set', () => {
    expect(chatFontSizeStyle('larger', { textBase: '16px' })).toEqual({ '--text-base': 'calc(16px * 1.1333)' });
    expect(chatFontSizeStyle('larger', {})).toEqual({});
  });
});
