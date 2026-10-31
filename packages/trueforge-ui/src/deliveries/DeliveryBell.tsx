'use client';

import { useEffect, useRef } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';
import { openDeliveryLink } from './openDelivery.js';
import type { DeliveryItem } from './types.js';

const KIND_WORDS: Record<string, string> = {
  reminder: 'Reminder',
  note: 'Note',
  nudge: 'Heads up',
  approval_waiting: 'Waiting for your ok',
};

/** A kind added later still reads as plain words. */
function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? 'New';
}

function whenWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function DeliveryRow({ item, onOpen }: { item: DeliveryItem; onOpen: (item: DeliveryItem) => void }) {
  const unread = item.seenAt === null;
  return (
    <li>
      <button
        type="button"
        data-role="delivery-item"
        data-unread={unread ? 'true' : 'false'}
        onClick={() => onOpen(item)}
        className="hover:bg-ghost-button-hover w-full rounded-lg px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs">
          {unread ? <span aria-hidden className="bg-gold size-2 shrink-0 rounded-full" /> : null}
          <span className="text-text-primary font-semibold">{kindWords(item.kind)}</span>
          <span className="text-text-secondary">{whenWords(item.createdAt)}</span>
          {unread ? <span className="sr-only">Unread</span> : null}
        </span>
        <span className="text-text-primary mt-1 block text-sm break-words">{item.text}</span>
        <span className="text-text-secondary mt-1 block text-xs break-words">Why you got this: {item.reason}</span>
        {item.link === null ? null : <span className="text-text-secondary mt-1 block text-xs underline">Open</span>}
      </button>
    </li>
  );
}

/** The bell in the top bar, with the unread count and the panel of recent items. Absent a feed, it draws nothing. */
export function DeliveryBell() {
  const deliveries = useOptionalDeliveries();
  const shell = useOptionalShellMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const open = deliveries?.panelOpen === true;
  const setPanelOpen = deliveries?.setPanelOpen;

  useEffect(() => {
    if (!open || setPanelOpen === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setPanelOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, setPanelOpen]);

  if (deliveries === null) return null;
  const { unreadCount, items, hasMore, loadMore, markSeen } = deliveries;

  const onOpen = (item: DeliveryItem) => {
    void markSeen([item.id]);
    if (item.link !== null && shell !== null) {
      deliveries.setPanelOpen(false);
      openDeliveryLink({ shell, link: item.link });
    }
  };
  const unreadIds = items.filter(item => item.seenAt === null).map(item => item.id);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-role="delivery-bell"
        aria-label={unreadCount > 0 ? `Notifications, ${String(unreadCount)} unread` : 'Notifications'}
        aria-expanded={open}
        className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'relative')}
        onClick={() => deliveries.setPanelOpen(!open)}
      >
        <Icon name="bell" />
        {unreadCount > 0 ? (
          <span
            data-role="delivery-unread-count"
            aria-hidden
            className="bg-gold text-text-primary absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-center text-[0.625rem] leading-4 font-semibold"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="border-border bg-paper absolute top-full right-0 z-50 mt-2 flex max-h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border shadow-xl"
        >
          <div className="border-border flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-text-primary text-sm font-semibold">Notifications</h2>
            {unreadIds.length > 0 ? (
              <button
                type="button"
                onClick={() => void markSeen(unreadIds)}
                className="text-text-secondary hover:bg-ghost-button-hover rounded-lg px-2 py-1 text-xs"
              >
                Mark all seen
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="text-text-secondary px-3 py-6 text-center text-sm">
              Nothing yet. Reminders and notes show up here.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto p-1">
              {items.map(item => (
                <DeliveryRow key={item.id} item={item} onOpen={onOpen} />
              ))}
              {hasMore ? (
                <li className="p-2 text-center">
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    className="text-text-secondary hover:bg-ghost-button-hover rounded-lg px-3 py-1 text-xs"
                  >
                    Show older
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
