import type { CSSProperties } from 'react';

import { tokensToStyle } from '../theme/ThemeProvider.js';
import type { SemanticTokens } from '../theme/types.js';
import { createDisplayPreference } from './displayPreference.js';

/** The type scale steps a chat text size choice scales: the six sizes chat text is set in. */
export type ChatTextScale = Pick<SemanticTokens, 'textXs' | 'textSm' | 'textBase' | 'textLg' | 'textXl' | 'text2xl'>;

const TEXT_SCALE_KEYS = ['textXs', 'textSm', 'textBase', 'textLg', 'textXl', 'text2xl'] as const;

/**
 * The named sizes for chat text, smallest first. Each choice scales the theme's own type
 * scale by one factor, so a theme that sets its own text sizes keeps its proportions at
 * every chat size. On the built-in themes the factors step the main reading size
 * (textBase, 0.9375rem) through 0.875rem, 1.0625rem and 1.1875rem. The default choice
 * carries no factor, so a person who never touches this setting gets the rendering they
 * have today.
 */
export const CHAT_FONT_SIZES = [
  { id: 'smaller', label: 'Smaller', factor: 14 / 15 },
  { id: 'default', label: 'Default', factor: null },
  { id: 'larger', label: 'Larger', factor: 17 / 15 },
  { id: 'largest', label: 'Largest', factor: 19 / 15 },
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

const REM_AMOUNT = /^(\d+(?:\.\d+)?)rem$/;

/**
 * One theme text size scaled by a chat size factor. A plain rem value is worked out to a
 * rem value; any other size a host theme sets (px, em, a clamp()) is scaled with calc(),
 * so every theme's text follows the choice.
 */
function scaleTextValue(value: string | undefined, factor: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const factorText = String(Number(factor.toFixed(4)));
  const amountText = REM_AMOUNT.exec(trimmed)?.[1];
  if (amountText === undefined) return `calc(${trimmed} * ${factorText})`;
  return `${Number((Number(amountText) * factor).toFixed(4))}rem`;
}

/**
 * The chosen size as inline CSS variables for the thread root, derived from the theme's
 * resolved tokens: each of the theme's own text sizes is scaled by the choice's factor,
 * never replaced with fixed sizes. Only the chat surface sits under that root, so the rest
 * of the app keeps the theme's own scale. The default size returns an empty style: the
 * thread root then renders exactly as it did before this setting.
 */
export function chatFontSizeStyle(size: ChatFontSize, tokens: Partial<SemanticTokens>): CSSProperties {
  const option = CHAT_FONT_SIZES.find(candidate => candidate.id === size);
  if (option === undefined || option.factor === null) return {};
  const scale: Partial<ChatTextScale> = {};
  for (const key of TEXT_SCALE_KEYS) {
    const scaled = scaleTextValue(tokens[key], option.factor);
    if (scaled !== undefined) scale[key] = scaled;
  }
  return tokensToStyle(scale);
}
