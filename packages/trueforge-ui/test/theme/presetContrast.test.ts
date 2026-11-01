import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';
import { THEME_PRESET_IDS, type SemanticTokens, type ThemePreset } from '@/theme/types.js';

import { contrastRatio } from './wcagContrast.js';

type TokenName = keyof SemanticTokens;

/** Text on a surface: WCAG AA body text, 4.5:1. */
const BODY_PAIRS: Array<{ text: TokenName; surface: TokenName; base?: TokenName }> = [
  { text: 'textPrimary', surface: 'primaryBg' },
  { text: 'textPrimary', surface: 'cardBg' },
  { text: 'textPrimary', surface: 'secondaryBg' },
  { text: 'textSecondary', surface: 'primaryBg' },
  { text: 'textSecondary', surface: 'cardBg' },
  // Placeholders: the muted token on every input surface.
  { text: 'textMuted', surface: 'inputBoxBg' },
  { text: 'textMuted', surface: 'cardBg' },
  { text: 'sidebarText', surface: 'sidebarBg' },
  { text: 'userMessageText', surface: 'userMessageBg', base: 'primaryBg' },
  { text: 'assistantMessageText', surface: 'primaryBg' },
  { text: 'primaryButtonText', surface: 'primaryButtonBg' },
  { text: 'secondaryButtonText', surface: 'secondaryButtonBg' },
  { text: 'ghostButtonText', surface: 'primaryBg' },
  { text: 'dropdownSelectedItemText', surface: 'dropdownSelectedItemBg', base: 'cardBg' },
  { text: 'successText', surface: 'successBg' },
  { text: 'failureText', surface: 'failureBg' },
  { text: 'warningText', surface: 'warningBg' },
  { text: 'goldInk', surface: 'primaryBg' },
  { text: 'goldInk', surface: 'cardBg' },
  { text: 'goldInk', surface: 'goldSoft' },
];

/** UI parts that carry meaning: WCAG 1.4.11, 3:1. */
const UI_PAIRS: Array<{ text: TokenName; surface: TokenName; base?: TokenName }> = [
  { text: 'focusRing', surface: 'primaryBg' },
  { text: 'focusRing', surface: 'cardBg' },
  { text: 'inputBorder', surface: 'inputBoxBg' },
];

const MODES = ['light', 'dark'] as const;

/** Every theme meets AA. High contrast is the accessibility option, so it must exceed AA. */
function thresholdsFor(presetName: ThemePreset): { body: number; ui: number } {
  return presetName === 'high-contrast' ? { body: 7, ui: 4.5 } : { body: 4.5, ui: 3 };
}

function ratiosFor(pairs: typeof BODY_PAIRS, tokens: SemanticTokens): Array<{ label: string; ratio: number }> {
  return pairs.map(({ text, surface, base }) => ({
    label: `${text} on ${surface}`,
    ratio: contrastRatio({
      text: tokens[text],
      surface: tokens[surface],
      base: tokens[base ?? 'primaryBg'],
    }),
  }));
}

describe('theme presets meet WCAG AA in light and dark', () => {
  for (const presetName of THEME_PRESET_IDS) {
    for (const mode of MODES) {
      it(`${presetName} / ${mode}: body text and UI parts meet their WCAG thresholds`, () => {
        const tokens = PRESETS[presetName][mode];
        const { body, ui } = thresholdsFor(presetName);
        const failures = [
          ...ratiosFor(BODY_PAIRS, tokens)
            .filter(({ ratio }) => ratio < body)
            .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}:1 (needs ${body})`),
          ...ratiosFor(UI_PAIRS, tokens)
            .filter(({ ratio }) => ratio < ui)
            .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}:1 (needs ${ui})`),
        ];
        expect(failures, `${presetName}/${mode}`).toEqual([]);
      });
    }
  }
});
