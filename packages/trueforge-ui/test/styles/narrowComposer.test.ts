import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the narrow phone rules in styles.css: below the supported 390px
 * layout the composer footer stacks instead of squeezing into one line, and
 * below 360px the model picker in the right group takes a full line so the
 * selected model name stays readable, while the home suggestion cards stack
 * in one column. A picker outside the right group keeps sharing the controls
 * line, and Send and Stop keep their 44px touch target at narrow widths.
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
  const pickerBlock = mediaBlock('@media (max-width: 359px)');
  const cardsBlock = mediaBlock('@media (max-width: 389px)', firstNarrowStart + 1);

  it('uses one narrow breakpoint just below the supported 390px layout, and one below 360px', () => {
    expect(firstNarrowStart).toBeGreaterThanOrEqual(0);
    expect(css.indexOf('@media (max-width: 359px)')).toBeGreaterThanOrEqual(0);
  });

  it('stacks the footer groups on their own lines', () => {
    expect(composerBlock).toContain('.aui-composer-leading');
    expect(composerBlock).toContain('.aui-composer-actions');
    expect(composerBlock).toContain('flex-basis: 100%');
  });

  it('shares the controls line with the model picker at 360px and wider, left aligned', () => {
    expect(composerBlock).toContain('justify-content: flex-start');
    expect(composerBlock).not.toContain('.aui-composer-model-selector');
    expect(composerBlock).toContain('.aui-composer-right-group');
    expect(composerBlock).toContain('display: contents');
  });

  it('gives only the model picker in the right group a full line below 360px, with no small cap', () => {
    expect(pickerBlock).toContain('.aui-composer-right-group > .aui-composer-model-selector');
    expect(pickerBlock).toContain('flex: 1 1 100%');
    expect(pickerBlock).toContain('.aui-composer-model-button');
    expect(pickerBlock).not.toContain('max-width: 7rem');
  });

  it('widens the plain model label to the full line too', () => {
    expect(composerBlock).toContain('.aui-composer-model-label');
  });

  it('keeps the 44px touch target on send and stop at narrow widths', () => {
    expect(composerBlock).toContain('aui_composer-send');
    expect(composerBlock).toContain('aui_composer-stop');
    expect(composerBlock).toContain('width: 2.75rem');
    expect(composerBlock).toContain('height: 2.75rem');
  });

  it('stacks the home suggestion cards in one screen-sized column', () => {
    expect(cardsBlock).toContain('.aman-home-cards');
    expect(cardsBlock).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
