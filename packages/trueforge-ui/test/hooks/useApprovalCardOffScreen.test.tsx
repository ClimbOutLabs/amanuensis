// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApprovalCardOffScreen } from '@/hooks/useApprovalCardOffScreen.js';

type Observed = { callback: IntersectionObserverCallback; disconnect: () => void; target: Element | null };

describe('useApprovalCardOffScreen', () => {
  let observers: Observed[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback) {
          const record: Observed = { callback, disconnect: this.disconnect, target: null };
          observers.push(record);
          this.observe = (target: Element) => {
            record.target = target;
          };
        }
        observe: (target: Element) => void = () => undefined;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function report(isIntersecting: boolean) {
    const [observer] = observers;
    if (observer === undefined) throw new Error('no observer was created');
    act(() => {
      observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  }

  it('is off screen while the card has not mounted yet', () => {
    const { result } = renderHook(() => useApprovalCardOffScreen('approval-1'));
    expect(result.current).toBe(true);
    expect(observers).toHaveLength(0);
  });

  it('reports on screen while the card is in view, and off screen once it scrolls away', () => {
    render(<div data-approval-id="approval-1" />);
    const { result } = renderHook(() => useApprovalCardOffScreen('approval-1'));
    expect(observers).toHaveLength(1);
    expect(observers[0]?.target).toBe(document.querySelector('[data-approval-id="approval-1"]'));

    report(true);
    expect(result.current).toBe(false);

    report(false);
    expect(result.current).toBe(true);
  });

  it('watches only the card of the approval asked for', () => {
    render(
      <>
        <div data-approval-id="approval-1" />
        <div data-approval-id="approval-2" />
      </>,
    );
    renderHook(() => useApprovalCardOffScreen('approval-2'));
    expect(observers[0]?.target).toBe(document.querySelector('[data-approval-id="approval-2"]'));
  });

  it('stops observing when the approval is answered', () => {
    render(<div data-approval-id="approval-1" />);
    const { unmount } = renderHook(() => useApprovalCardOffScreen('approval-1'));
    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});
