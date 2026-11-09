import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the narrow phone rules in styles.css: below the supported 390px
 * layout the composer footer stacks, the model picker gets a full line so the
 * selected model name stays readable, and the home suggestion cards stack in
 * one column. Nothing here may squeeze the model name or grow one control
 * larger than the rest.
 */
describe('narrow phone composer and home cards', () => {
  const stylesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');
  const css = readFileSync(stylesPath, 'utf8');

  const mediaBlock = (marker: string, fromIndex = 0): string => {
    const start = css.indexOf(marker, fromIndex);
    expect(start, marker).toBeGreaterThanOrEqual(0);
    const end = css.indexOf('\n}\n', start);
    expect(end, marker).toBeGreaterThan(start);
    return css.slice(start, end);
  };

  const firstNarrowStart = css.indexOf('@media (max-width: 389px)');
  const composerBlock = mediaBlock('@media (max-width: 389px)');
  const cardsBlock = mediaBlock('@media (max-width: 389px)', firstNarrowStart + 1);

  it('uses one narrow breakpoint just below the supported 390px layout', () => {
    expect(css).not.toContain('@media (max-width: 359px)');
    expect(firstNarrowStart).toBeGreaterThanOrEqual(0);
  });

  it('stacks the footer groups on their own lines', () => {
    expect(composerBlock).toContain('.aui-composer-leading');
    expect(composerBlock).toContain('.aui-composer-actions');
    expect(composerBlock).toContain('flex-basis: 100%');
  });

  it('gives the model picker a full line at full width, with no small cap', () => {
    expect(composerBlock).toContain('.aui-composer-right-group');
    expect(composerBlock).toContain('display: contents');
    expect(composerBlock).toContain('.aui-composer-model-selector');
    expect(composerBlock).toContain('flex: 1 1 100%');
    expect(composerBlock).toContain('.aui-composer-model-button');
    expect(composerBlock).toContain('max-width: 100%');
    expect(composerBlock).not.toContain('max-width: 7rem');
  });

  it('widens the plain model label to the full line too', () => {
    expect(composerBlock).toContain('.aui-composer-model-label');
  });

  it('keeps send and stop at the same size as the other controls', () => {
    expect(composerBlock).not.toContain('2.75rem');
    expect(composerBlock).not.toContain('aui_composer-send');
    expect(composerBlock).not.toContain('aui_composer-stop');
  });

  it('stacks the home suggestion cards in one screen-sized column', () => {
    expect(cardsBlock).toContain('.aman-home-cards');
    expect(cardsBlock).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
