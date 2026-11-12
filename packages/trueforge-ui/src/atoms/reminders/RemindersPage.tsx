'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';

import { openDeliveryLink } from '../../deliveries/openDelivery.js';
import { groupReminders, reminderDetailLine, reminderWhenLine } from '../../reminders/groupReminders.js';
import { useReminderList } from '../../reminders/ReminderListContext.js';
import type { ReminderItem } from '../../reminders/types.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { EmptyScreen } from '../EmptyScreen.js';
import { cn } from '../lib/cn.js';
import { PageHeader } from '../PageHeader.js';
import { Button } from '../primitives/Button.js';
import { Skeleton } from '../primitives/Skeleton.js';

const ROW_CLASS = 'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left';

function ReminderRow({ item, onOpenChat }: { item: ReminderItem; onOpenChat: (sessionId: string) => void }) {
  const past = item.state === 'reminded' || item.state === 'missed';
  const sessionId = item.sessionId;
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{item.what}</span>
        <span className="block truncate text-sm text-text-secondary">{reminderWhenLine(item)}</span>
        <span className="block truncate text-xs text-text-secondary">{reminderDetailLine(item)}</span>
      </span>
      {sessionId !== null ? (
        <span className="shrink-0 text-xs text-text-secondary">
          {past ? 'See it in its chat' : 'Will appear in its chat'}
        </span>
      ) : null}
    </>
  );
  if (sessionId === null) {
    return <li className={ROW_CLASS}>{content}</li>;
  }
  return (
    <li>
      <button
        type="button"
        className={cn(ROW_CLASS, 'hover:bg-secondary-button-hover')}
        onClick={() => onOpenChat(sessionId)}
        aria-label={`${item.what}. Opens the chat it was set in.`}
      >
        {content}
      </button>
    </li>
  );
}

function ReminderGroup({
  title,
  items,
  emptyText,
  onOpenChat,
}: {
  title: string;
  items: ReminderItem[];
  emptyText: string;
  onOpenChat: (sessionId: string) => void;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="px-3 text-sm font-semibold text-text-primary">{title}</h2>
      {items.length === 0 ? (
        <p className="px-3 py-2 text-sm text-text-secondary">{emptyText}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map(item => (
            <ReminderRow key={item.id} item={item} onOpenChat={onOpenChat} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every reminder the person set, in one place: what is still to come, and what has already gone out.
 * Read-only on purpose. Reminders are set, changed and cancelled in chat, with the persona that set them.
 */
export function RemindersPage() {
  const { api } = useReminderList();
  const shell = useOptionalShellMode();
  const [list, setList] = useState<ReminderItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.listReminders().then(
      next => {
        if (alive) setList(next);
      },
      () => {
        if (alive) setError('Your reminders could not be loaded. Check your connection, then try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api, reloadKey]);

  const groups = useMemo(() => (list === null ? null : groupReminders(list)), [list]);

  const openChat = useCallback(
    (sessionId: string) => {
      if (shell === null) return;
      openDeliveryLink({ shell, link: { type: 'chat', sessionId } });
    },
    [shell],
  );

  const retry = useCallback(() => {
    setList(null);
    setReloadKey(key => key + 1);
  }, []);

  const nothingAtAll = groups !== null && groups.comingUp.length === 0 && groups.alreadyReminded.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-primary-bg">
      <PageHeader helpAction title="Reminders" />
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {list === null && error === null ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading reminders">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : error !== null ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center" role="alert">
            <p className="text-sm text-failure-bg">{error}</p>
            <Button.Secondary type="button" onClick={retry}>
              Try again
            </Button.Secondary>
          </div>
        ) : nothingAtAll ? (
          <div className="flex min-h-full flex-col">
            <EmptyScreen
              title="No reminders yet"
              description="When you ask a persona to remind you, it will show up here."
              className="flex-1"
            />
          </div>
        ) : groups !== null ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
            <ReminderGroup
              title="Coming up"
              items={groups.comingUp}
              emptyText="No reminders coming up. When you ask a persona to remind you, it will show up here."
              onOpenChat={openChat}
            />
            <ReminderGroup
              title="Already reminded"
              items={groups.alreadyReminded}
              emptyText="Nothing here yet. When a reminder's time comes, it will show up here."
              onOpenChat={openChat}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    RemindersPage: ComponentType;
  }
}
