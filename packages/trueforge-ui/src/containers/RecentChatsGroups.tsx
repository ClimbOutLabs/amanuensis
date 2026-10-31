'use client';

import { useState, type ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { groupRecentChats, RECENT_CHATS_PAGE_SIZE, visibleChats } from '../atoms/lib/threadListMeta.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders } from '../server/ChatFolderContext.js';
import { useChatColumnFold } from '../utils/chatColumnFolds.js';
import { ChatFolderSection } from './ChatFolderControls.js';

/** What the groups need to know about one chat; `time` is its last use, `folderId` its live folder. */
export type RecentChat = { key: string; time: number; folderId: string | undefined };

/** The first page of a group's chats, then one more page each time "Show more" is pressed. */
function LimitedChatRows<T extends RecentChat>({
  chats,
  openKey,
  renderRow,
}: {
  chats: readonly T[];
  openKey: string | undefined;
  renderRow: (chat: T) => ReactNode;
}) {
  const [limit, setLimit] = useState(RECENT_CHATS_PAGE_SIZE);
  const visible = visibleChats({ chats, limit, openKey });
  return (
    <>
      {visible.map(chat => renderRow(chat))}
      {visible.length < chats.length ? (
        <button
          type="button"
          className="w-full rounded-[1.25rem] border-0 bg-transparent px-2.5 py-1.5 text-left text-sm font-normal text-text-secondary hover:text-text-primary"
          onClick={() => setLimit(current => current + RECENT_CHATS_PAGE_SIZE)}
        >
          Show more
        </button>
      ) : null}
    </>
  );
}

/** A dated group of chats whose heading folds it. The fold is remembered across screens and reloads. */
export function FoldedChatGroup<T extends RecentChat>({
  section,
  label,
  defaultOpen,
  chats,
  openKey,
  renderRow,
}: {
  section: string;
  label: string;
  defaultOpen: boolean;
  chats: readonly T[];
  openKey: string | undefined;
  renderRow: (chat: T) => ReactNode;
}) {
  const [expanded, toggle] = useChatColumnFold({ section, defaultOpen });
  return (
    <section aria-label={`${label} chats`}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 border-0 bg-transparent px-2.5 pt-2 pb-1 text-left text-xs font-normal text-text-secondary hover:text-text-primary"
        onClick={toggle}
      >
        <Icon name="chevron-down" className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')} />
        {label}
      </button>
      {expanded ? <LimitedChatRows chats={chats} openKey={openKey} renderRow={renderRow} /> : null}
    </section>
  );
}

/**
 * The Chats column's list below its Folders heading: each folder (newest use first), then Today, then
 * Earlier. A chat in a folder shows only there.
 */
export function RecentChatsGroups<T extends RecentChat>({
  chats,
  openKey,
  renderRow,
}: {
  chats: readonly T[];
  openKey: string | undefined;
  renderRow: (chat: T) => ReactNode;
}) {
  const chatFolders = useOptionalChatFolders();
  const folders = chatFolders?.folders ?? [];
  const grouped = groupRecentChats({ chats, folderIds: folders.map(folder => folder.id), now: new Date() });
  const folderById = new Map(folders.map(folder => [folder.id, folder]));

  return (
    <>
      {grouped.folders.map(({ folderId, chats: folderChats }) => {
        const folder = folderById.get(folderId);
        if (folder === undefined) return null;
        return (
          <ChatFolderSection key={folderId} folder={folder} count={folderChats.length}>
            <LimitedChatRows chats={folderChats} openKey={openKey} renderRow={renderRow} />
          </ChatFolderSection>
        );
      })}
      {grouped.today.length > 0 ? (
        <FoldedChatGroup
          section="today"
          label="Today"
          defaultOpen
          chats={grouped.today}
          openKey={openKey}
          renderRow={renderRow}
        />
      ) : null}
      {grouped.earlier.length > 0 ? (
        <FoldedChatGroup
          section="earlier"
          label="Earlier"
          defaultOpen={false}
          chats={grouped.earlier}
          openKey={openKey}
          renderRow={renderRow}
        />
      ) : null}
    </>
  );
}
