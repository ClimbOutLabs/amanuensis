'use client';

import { useEffect, useRef } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';
import { openDeliveryLink } from './openDelivery.js';
import type { DeliveryItem, DeliveryLink } from './types.js';

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

/** What the link line of an item says, by where it leads. */
function linkWords(link: DeliveryLink): string {
  switch (link.type) {
    case 'chat':
      return 'Open chat';
    case 'approval':
      return 'Open chat to answer';
    case 'space':
      return 'Open space';
  }
}

function DeliveryRow({ item, onOpen }: { item: DeliveryItem; onOpen: (item: DeliveryItem) => void }) {
  const unread = item.seenAt === null;
  return (
    <li className="border-border border-b last:border-b-0">
      <button
        type="button"
        data-role="delivery-item"
        data-unread={unread ? 'true' : 'false'}
        onClick={() => onOpen(item)}
        className="hover:bg-ghost-button-hover flex w-full flex-col gap-1 px-4 py-3 text-left"
      >
        <span className="flex items-baseline gap-2 text-xs">
          {unread ? <span aria-hidden className="bg-gold size-2 shrink-0 self-center rounded-full" /> : null}
          <span className="text-text-secondary font-semibold">{kindWords(item.kind)}</span>
          <span className="text-text-secondary ml-auto shrink-0">{whenWords(item.createdAt)}</span>
          {unread ? <span className="sr-only">Unread</span> : null}
        </span>
        <span className={cn('text-text-primary block text-sm break-words', unread && 'font-medium')}>{item.text}</span>
        <span className="text-text-secondary block text-xs break-words">Why you got this: {item.reason}</span>
        {item.link === null ? null : (
          <span data-role="delivery-link" className="text-link mt-1 flex items-center gap-0.5 text-xs font-medium">
            {linkWords(item.link)}
            <Icon name="chevron-right" className="size-3.5 shrink-0" />
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The bell in the left panel, with the unread count and the panel of recent items. Absent a feed, it draws nothing.
 * `onNavigate` runs when an item opens what it leads to, so a container that must react to a navigation
 * (the mobile drawer, which would otherwise stay open over the chat) can do so; opening the panel and
 * marking items seen are not navigations and never call it.
 */
export function DeliveryBell({ onNavigate }: { onNavigate?: () => void }) {
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
  const { unreadCount, items, hasMore, loadMore, markSeen, markAllSeen } = deliveries;

  const onOpen = (item: DeliveryItem) => {
    void markSeen([item.id]);
    if (item.link !== null && shell !== null) {
      deliveries.setPanelOpen(false);
      openDeliveryLink({ shell, link: item.link });
      onNavigate?.();
    }
  };

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
          className="border-border bg-paper absolute top-full left-0 z-50 mt-2 flex max-h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border shadow-xl"
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-text-primary text-sm font-semibold">Notifications</h2>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={() => void markAllSeen()}
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
            <ul className="min-h-0 flex-1 overflow-y-auto">
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
