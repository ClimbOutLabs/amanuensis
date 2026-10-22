import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';

/**
 * The panda's frame glow is sampled from the picture, so it stays in the warm hues. A blue
 * tint would read as a foreign colour beside the paper and gold.
 */
describe('panda glow tokens in presets', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${name} / ${mode} carries the panda glow as oklch() in a warm hue`, () => {
        const tokens = preset[mode];
        for (const value of [tokens.pandaGlowFrom, tokens.pandaGlowTo]) {
          expect(value.startsWith('oklch(')).toBe(true);
          const hue = Number(/^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/.exec(value)?.[1]);
          expect(hue).toBeGreaterThanOrEqual(40);
          expect(hue).toBeLessThanOrEqual(90);
        }
      });
    }
  }
});
