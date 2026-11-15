'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn.js';
import { themePortalRoot } from '../lib/themePortalRoot.js';

export type DropdownMenuProps = {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
  containerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnClick?: boolean;
  lockScroll?: boolean;
};

// Returns true if the click was on the menu surface, not its contents or scrollbar.
export function isSurfaceClick(event: React.MouseEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget;
}

// Returns true if the click was on an action in the menu, so a click on its text, a heading or a separator keeps it open.
function isActionClick(event: React.MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest('button, a, [role="menuitem"]') !== null;
}

export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  className,
  containerClassName,
  open: controlledOpen,
  onOpenChange,
  closeOnClick = true,
  lockScroll = false,
}: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [placement, setPlacement] = useState<'top' | 'bottom'>(side);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedOpenRef = useRef(false);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }

    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Flip to the other side when the preferred side cannot fit the menu, so it is never cut off by the window edge.
  // Runs before paint, so the flip is not visible.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const gap = 4;
    const spaceAbove = anchor.top - gap;
    const spaceBelow = window.innerHeight - anchor.bottom - gap;
    const preferredSpace = side === 'top' ? spaceAbove : spaceBelow;
    const otherSpace = side === 'top' ? spaceBelow : spaceAbove;
    const height = menu.offsetHeight;
    const flip = preferredSpace < height && otherSpace >= height;
    setPlacement(flip ? (side === 'top' ? 'bottom' : 'top') : side);
  }, [anchor, side]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      // A dialog opened from the menu (a confirm, a form) lives outside it and must keep the menu's action alive.
      if (target instanceof Element && target.closest('[role="dialog"]') !== null) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open || !lockScroll) return;
    const block = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      event.preventDefault();
    };
    document.addEventListener('wheel', block, { passive: false, capture: true });
    document.addEventListener('touchmove', block, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', block, { capture: true });
      document.removeEventListener('touchmove', block, { capture: true });
    };
  }, [open, lockScroll]);

  // Menu mounts only after `pos` is set; focus once per open, not on every scroll/resize pos rewrite.
  useEffect(() => {
    if (!open) {
      focusedOpenRef.current = false;
      return;
    }
    if (anchor == null || focusedOpenRef.current) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    focusedOpenRef.current = true;
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        const triggerBtn = containerRef.current?.querySelector<HTMLElement>("[aria-haspopup='menu']");
        triggerBtn?.focus();
        return;
      }

      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }

      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
      );
      if (items.length === 0) return;

      e.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex = currentIndex;
      if (e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
      else if (e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = items.length - 1;
      items[nextIndex]?.focus();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  const triggerEl = React.isValidElement(trigger)
    ? React.cloneElement(trigger as React.ReactElement<Record<string, unknown>>, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onKeyDown: (e: React.KeyboardEvent) => {
          const existing = (trigger as React.ReactElement<{ onKeyDown?: (ev: React.KeyboardEvent) => void }>).props
            .onKeyDown;
          existing?.(e);
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        },
      })
    : trigger;

  const menu =
    open && anchor != null
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            style={{
              top: placement === 'top' ? anchor.top - 4 : anchor.bottom + 4,
              left: align === 'end' ? anchor.right : anchor.left,
              transform:
                [align === 'end' ? 'translateX(-100%)' : null, placement === 'top' ? 'translateY(-100%)' : null]
                  .filter(value => value !== null)
                  .join(' ') || undefined,
            }}
            className={cn(
              'aui-popup-enter fixed z-[200] flex min-w-[8rem] flex-col overscroll-contain rounded-md border border-border bg-card-bg p-1',
              'text-text-primary shadow-md',
              className,
            )}
            onMouseDown={event => event.stopPropagation()}
            onClick={
              closeOnClick
                ? event => {
                    if (isSurfaceClick(event) || !isActionClick(event)) return;
                    setOpen(false);
                  }
                : undefined
            }
          >
            {children}
          </div>,
          themePortalRoot(containerRef.current),
        )
      : null;

  return (
    <div ref={containerRef} className={cn('relative inline-flex', containerClassName)}>
      <div className="contents" onClick={() => setOpen(!open)}>
        {triggerEl}
      </div>
      {menu}
    </div>
  );
}

export type DropdownMenuItemProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function DropdownMenuItem({ className, ...props }: DropdownMenuItemProps) {
  return (
    <button
      role="menuitem"
      type="button"
      className={cn(
        'flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
        // focus-visible only: open-menu auto-focus must not look like a stuck hover/selected row.
        'transition-colors hover:bg-ghost-button-hover',
        'focus-visible:bg-dropdown-selected-item-bg focus-visible:text-dropdown-selected-item-text',
        'aria-selected:bg-dropdown-selected-item-bg aria-selected:text-dropdown-selected-item-text',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export type DropdownMenuSeparatorProps = React.HTMLAttributes<HTMLDivElement>;

export function DropdownMenuSeparator({ className, ...props }: DropdownMenuSeparatorProps) {
  return <div role="separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
