import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package ships one stylesheet: `src/styles.css` is the Tailwind CLI entry that becomes
// `dist/styles.css`, which `embedCssPlugin.mjs` inlines into the JS bundle for runtime
// injection (see `src/theme/ensureStyles.ts`). A stylesheet imported only from a component's
// `.tsx` file (the former `MascotAnimator.css`) never enters that pipeline and never reaches
// the browser. This test reads the shipped source directly so it fails if the mascot rules
// are ever moved back out of it.
const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css');
const styles = readFileSync(stylesPath, 'utf8');

const MASCOT_ACTIONS = [
  'idle',
  'listening',
  'thinking',
  'reading',
  'searching',
  'working',
  'waiting',
  'celebrating',
  'oops',
  'sleeping',
] as const;

describe('mascot animation styles ship in the package stylesheet', () => {
  it.each(MASCOT_ACTIONS)('defines a rule for the %s action class', action => {
    expect(styles).toContain(`.mascot-animator--${action}`);
  });

  it('defines a keyframe animation for every mascot action', () => {
    const expectedKeyframes = [
      'mascot-breathing',
      'mascot-listening',
      'mascot-ear-twitch',
      'mascot-thinking',
      'mascot-thinking-variant-1',
      'mascot-dots-float',
      'mascot-nod',
      'mascot-page-turn',
      'mascot-curious-lean',
      'mascot-curious-lean-variant-1',
      'mascot-magnifier-sweep',
      'mascot-busy-bob',
      'mascot-busy-bob-variant-1',
      'mascot-sparkle',
      'mascot-idle',
      'mascot-blink',
      'mascot-bounce',
      'mascot-confetti',
      'mascot-shake',
      'mascot-droop',
      'mascot-sleep-breath',
      'mascot-dim-halo',
      'mascot-z-drift',
      'mascot-blink-reduced',
    ];

    for (const name of expectedKeyframes) {
      expect(styles).toContain(`@keyframes ${name}`);
    }
  });

  it('preserves the reduced-motion override', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(styles).toContain('.mascot-animator--reduced-motion .mascot-animator__image');
  });

  it('preserves the tab-hidden paused state', () => {
    expect(styles).toContain('.mascot-animator--paused {');
    expect(styles).toContain('animation-play-state: paused;');
  });

  it('does not duplicate the runtime-rail avatar overrides', () => {
    const occurrences = styles.split('.aman-runtime-rail__avatar-card .mascot-animator__container').length - 1;
    expect(occurrences).toBe(1);
  });

  it('sizes the runtime-rail avatar card to the image with no inner padding', () => {
    const cardRuleStart = styles.indexOf('.aman-runtime-rail__avatar-card {');
    const cardRuleEnd = styles.indexOf('}', cardRuleStart);
    const cardRule = styles.slice(cardRuleStart, cardRuleEnd);
    // The card is the exact box: no min-height / place-items centering that would leave
    // visible padding around an image smaller than the card.
    expect(cardRule).not.toMatch(/min-height/);
    expect(cardRule).not.toMatch(/place-items/);
    expect(cardRule).not.toMatch(/padding/);
    expect(cardRule).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);

    const containerRuleStart = styles.indexOf('.aman-runtime-rail__avatar-card .mascot-animator__container {');
    const containerRuleEnd = styles.indexOf('}', containerRuleStart);
    const containerRule = styles.slice(containerRuleStart, containerRuleEnd);
    expect(containerRule).toMatch(/width:\s*100%/);
    expect(containerRule).toMatch(/height:\s*100%/);
    expect(containerRule).not.toMatch(/padding/);

    const imageRuleStart = styles.indexOf('.aman-runtime-rail__avatar-card .mascot-animator__image {');
    const imageRuleEnd = styles.indexOf('}', imageRuleStart);
    const imageRule = styles.slice(imageRuleStart, imageRuleEnd);
    expect(imageRule).toMatch(/width:\s*100%/);
    expect(imageRule).toMatch(/height:\s*100%/);
  });

  it('clips the runtime-rail halo to the same box as the card, behind the image', () => {
    const cardRuleStart = styles.indexOf('.aman-runtime-rail__avatar-card {');
    const cardRuleEnd = styles.indexOf('}', cardRuleStart);
    const cardRule = styles.slice(cardRuleStart, cardRuleEnd);
    expect(cardRule).toMatch(/overflow:\s*hidden/);

    // The halo (z-index: 0 from the base rule) sits behind the image (z-index: 1) and is
    // clipped to the card via the card's own overflow: hidden, not a size of its own.
    const haloRuleStart = styles.indexOf('.aman-runtime-rail__avatar-card .mascot-animator__halo {');
    const haloRuleEnd = styles.indexOf('}', haloRuleStart);
    const haloRule = styles.slice(haloRuleStart, haloRuleEnd);
    expect(haloRule).not.toMatch(/width|height/);
  });
});
