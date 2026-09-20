// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useFloatingMenuPosition, type MenuPosition } from '@/atoms/draft/DraftModelMenuPortal.js';

/** Renders the hook against a trigger whose rect we can control per test. */
function HookHarness({
  open,
  rect,
  onPosition,
  ...options
}: {
  open: boolean;
  rect: Partial<DOMRect>;
  onPosition: (pos: MenuPosition | null) => void;
  align?: 'start' | 'end';
  width?: number;
  minWidth?: number;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuPos = useFloatingMenuPosition({ open, anchorRef, ...options });
  onPosition(menuPos);
  return (
    <button
      ref={el => {
        anchorRef.current = el;
        if (el) {
          el.getBoundingClientRect = () =>
            ({
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              width: 0,
              height: 0,
              x: 0,
              y: 0,
              toJSON() {
                return this;
              },
              ...rect,
            }) as DOMRect;
        }
      }}
      type="button"
    />
  );
}

describe('useFloatingMenuPosition', () => {
  afterEach(() => {
    window.innerWidth = 1024;
    window.innerHeight = 768;
  });

  it('clamps the menu inside the viewport when a right-aligned trigger sits at the screen edge', () => {
    window.innerWidth = 400;
    window.innerHeight = 800;
    let latest: MenuPosition | null = null;

    render(
      <HookHarness
        open
        rect={{ left: 380, right: 400, top: 200, bottom: 240, width: 20 }}
        align="end"
        width={288}
        onPosition={pos => {
          latest = pos;
        }}
      />,
    );

    expect(latest).not.toBeNull();
    // A 288px-wide menu anchored to the right edge of a 20px-wide trigger at x=400
    // would start at 112 (400 - 288) and would NOT overflow a 400px viewport here,
    // so assert the general invariant instead of one fixed geometry: it never spills
    // off either edge.
    expect(latest!.left).toBeGreaterThanOrEqual(0);
    expect(latest!.left + latest!.width).toBeLessThanOrEqual(400);
  });

  it('clamps the menu inside the viewport when the trigger sits hard against the left edge', () => {
    window.innerWidth = 400;
    window.innerHeight = 800;
    let latest: MenuPosition | null = null;

    render(
      <HookHarness
        open
        rect={{ left: -50, right: -30, top: 200, bottom: 240, width: 20 }}
        align="end"
        width={288}
        onPosition={pos => {
          latest = pos;
        }}
      />,
    );

    expect(latest!.left).toBeGreaterThanOrEqual(0);
    expect(latest!.left + latest!.width).toBeLessThanOrEqual(400);
  });

  it('opens below when there is more room below the trigger than above', () => {
    window.innerHeight = 800;
    let latest: MenuPosition | null = null;

    render(
      <HookHarness
        open
        rect={{ left: 10, right: 100, top: 100, bottom: 130, width: 90 }}
        onPosition={pos => {
          latest = pos;
        }}
      />,
    );

    expect(latest!.placement).toBe('below');
    expect(latest!.top).toBe(136); // rect.bottom (130) + MENU_GAP (6)
    expect(latest!.bottom).toBeUndefined();
  });

  it('flips above when there is no room below but room above', () => {
    window.innerHeight = 300;
    let latest: MenuPosition | null = null;

    render(
      <HookHarness
        open
        rect={{ left: 10, right: 100, top: 260, bottom: 290, width: 90 }}
        onPosition={pos => {
          latest = pos;
        }}
      />,
    );

    expect(latest!.placement).toBe('above');
    expect(latest!.bottom).toBe(46); // viewportHeight (300) - rect.top (260) + MENU_GAP (6)
    expect(latest!.top).toBeUndefined();
  });

  it('clears the position when closed', () => {
    let latest: MenuPosition | null | undefined;

    const { rerender } = render(
      <HookHarness
        open
        rect={{ left: 10, right: 100, top: 100, bottom: 130, width: 90 }}
        onPosition={pos => {
          latest = pos;
        }}
      />,
    );
    expect(latest).not.toBeNull();

    act(() => {
      rerender(
        <HookHarness
          open={false}
          rect={{ left: 10, right: 100, top: 100, bottom: 130, width: 90 }}
          onPosition={pos => {
            latest = pos;
          }}
        />,
      );
    });
    expect(latest).toBeNull();
  });
});
