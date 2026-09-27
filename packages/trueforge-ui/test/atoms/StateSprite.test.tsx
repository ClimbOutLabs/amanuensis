// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StateSprite } from '@/atoms/StateSprite.js';
import type { StateSpriteState } from '@/atoms/StateSprite.js';

const STATES: StateSpriteState[] = ['listening', 'remembering', 'doing', 'writing'];

describe('StateSprite', () => {
  it.each(STATES)('renders the %s sprite with body and effect bits', (state) => {
    const { container } = render(<StateSprite state={state} />);

    const sprite = container.querySelector('.aui-state-sprite');
    expect(sprite).not.toBeNull();
    expect(sprite).toHaveClass(`aui-state-sprite--${state}`);
    expect(sprite?.querySelector('.aui-state-sprite__body')).not.toBeNull();
    expect(sprite?.querySelectorAll('.aui-state-sprite__fx')).toHaveLength(3);
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
  });
});
