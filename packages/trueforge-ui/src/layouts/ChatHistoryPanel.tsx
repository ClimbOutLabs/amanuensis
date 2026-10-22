'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { usePrefersReducedMotion } from '../atoms/lib/usePrefersReducedMotion.js';
import { ThreadListContainer } from '../containers/ThreadListContainer.js';
import { Icon } from '../icons/Icon.js';
import { readStoredChatHistoryPinned, writeStoredChatHistoryPinned } from './chatHistoryPinStorage.js';

const COMPOSER_SELECTOR = '[data-slot="aui_composer-root"]';
/** Scrolling counts as active until the list has been still this long. */
const SCROLL_IDLE_MS = 150;

/**
 * Desktop recent-chats panel. It closes itself after a pick, after the person moves into the
 * conversation, or on Escape. Pinning keeps it open for picks and conversation clicks.
 */
export function ChatHistoryPanel({
  conversationRef,
  returnFocusRef,
  onClose,
}: {
  conversationRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  // The aside is display:none below the md breakpoint, so it has no box to transition and no rules apply.
  const shown = !useIsMobile();
  const [pinned, setPinned] = useState(readStoredChatHistoryPinned);
  const [exiting, setExiting] = useState(false);
  const pointerInside = useRef(false);
  const pointerFocusPending = useRef(false);
  const keyboardFocusInside = useRef(false);
  const scrolling = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const close = useCallback(() => {
    if (!shown) {
      onClose();
      return;
    }
    // The panel is about to lose its focus target, so hand focus back to the button that opened it.
    if (panelRef.current?.contains(document.activeElement ?? null)) returnFocusRef.current?.focus();
    if (reducedMotion) onClose();
    else setExiting(true);
  }, [onClose, reducedMotion, returnFocusRef, shown]);

  const closeFromPick = useCallback(() => {
    if (!pinned) close();
  }, [close, pinned]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || exiting) return;
      close();
    };
    if (!shown) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, exiting, shown]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation == null || !shown) return;
    const closeFromConversation = () => {
      if (pinned || exiting || pointerInside.current || keyboardFocusInside.current || scrolling.current) return;
      close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(COMPOSER_SELECTOR) != null) {
        closeFromConversation();
      }
    };
    conversation.addEventListener('pointerdown', closeFromConversation);
    conversation.addEventListener('focusin', onFocusIn);
    return () => {
      conversation.removeEventListener('pointerdown', closeFromConversation);
      conversation.removeEventListener('focusin', onFocusIn);
    };
  }, [close, conversationRef, exiting, pinned, shown]);

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

  const togglePinned = () => {
    const next = !pinned;
    setPinned(next);
    writeStoredChatHistoryPinned(next);
  };

  const pinLabel = pinned ? 'Let chat history close' : 'Keep chat history open';

  return (
    <aside
      ref={panelRef}
      aria-label="Recent chats"
      className={cn(
        'hidden min-h-0 shrink-0 overflow-hidden border-r border-border bg-sidebar-bg md:flex',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        exiting ? 'pointer-events-none w-0' : 'w-64',
      )}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
      }}
      onPointerDown={() => {
        pointerFocusPending.current = true;
      }}
      onPointerUp={() => {
        pointerFocusPending.current = false;
      }}
      onFocus={() => {
        keyboardFocusInside.current = !pointerFocusPending.current;
        pointerFocusPending.current = false;
      }}
      onBlur={event => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) keyboardFocusInside.current = false;
      }}
      onScroll={() => {
        scrolling.current = true;
        clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(() => {
          scrolling.current = false;
        }, SCROLL_IDLE_MS);
      }}
      onTransitionEnd={event => {
        if (exiting && event.target === event.currentTarget && event.propertyName === 'width') onClose();
      }}
    >
      <div className="flex min-h-0 w-64 shrink-0 flex-col">
        <div className="flex shrink-0 justify-end px-1 pt-1">
          <button
            type="button"
            aria-label={pinLabel}
            title={pinLabel}
            className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-text hover:bg-ghost-button-hover hover:text-text-primary"
            onClick={togglePinned}
          >
            <Icon name={pinned ? 'pin-off' : 'pin'} size={14} />
          </button>
        </div>
        <ThreadListContainer variant="recent-history" onThreadOpen={closeFromPick} />
      </div>
    </aside>
  );
}
