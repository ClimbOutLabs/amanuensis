// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllClear, GoldTick, HandNote, Highlight, STUB_TEAR_MS, StubTear } from '@/atoms/Reward.js';

describe('reward pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GoldTick is decorative and shows its end state until play', () => {
    const { container, rerender } = render(<GoldTick />);
    const tick = container.querySelector('svg');
    expect(tick?.getAttribute('aria-hidden')).toBe('true');
    expect(tick?.getAttribute('data-play')).toBe('false');
    rerender(<GoldTick play />);
    expect(container.querySelector('svg')?.getAttribute('data-play')).toBe('true');
  });

  it('Highlight keeps its text and its end state when not playing', () => {
    render(<Highlight>Watch out: the car inspection</Highlight>);
    const span = screen.getByText('Watch out: the car inspection');
    expect(span.getAttribute('data-play')).toBe('false');
  });

  it('StubTear renders nothing until it plays, then calls onDone once the tear finishes', () => {
    const onDone = vi.fn();
    const { container, rerender } = render(
      <StubTear play={false} onDone={onDone}>
        <span>Tuesday</span>
      </StubTear>,
    );
    expect(container.querySelector('.aui-reward-tear')).toBeNull();

    rerender(
      <StubTear play onDone={onDone}>
        <span>Tuesday</span>
      </StubTear>,
    );
    const layer = container.querySelector('.aui-reward-tear');
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(STUB_TEAR_MS);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('StubTear does not restart its timer when the callback identity changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <StubTear play onDone={first}>
        <span>Tuesday</span>
      </StubTear>,
    );
    act(() => {
      vi.advanceTimersByTime(STUB_TEAR_MS / 2);
    });
    rerender(
      <StubTear play onDone={second}>
        <span>Tuesday</span>
      </StubTear>,
    );
    act(() => {
      vi.advanceTimersByTime(STUB_TEAR_MS / 2);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('AllClear always shows the warm line and adds the sweep and flecks only when playing', () => {
    const { container, rerender } = render(<AllClear play={false}>Nothing needs you today.</AllClear>);
    expect(screen.getByText('Nothing needs you today.')).toBeTruthy();
    expect(container.querySelector('.aui-reward-sweep')).toBeNull();
    expect(container.querySelectorAll('.aui-reward-fleck')).toHaveLength(0);

    rerender(<AllClear play>Nothing needs you today.</AllClear>);
    expect(container.querySelector('.aui-reward-sweep')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.aui-reward-fleck')).toHaveLength(6);
    expect(screen.getByText('Nothing needs you today.')).toBeTruthy();
  });

  it('HandNote is present at rest and never hidden', () => {
    render(<HandNote>Glad the lease is sorted. Aman</HandNote>);
    const note = screen.getByText('Glad the lease is sorted. Aman');
    expect(note.getAttribute('data-play')).toBe('false');
  });
});
