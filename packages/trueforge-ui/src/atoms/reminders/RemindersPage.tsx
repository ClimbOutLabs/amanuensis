'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';

import { openDeliveryLink } from '../../deliveries/openDelivery.js';
import { Icon } from '../../icons/Icon.js';
import {
  groupReminders,
  reminderDayTile,
  reminderDetailLine,
  reminderMoment,
  reminderRelativeWords,
  reminderWhenLine,
} from '../../reminders/groupReminders.js';
import { useReminderList } from '../../reminders/ReminderListContext.js';
import type { ReminderItem } from '../../reminders/types.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { EmptyScreen } from '../EmptyScreen.js';
import { cn } from '../lib/cn.js';
import { PageHeader } from '../PageHeader.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import { IconButton } from '../primitives/IconButton.js';
import { Skeleton } from '../primitives/Skeleton.js';

const ROW_CLASS = 'flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 text-left sm:gap-4';
const PILL_CLASS = 'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium';

/** The square at the start of a row: the day it is about, or a mark for a reminder with no day queued. */
function DayTile({ item, moment }: { item: ReminderItem; moment: string | null }) {
  const tile = moment === null ? null : reminderDayTile({ iso: moment, timezone: item.timezone });
  return (
    <span
      aria-hidden
      className="flex size-11 shrink-0 flex-col items-center justify-center rounded-lg bg-secondary-bg text-text-secondary"
    >
      {tile === null ? (
        <Icon name={item.state === 'paused' ? 'pause' : 'alarm-clock'} className="size-4" />
      ) : (
        <>
          <span className="text-[0.625rem] leading-3 font-semibold tracking-wide uppercase">{tile.month}</span>
          <span className="text-base leading-5 font-semibold text-text-primary">{tile.day}</span>
        </>
      )}
    </span>
  );
}

/** The at-a-glance word on a row: how far off it is, or that it is paused or was missed. */
function StatusPill({ item, moment, now }: { item: ReminderItem; moment: string | null; now: Date }) {
  if (item.state === 'paused') {
    return <span className={cn(PILL_CLASS, 'bg-secondary-bg text-text-secondary')}>Paused</span>;
  }
  if (item.state === 'missed') {
    return <span className={cn(PILL_CLASS, 'bg-failure-bg/10 text-failure-bg')}>Missed</span>;
  }
  const words = moment === null ? '' : reminderRelativeWords({ iso: moment, timezone: item.timezone, now });
  if (words === '') return null;
  return <span className={cn(PILL_CLASS, 'bg-secondary-bg text-text-secondary')}>{words}</span>;
}

function ReminderRow({
  item,
  now,
  onOpenChat,
  onDelete,
}: {
  item: ReminderItem;
  now: Date;
  onOpenChat: (sessionId: string) => void;
  onDelete: (item: ReminderItem) => void;
}) {
  const sessionId = item.sessionId;
  const moment = reminderMoment(item);
  const content = (
    <>
      <DayTile item={item} moment={moment} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.9375rem] font-semibold break-words text-text-primary">{item.what}</span>
          <StatusPill item={item} moment={moment} now={now} />
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-sm break-words text-text-secondary">
          {item.repeats ? <Icon name="repeat" className="size-3.5 shrink-0" aria-hidden /> : null}
          {reminderWhenLine(item)}
        </span>
        <span className="mt-0.5 block text-xs break-words text-text-secondary opacity-80">
          {reminderDetailLine(item)}
        </span>
      </span>
      {sessionId !== null ? (
        <span className="flex shrink-0 items-center gap-0.5 text-sm text-text-secondary">
          <span className="hidden sm:inline">Open chat</span>
          <Icon name="chevron-right" className="size-4 shrink-0" />
        </span>
      ) : (
        <span className="hidden shrink-0 text-xs text-text-secondary sm:inline">No chat to open</span>
      )}
    </>
  );
  return (
    <li className="flex items-center border-b border-border last:border-b-0">
      {sessionId === null ? (
        <div className={ROW_CLASS}>{content}</div>
      ) : (
        <button
          type="button"
          className={cn(ROW_CLASS, 'hover:bg-secondary-button-hover')}
          onClick={() => onOpenChat(sessionId)}
          aria-label={`${item.what}. Opens the chat it was set in.`}
        >
          {content}
        </button>
      )}
      <IconButton
        type="button"
        variant="ghost"
        aria-label={`Delete the reminder: ${item.what}`}
        tooltip="Delete"
        className="mr-2 shrink-0 text-text-secondary hover:text-failure-bg"
        onClick={() => onDelete(item)}
      >
        <Icon name="trash" className="size-4" />
      </IconButton>
    </li>
  );
}

function ReminderGroup({
  title,
  items,
  emptyText,
  now,
  onOpenChat,
  onDelete,
}: {
  title: string;
  items: ReminderItem[];
  emptyText: string;
  now: Date;
  onOpenChat: (sessionId: string) => void;
  onDelete: (item: ReminderItem) => void;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-semibold tracking-wide text-text-secondary uppercase">
        {title}
        {items.length > 0 ? (
          <span className={cn(PILL_CLASS, 'bg-secondary-bg px-1.5 text-text-secondary')}>{items.length}</span>
        ) : null}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-text-secondary">
          {emptyText}
        </p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-paper">
          {items.map(item => (
            <ReminderRow key={item.id} item={item} now={now} onOpenChat={onOpenChat} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every reminder the person set, in one place: what is still to come, and what has already gone out.
 * Reminders are set and changed in chat, with the persona that set them. The page can delete one, after asking.
 */
export function RemindersPage() {
  const { api } = useReminderList();
  const shell = useOptionalShellMode();
  const [list, setList] = useState<ReminderItem[] | null>(null);
  // Read once per load, so every row counts from the same moment.
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<ReminderItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.listReminders().then(
      next => {
        if (!alive) return;
        setNow(new Date());
        setList(next);
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

  const askDelete = useCallback((item: ReminderItem) => {
    setDeleteError(null);
    setPendingDelete(item);
  }, []);

  const closeDelete = useCallback(() => {
    setPendingDelete(null);
    setDeleteError(null);
  }, []);

  const confirmDelete = useCallback(
    (item: ReminderItem) => {
      setDeleting(true);
      setDeleteError(null);
      api.deleteReminder(item.id).then(
        () => {
          setDeleting(false);
          setPendingDelete(null);
          setList(current => (current === null ? null : current.filter(entry => entry.id !== item.id)));
        },
        () => {
          setDeleting(false);
          setDeleteError('That reminder could not be deleted. Check your connection, then try again.');
        },
      );
    },
    [api],
  );

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
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            <ReminderGroup
              title="Coming up"
              items={groups.comingUp}
              emptyText="Nothing coming up. Ask in any chat to be reminded."
              now={now}
              onOpenChat={openChat}
              onDelete={askDelete}
            />
            <ReminderGroup
              title="Already reminded"
              items={groups.alreadyReminded}
              emptyText="Nothing yet. A reminder moves here once its time has come."
              now={now}
              onOpenChat={openChat}
              onDelete={askDelete}
            />
          </div>
        ) : null}
      </div>
      {pendingDelete !== null ? (
        <Dialog
          open
          onOpenChange={open => {
            if (!open) closeDelete();
          }}
          aria-label="Delete reminder"
          className="max-w-md"
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete reminder</DialogTitle>
              <p className="text-sm text-text-secondary">
                “{pendingDelete.what}” will be deleted{pendingDelete.repeats ? ' and will not remind you again' : ''}.
                This cannot be undone.
              </p>
              {deleteError !== null ? (
                <p className="text-sm text-failure-bg" role="alert">
                  {deleteError}
                </p>
              ) : null}
            </DialogHeader>
          </DialogContent>
          <DialogFooter>
            <Button.Secondary type="button" onClick={closeDelete}>
              Cancel
            </Button.Secondary>
            <Button.Destructive type="button" disabled={deleting} onClick={() => confirmDelete(pendingDelete)}>
              Delete
            </Button.Destructive>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    RemindersPage: ComponentType;
  }
}
