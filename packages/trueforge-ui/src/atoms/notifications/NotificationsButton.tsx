'use client';

import { useCallback, useEffect, useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import { useOptionalNotificationsServer } from '../../server/ServerContext.js';
import type { Notification } from '../../server/types.js';
import { auiButtonClass, sidebarButtonRadiusClassName, sidebarRailButtonClassName } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { DropdownMenu } from '../primitives/DropdownMenu.js';
import { NotificationsPanel } from './NotificationsPanel.js';

export type NotificationsButtonProps = {
  className?: string;
  compact?: boolean;
};

const POLL_INTERVAL_MS = 30000;

export function NotificationsButton({ className, compact = false }: NotificationsButtonProps) {
  const notificationsServer = useOptionalNotificationsServer();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (notificationsServer == null) return;
    try {
      const page = await notificationsServer.listNotifications({ limit: 25 });
      setNotifications(page.data);
      setUnreadCount(page.data.filter(n => n.readAt == null).length);
    } catch {
      // Keep the last known list when a refresh fails.
    }
  }, [notificationsServer]);

  useEffect(() => {
    if (notificationsServer == null) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [notificationsServer, refresh]);

  // Refresh the list when the panel opens so newly arrived items appear.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (notificationsServer == null) return null;

  const badge = unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : null;

  const trigger = (
    <button
      type="button"
      aria-label={compact ? 'Notifications' : undefined}
      title={compact ? 'Notifications' : undefined}
      className={auiButtonClass({
        variant: 'ghost',
        className: cn(
          sidebarButtonRadiusClassName,
          'relative font-normal text-sidebar-text shadow-none hover:bg-secondary-button-hover hover:text-ghost-button-text',
          compact ? sidebarRailButtonClassName : 'h-8 w-full !justify-start px-2.5 text-sm',
          open &&
            'bg-primary-button-bg font-medium text-primary-button-text hover:bg-primary-button-hover hover:text-primary-button-text',
        ),
      })}
    >
      <span className="relative inline-flex">
        <Icon name="bell" size={compact ? 14 : undefined} />
        {badge != null ? (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-failure-bg px-1 text-[0.625rem] font-semibold text-white">
            {badge}
          </span>
        ) : null}
      </span>
      {compact ? (
        <span className="text-center">Alerts</span>
      ) : (
        <>
          <span className="truncate">Notifications</span>
          {badge != null ? (
            <span className="ml-auto shrink-0 rounded-full bg-failure-bg px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">
              {badge}
            </span>
          ) : null}
        </>
      )}
    </button>
  );

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <DropdownMenu
        trigger={trigger}
        open={open}
        onOpenChange={setOpen}
        align={compact ? 'start' : 'end'}
        side="bottom"
        closeOnClick={false}
        className="w-[24rem] max-w-[calc(100vw-2rem)]"
      >
        <NotificationsPanel
          notifications={notifications}
          onMarkRead={async id => {
            await notificationsServer.markNotificationRead({ id });
            await refresh();
          }}
          onDelete={async id => {
            await notificationsServer.deleteNotification({ id });
            await refresh();
          }}
          onMarkAllRead={async () => {
            const unread = notifications.filter(n => n.readAt == null);
            for (const n of unread) {
              await notificationsServer.markNotificationRead({ id: n.id });
            }
            await refresh();
          }}
        />
      </DropdownMenu>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    NotificationsButton: typeof NotificationsButton;
  }
}
