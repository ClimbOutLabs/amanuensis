// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StateSprite } from '@/atoms/StateSprite.js';
import type { TurnSpriteId } from '@/utils/waitQueueJourney.js';

const STATES: TurnSpriteId[] = ['listening', 'remembering', 'found-memories', 'doing', 'writing', 'still-writing'];

describe('StateSprite', () => {
  it.each(STATES)('renders the %s sprite as an image', state => {
    const { container } = render(<StateSprite state={state} />);

    const sprite = container.querySelector('.aui-state-sprite');
    expect(sprite).not.toBeNull();
    expect(sprite).toHaveClass(`aui-state-sprite--${state}`);

    const img = sprite?.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('draggable')).toBe('false');
    // One image only: no leftover CSS body/fx spans.
    expect(sprite?.querySelectorAll('span').length).toBe(0);
  });

  it('stays hidden from assistive tech (the status line announces instead)', () => {
    const { container } = render(<StateSprite state="doing" />);
    expect(container.querySelector('.aui-state-sprite')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts an extra className', () => {
    const { container } = render(<StateSprite state="writing" className="extra" />);
    expect(container.querySelector('.aui-state-sprite')).toHaveClass('extra');
  });

  it('swaps the state modifier class and image on state change', () => {
    const { container, rerender } = render(<StateSprite state="listening" />);
    const sprite = container.querySelector('.aui-state-sprite');
    expect(sprite).toHaveClass('aui-state-sprite--listening');
    rerender(<StateSprite state="doing" />);
    expect(sprite).toHaveClass('aui-state-sprite--doing');
    expect(sprite).not.toHaveClass('aui-state-sprite--listening');
    expect(sprite?.querySelector('img')).not.toBeNull();
  });
});
