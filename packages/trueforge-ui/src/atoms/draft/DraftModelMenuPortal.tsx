'use client';

import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared floating-menu placement for every desktop model picker (main chat,
 * auxiliary roles, persona bindings). Always portals to the theme root and
 * measures real viewport space, so the menu escapes whatever scroll or
 * `overflow-hidden` container the trigger happens to sit inside (settings
 * cards clip an absolutely-positioned menu; a portal does not). Flips
 * between opening below and above the trigger, and clamps horizontally, so
 * the menu stays fully on screen at any anchor position or width.
 */

const MENU_GAP = 6;
const MENU_MAX_VH_RATIO = 0.6;
const MENU_MIN_HEIGHT = 160;
export const MENU_MIN_WIDTH = 260;
const VIEWPORT_EDGE_GAP = 8;

export type MenuPosition = {
  left: number;
  width: number;
  maxHeight: number;
  placement: 'below' | 'above';
  top?: number;
  bottom?: number;
};

// Keep portaled chrome under ThemeProvider so preset/custom CSS vars still apply.
export function themePortalRoot(from: HTMLElement | null): HTMLElement {
  return from?.closest('.aui-theme-root') ?? document.body;
}

export type UseFloatingMenuPositionOptions = {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Which edge of the trigger the menu's own edge lines up with. Default 'start' (left-aligned). */
  align?: 'start' | 'end';
  /** Fixed menu width. When omitted, width follows the trigger, floored at `minWidth`. */
  width?: number;
  minWidth?: number;
};

/**
 * Computes where a portaled menu should sit relative to its trigger, and
 * keeps that position current across resize and scroll (any ancestor, not
 * just the window, since a settings panel scrolls internally).
 */
export function useFloatingMenuPosition({
  open,
  anchorRef,
  align = 'start',
  width: fixedWidth,
  minWidth = MENU_MIN_WIDTH,
}: UseFloatingMenuPositionOptions): MenuPosition | null {
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const desiredMaxHeight = viewportHeight * MENU_MAX_VH_RATIO;
      const spaceBelow = viewportHeight - rect.bottom - MENU_GAP;
      const spaceAbove = rect.top - MENU_GAP;
      const placement: 'below' | 'above' =
        spaceBelow >= Math.min(desiredMaxHeight, MENU_MIN_HEIGHT) || spaceBelow >= spaceAbove ? 'below' : 'above';
      const available = placement === 'below' ? spaceBelow : spaceAbove;
      const maxHeight = Math.max(Math.min(desiredMaxHeight, available), MENU_MIN_HEIGHT);
      const width = Math.max(fixedWidth ?? rect.width, minWidth);
      const rawLeft = align === 'end' ? rect.right - width : rect.left;
      const left = Math.min(Math.max(rawLeft, VIEWPORT_EDGE_GAP), viewportWidth - width - VIEWPORT_EDGE_GAP);
      setMenuPos({
        left,
        width,
        maxHeight,
        placement,
        top: placement === 'below' ? rect.bottom + MENU_GAP : undefined,
        bottom: placement === 'above' ? viewportHeight - rect.top + MENU_GAP : undefined,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, align, fixedWidth, minWidth]);

  return menuPos;
}

export function DraftModelMenuPortal({
  anchorRef,
  menuPos,
  menuRef,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  menuPos: MenuPosition;
  menuRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return createPortal(
    <div
      ref={menuRef}
      style={{
        left: menuPos.left,
        width: menuPos.width,
        maxHeight: menuPos.maxHeight,
        top: menuPos.top,
        bottom: menuPos.bottom,
      }}
      className="bg-card-bg text-text-primary fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border shadow-lg"
    >
      {children}
    </div>,
    themePortalRoot(anchorRef.current),
  );
}
