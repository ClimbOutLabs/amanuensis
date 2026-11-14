'use client';

import { useEffect, useRef, useState } from 'react';

import {
  auiButtonClass,
  railSelectedClassName,
  sidebarButtonRadiusClassName,
  sidebarRailButtonClassName,
} from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { Icon } from '../icons/Icon.js';
import { reminderRelativeWords } from '../reminders/groupReminders.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';
import { openDeliveryLink } from './openDelivery.js';
import type { DeliveryItem, DeliveryLink } from './types.js';

const KIND_WORDS: Record<string, string> = {
  reminder: 'Reminder',
  note: 'Note',
  nudge: 'Heads up',
  approval_waiting: 'Waiting for your OK',
};

/** A kind added later still reads as plain words. */
function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? 'New';
}

const KIND_ICONS: Record<string, string> = {
  reminder: 'alarm-clock',
  note: 'info',
  nudge: 'lightbulb',
  approval_waiting: 'circle-exclamation',
};

/** How long ago an item came, at a glance, counted in the time zone of this device. */
function whenWords({ iso, now }: { iso: string; now: Date }): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return reminderRelativeWords({ iso, timezone, now });
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

function DeliveryRow({ item, now, onOpen }: { item: DeliveryItem; now: Date; onOpen: (item: DeliveryItem) => void }) {
  const unread = item.seenAt === null;
  const when = whenWords({ iso: item.createdAt, now });
  return (
    <li className="border-border border-b last:border-b-0">
      <button
        type="button"
        data-role="delivery-item"
        data-unread={unread ? 'true' : 'false'}
        onClick={() => onOpen(item)}
        className="hover:bg-ghost-button-hover flex w-full items-start gap-2.5 px-3.5 py-2 text-left"
      >
        <span
          aria-hidden
          className="bg-primary-bg text-text-secondary relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <Icon name={KIND_ICONS[item.kind] ?? 'bell'} className="size-3.5" />
          {unread ? (
            <span className="bg-gold border-card-bg absolute -top-1 -right-1 size-2 rounded-full border" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'text-text-primary block text-[0.8125rem] leading-5 break-words',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
            {item.text}
          </span>
          <span className="text-text-secondary block text-xs leading-5 break-words">{item.reason}</span>
          <span className="text-text-secondary flex flex-wrap items-center gap-x-2 text-xs leading-5">
            <span className="opacity-80">
              {kindWords(item.kind)}
              {unread ? <span className="sr-only">, unread</span> : null}
              {when === '' ? null : ` · ${when}`}
            </span>
            {item.link === null ? null : (
              <span data-role="delivery-link" className="ml-auto flex shrink-0 items-center gap-0.5 font-medium">
                {linkWords(item.link)}
                <Icon name="chevron-right" className="size-3 shrink-0" />
              </span>
            )}
          </span>
        </span>
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
  const server = useOptionalServer();
  const rootRef = useRef<HTMLDivElement>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const open = deliveries?.panelOpen === true;
  const setPanelOpen = deliveries?.setPanelOpen;

  // A message about an item that would not open belongs to the open panel; it goes with it.
  useEffect(() => {
    if (!open) setOpenError(null);
  }, [open]);

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

  const now = new Date();

  const onOpen = (item: DeliveryItem) => {
    void markSeen([item.id]);
    if (item.link === null || shell === null) return;
    // The panel stays open until the chat is really open; when it cannot open, the panel
    // stays and says why, in plain words.
    void openDeliveryLink({ shell, server, link: item.link }).then(outcome => {
      if (outcome.opened) {
        setOpenError(null);
        deliveries.setPanelOpen(false);
        onNavigate?.();
      } else {
        setOpenError(outcome.message);
      }
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-role="delivery-bell"
        aria-label={unreadCount > 0 ? `For you, ${String(unreadCount)} unread` : 'For you'}
        aria-expanded={open}
        className={auiButtonClass({
          variant: 'ghost',
          className: cn(
            sidebarButtonRadiusClassName,
            sidebarRailButtonClassName,
            'relative',
            open && railSelectedClassName,
          ),
        })}
        onClick={() => deliveries.setPanelOpen(!open)}
      >
        <Icon name="bell" size={14} />
        <span className="text-center">For you</span>
        {unreadCount > 0 ? (
          <span
            data-role="delivery-unread-count"
            aria-hidden
            className="bg-gold text-text-primary absolute top-0.5 right-2.5 min-w-4 rounded-full px-1 text-center text-[0.625rem] leading-4 font-semibold"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="For you"
          className="border-border bg-card-bg absolute top-full left-0 z-50 mt-2 flex max-h-[28rem] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border shadow-xl"
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-text-primary text-sm font-semibold">For you</h2>
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
          {openError !== null ? (
            <p role="alert" className="border-border text-text-secondary border-b px-3 py-2 text-xs">
              {openError}
            </p>
          ) : null}
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
              <span
                aria-hidden
                className="bg-primary-bg text-text-secondary flex size-10 items-center justify-center rounded-full"
              >
                <Icon name="bell" className="size-4" />
              </span>
              <p className="text-text-primary text-sm font-semibold">Nothing for you yet</p>
              <p className="text-text-secondary text-xs">
                Reminders that come due and things waiting for your OK show up here.
              </p>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {items.map(item => (
                <DeliveryRow key={item.id} item={item} now={now} onOpen={onOpen} />
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
