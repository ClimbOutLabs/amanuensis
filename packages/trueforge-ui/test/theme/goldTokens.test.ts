import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';

/**
 * Each preset carries its one highlight in the gold tokens as oklch() text (ThemeProvider sets
 * presets inline, which beats the stylesheet pairs), and keyboard focus uses that highlight's ink.
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

describe('the blue theme highlight', () => {
  it('is a cool ice blue on midnight, while paper keeps its gold', () => {
    const hue = (value: string) => Number(/oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(value)?.[1]);
    for (const mode of ['light', 'dark'] as const) {
      expect(hue(PRESETS.midnight[mode].gold)).toBeGreaterThan(200);
      expect(hue(PRESETS.midnight[mode].gold)).toBeLessThan(270);
      expect(hue(PRESETS.paper[mode].gold)).toBeLessThan(100);
    }
  });
});
