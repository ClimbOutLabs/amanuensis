import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';

/**
 * Gold is the one highlight, so every preset must carry it as oklch() text
 * (ThemeProvider sets presets inline, which beats the stylesheet pairs), and
 * keyboard focus must be gold in both modes.
 */
describe('gold tokens in presets', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${name} / ${mode} carries gold as oklch()`, () => {
        const tokens = preset[mode];
        for (const value of [tokens.gold, tokens.goldInk, tokens.goldSoft, tokens.goldLine]) {
          expect(value.startsWith('oklch(')).toBe(true);
        }
        expect(tokens.focusRing).toBe(tokens.goldInk);
      });
    }
  }
});
