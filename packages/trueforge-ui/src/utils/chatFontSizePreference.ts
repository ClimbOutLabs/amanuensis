import type { CSSProperties } from 'react';

import { TOKEN_CSS_VARS, type SemanticTokens } from '../theme/types.js';
import { createDisplayPreference } from './displayPreference.js';

/** The type scale steps a chat text size choice replaces: the six sizes chat text is set in. */
export type ChatTextScale = Pick<SemanticTokens, 'textXs' | 'textSm' | 'textBase' | 'textLg' | 'textXl' | 'text2xl'>;

const TEXT_SCALE_KEYS = ['textXs', 'textSm', 'textBase', 'textLg', 'textXl', 'text2xl'] as const;

/**
 * The named sizes for chat text, smallest first. Each choice moves the whole scale by one
 * notch: the main reading size (textBase) runs 0.875rem, 0.9375rem, 1.0625rem, 1.1875rem.
 * The default choice carries no scale, so a person who never touches this setting gets the
 * rendering they have today.
 */
export const CHAT_FONT_SIZES = [
  {
    id: 'smaller',
    label: 'Smaller',
    scale: {
      textXs: '0.6875rem',
      textSm: '0.75rem',
      textBase: '0.875rem',
      textLg: '1rem',
      textXl: '1.125rem',
      text2xl: '1.375rem',
    },
  },
  { id: 'default', label: 'Default', scale: null },
  {
    id: 'larger',
    label: 'Larger',
    scale: {
      textXs: '0.8125rem',
      textSm: '0.9375rem',
      textBase: '1.0625rem',
      textLg: '1.1875rem',
      textXl: '1.375rem',
      text2xl: '1.625rem',
    },
  },
  {
    id: 'largest',
    label: 'Largest',
    scale: {
      textXs: '0.875rem',
      textSm: '1rem',
      textBase: '1.1875rem',
      textLg: '1.3125rem',
      textXl: '1.5rem',
      text2xl: '1.75rem',
    },
  },
] as const;

export type ChatFontSize = (typeof CHAT_FONT_SIZES)[number]['id'];

/** The chat text size the person picked, kept in this browser like the color theme. */
export const CHAT_FONT_SIZE_STORAGE_KEY = 'aman.chat_font_size';

export function isChatFontSize(value: string): value is ChatFontSize {
  return CHAT_FONT_SIZES.some(size => size.id === value);
}

const chatFontSize = createDisplayPreference<ChatFontSize>({
  storageKey: CHAT_FONT_SIZE_STORAGE_KEY,
  defaultValue: 'default',
  parse: stored => (isChatFontSize(stored) ? stored : undefined),
  serialize: id => id,
});

export const readChatFontSize = chatFontSize.read;
export const setChatFontSize = chatFontSize.set;

export function useChatFontSize(): { size: ChatFontSize; setSize: (size: ChatFontSize) => void } {
  return { size: chatFontSize.useValue(), setSize: chatFontSize.set };
}

/**
 * The chosen scale as inline CSS variables for the thread root. Only the chat surface sits
 * under that root, so the rest of the app keeps the theme's own scale. The default size
 * returns an empty style: the thread root then renders exactly as it did before this setting.
 */
export function chatFontSizeStyle(size: ChatFontSize): CSSProperties {
  const option = CHAT_FONT_SIZES.find(candidate => candidate.id === size);
  if (option === undefined || option.scale === null) return {};
  const style: Record<string, string> = {};
  for (const key of TEXT_SCALE_KEYS) {
    style[TOKEN_CSS_VARS[key]] = option.scale[key];
  }
  return style as CSSProperties;
}
