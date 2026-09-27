'use client';

import { useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import type { Notification, NotificationKind } from '../../server/types.js';
import { formatRelativeTime } from '../schedules/cadence.js';
import { cn } from '../lib/cn.js';

export type NotificationsPanelProps = {
  notifications: Notification[];
  onMarkRead: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
};

const KIND_LABELS: Record<NotificationKind, string> = {
  reminder: 'Reminder',
  briefing: 'Briefing',
  schedule_complete: 'Run complete',
  schedule_failed: 'Run failed',
};

const KIND_ICONS: Record<NotificationKind, string> = {
  reminder: 'clock',
  briefing: 'file',
  schedule_complete: 'check',
  schedule_failed: 'circle-exclamation',
};

function NotificationRow({
  notification,
  onMarkRead,
  onDelete,
}: {
  notification: Notification;
  onMarkRead: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const unread = notification.readAt == null;

  const handleMarkRead = async () => {
    if (!unread || busy) return;
    setBusy(true);
    try {
      await onMarkRead(notification.id);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(notification.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'flex gap-3 border-b border-border px-4 py-3 last:border-b-0',
        unread ? 'bg-primary-button-bg/5' : undefined,
      )}
    >
      <span
        className={cn(
          'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full',
          notification.kind === 'schedule_failed'
            ? 'bg-failure-bg/10 text-failure-bg'
            : 'bg-primary-button-bg/10 text-primary-button-bg',
        )}
      >
        <Icon name={KIND_ICONS[notification.kind]} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-text-primary">{notification.title}</p>
          <span className="shrink-0 text-xs text-text-secondary">
            {formatRelativeTime(notification.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">{KIND_LABELS[notification.kind]}</p>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-text-primary">{notification.body}</p>
        <div className="mt-2 flex gap-2">
          {unread ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleMarkRead()}
              className="text-xs font-medium text-primary-button-bg hover:underline disabled:opacity-50"
            >
              Mark read
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleDelete()}
            className="text-xs font-medium text-text-secondary hover:text-failure-bg disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
      {unread ? <span className="mt-2 size-2 shrink-0 rounded-full bg-primary-button-bg" aria-label="Unread" /> : null}
    </div>
  );
}

export function NotificationsPanel({
  notifications,
  onMarkRead,
  onDelete,
  onMarkAllRead,
}: NotificationsPanelProps) {
  const [markingAll, setMarkingAll] = useState(false);
  const hasUnread = notifications.some(n => n.readAt == null);

  const handleMarkAllRead = async () => {
    if (!hasUnread || markingAll) return;
    setMarkingAll(true);
    try {
      await onMarkAllRead();
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="flex max-h-[28rem] flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">Notifications</h2>
        {hasUnread ? (
          <button
            type="button"
            disabled={markingAll}
            onClick={() => void handleMarkAllRead()}
            className="text-xs font-medium text-primary-button-bg hover:underline disabled:opacity-50"
          >
            Mark all read
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Icon name="bell" className="size-8 text-text-secondary opacity-50" />
            <p className="text-sm text-text-secondary">No notifications yet.</p>
            <p className="text-xs text-text-secondary">
              Reminders, briefings, and schedule updates will appear here.
            </p>
          </div>
        ) : (
          notifications.map(n => (
            <NotificationRow key={n.id} notification={n} onMarkRead={onMarkRead} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  );
}
