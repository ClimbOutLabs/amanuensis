// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApprovalCardPlacement } from '@/hooks/useApprovalCardPlacement.js';

type Entry = { isIntersecting: boolean };

const observers: FakeIntersectionObserver[] = [];
let frameQueue: FrameRequestCallback[] = [];

class FakeIntersectionObserver {
  readonly disconnect = vi.fn();
  target: Element | null = null;
  readonly callback: (entries: Entry[]) => void;

  constructor(callback: (entries: Entry[]) => void) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }
}

/** Runs the frames queued so far, the way the browser would between paints. */
function runFrames() {
  const queued = frameQueue;
  frameQueue = [];
  act(() => {
    for (const callback of queued) callback(0);
  });
}

describe('useApprovalCardPlacement', () => {
  beforeEach(() => {
    observers.length = 0;
    frameQueue = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function reportVisibility(isIntersecting: boolean) {
    const [observer] = observers;
    if (observer === undefined) throw new Error('no observer was created');
    act(() => {
      observer.callback([{ isIntersecting }]);
    });
  }

  it('is checking until the card has been looked for, then missing once the mount wait runs out', () => {
    const { result } = renderHook(() => useApprovalCardPlacement('approval-1'));
    expect(result.current).toBe('checking');
    expect(observers).toHaveLength(0);

    runFrames();
    expect(result.current).toBe('checking');

    for (let frame = 0; frame < 60; frame += 1) runFrames();
    expect(result.current).toBe('missing');
  });

  it('reports on screen as soon as the card mounts, before the observer answers', () => {
    render(<div data-approval-id="approval-1" />);
    const { result } = renderHook(() => useApprovalCardPlacement('approval-1'));
    expect(result.current).toBe('on-screen');
  });

  it('reports off screen once the card scrolls away, and on screen when it returns', () => {
    render(<div data-approval-id="approval-1" />);
    const { result } = renderHook(() => useApprovalCardPlacement('approval-1'));
    expect(observers[0]?.target).toBe(document.querySelector('[data-approval-id="approval-1"]'));

    reportVisibility(false);
    expect(result.current).toBe('off-screen');

    reportVisibility(true);
    expect(result.current).toBe('on-screen');
  });

  it('watches only the card of the approval asked for', () => {
    render(
      <>
        <div data-approval-id="approval-1" />
        <div data-approval-id="approval-2" />
      </>,
    );
    renderHook(() => useApprovalCardPlacement('approval-2'));
    expect(observers[0]?.target).toBe(document.querySelector('[data-approval-id="approval-2"]'));
  });

  it('stops observing when the approval is answered', () => {
    render(<div data-approval-id="approval-1" />);
    const { unmount } = renderHook(() => useApprovalCardPlacement('approval-1'));
    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});
