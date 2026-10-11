// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StateSprite } from '@/atoms/StateSprite.js';
import type { TurnSpriteId } from '@/utils/waitQueueJourney.js';

const STATES: TurnSpriteId[] = ['listening', 'remembering', 'found-memories', 'doing', 'writing', 'still-writing'];

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');

/**
 * Returns the ranges (start/end offsets) of every
 * `@media (prefers-reduced-motion: no-preference) { ... }` block in the CSS.
 */
function noPreferenceRanges(css: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const marker = '@media (prefers-reduced-motion: no-preference)';
  let from = 0;
  while (true) {
    const at = css.indexOf(marker, from);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    ranges.push({ start: at, end: i });
    from = i;
  }
  return ranges;
}

/** Selectors of every rule whose body declares `animation:`, read from the nearest opening brace. */
function animatedRuleSelectors(css: string): string[] {
  const selectors: string[] = [];
  let at = css.indexOf('animation:');
  while (at >= 0) {
    const open = css.lastIndexOf('{', at);
    const start = Math.max(css.lastIndexOf('{', open - 1), css.lastIndexOf('}', open - 1)) + 1;
    selectors.push(css.slice(start, open).trim());
    at = css.indexOf('animation:', at + 1);
  }
  return selectors;
}

describe('StateSprite', () => {
  it.each(STATES)('renders the %s panda as inline SVG, not an image', state => {
    const { container } = render(<StateSprite state={state} />);

    const sprite = container.querySelector('.aui-state-sprite');
    expect(sprite).not.toBeNull();
    expect(sprite).toHaveClass(`aui-state-sprite--${state}`);
    expect(sprite?.getAttribute('data-testid')).toBe('state-sprite');

    // Drawn in code: one SVG, no <img> anywhere.
    expect(sprite?.querySelector('svg')).not.toBeNull();
    expect(sprite?.querySelector('img')).toBeNull();
  });

  it('stays hidden from assistive tech (the status line announces instead)', () => {
    const { container } = render(<StateSprite state="doing" />);
    expect(container.querySelector('.aui-state-sprite')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts an extra className', () => {
    const { container } = render(<StateSprite state="writing" className="extra" />);
    expect(container.querySelector('.aui-state-sprite')).toHaveClass('extra');
  });

  it('swaps the state modifier class on state change', () => {
    const { container, rerender } = render(<StateSprite state="listening" />);
    const sprite = container.querySelector('.aui-state-sprite');
    expect(sprite).toHaveClass('aui-state-sprite--listening');
    rerender(<StateSprite state="doing" />);
    expect(sprite).toHaveClass('aui-state-sprite--doing');
    expect(sprite).not.toHaveClass('aui-state-sprite--listening');
    expect(sprite?.querySelector('svg')).not.toBeNull();
  });

  it('keeps the same 2rem box for every state', () => {
    const css = readFileSync(stylesPath, 'utf8');
    const boxRule = css.match(/\.aui-state-sprite\s*\{[^}]*\}/);
    expect(boxRule).not.toBeNull();
    expect(boxRule?.[0]).toMatch(/width:\s*2rem/);
    expect(boxRule?.[0]).toMatch(/height:\s*2rem/);
    // No per-state size overrides: one shared box, no layout shift.
    for (const state of STATES) {
      const stateRule = css.match(new RegExp(`\\.aui-state-sprite--${state}\\s*\\{[^}]*\\}`));
      if (stateRule) {
        expect(stateRule[0]).not.toMatch(/width|height/);
      }
    }
  });

  it('keeps every sprite animation under prefers-reduced-motion: no-preference', () => {
    const css = readFileSync(stylesPath, 'utf8');
    const ranges = noPreferenceRanges(css);
    expect(ranges.length).toBeGreaterThan(0);

    // Every `animation:` declaration on a sprite selector must sit inside a
    // no-preference block; otherwise the static pose would move.
    const animationDecl = /([^{}]+)\{\s*[^}]*animation\s*:/g;
    let match: RegExpExecArray | null;
    const violations: string[] = [];
    while ((match = animationDecl.exec(css)) !== null) {
      const selector = match[1] ?? '';
      if (!selector.includes('.aui-state-sprite')) continue;
      const pos = match.index;
      const inside = ranges.some(r => pos >= r.start && pos < r.end);
      if (!inside) violations.push(selector.trim());
    }
    expect(violations).toEqual([]);
  });

  it('turns every sprite animation off for the static queue', () => {
    const css = readFileSync(stylesPath, 'utf8');
    const selectors = animatedRuleSelectors(css).filter(selector => selector.includes('.aui-state-sprite'));
    expect(selectors.length).toBeGreaterThan(0);
    // The static class is the same switch WaitQueueIndicator sets under reduced motion.
    for (const selector of selectors) {
      expect(selector.startsWith('.aui-wait-queue:not(.aui-wait-queue--static) .aui-state-sprite--')).toBe(true);
    }
  });

  it('shows the state accents only for their states', () => {
    const css = readFileSync(stylesPath, 'utf8');
    // Sparkle belongs to found-memories; pencil to writing and still-writing.
    expect(css).toMatch(/\.aui-state-sprite--found-memories\s+\.panda-sparkle/);
    expect(css).toMatch(/\.aui-state-sprite--writing\s+\.panda-pencil/);
    expect(css).toMatch(/\.aui-state-sprite--still-writing\s+\.panda-pencil/);
  });
});
