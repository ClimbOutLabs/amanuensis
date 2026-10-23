'use client';

import { useAuiState } from '@assistant-ui/react';
import { useState, type ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { groupRecentChats, RECENT_CHATS_PAGE_SIZE, visibleChatIndices } from '../atoms/lib/threadListMeta.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders } from '../server/ChatFolderContext.js';
import { ChatFolderSection } from './ChatFolderControls.js';

const groupHeadingClass = 'm-0 px-2.5 pt-2 pb-1 text-[0.75rem] font-normal text-text-secondary';

/** The first page of a group's chats, then one more page each time "Show more" is pressed. */
function LimitedChatRows({
  indices,
  openIndex,
  renderRow,
}: {
  indices: readonly number[];
  openIndex: number | undefined;
  renderRow: (index: number) => ReactNode;
}) {
  const [limit, setLimit] = useState(RECENT_CHATS_PAGE_SIZE);
  const visible = visibleChatIndices({ indices, limit, openIndex });
  return (
    <>
      {visible.map(index => renderRow(index))}
      {visible.length < indices.length ? (
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

/** The Earlier group. It starts closed; its heading is the toggle. */
export function EarlierChats({
  indices,
  openIndex,
  renderRow,
}: {
  indices: readonly number[];
  openIndex: number | undefined;
  renderRow: (index: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-label="Earlier chats">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 border-0 bg-transparent px-2.5 pt-2 pb-1 text-left text-[0.75rem] font-normal text-text-secondary hover:text-text-primary"
        onClick={() => setExpanded(value => !value)}
      >
        <Icon name="chevron-down" className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')} />
        Earlier
      </button>
      {expanded ? <LimitedChatRows indices={indices} openIndex={openIndex} renderRow={renderRow} /> : null}
    </section>
  );
}

/**
 * The Chats column's list below its Folders heading: each folder (newest use first), then Today, then
 * Earlier. A chat in a folder shows only there. `renderRow` draws one chat by its index.
 */
export function RecentChatsGroups({
  indices,
  renderRow,
}: {
  indices: readonly number[];
  renderRow: (index: number) => ReactNode;
}) {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const activeRemoteId = useAuiState(s => s.threadListItem.remoteId);
  const chatFolders = useOptionalChatFolders();

  const openIndex = indices.find(index => {
    const id = threadIds[index];
    const item = threadItems.find(candidate => candidate.id === id);
    return activeRemoteId != null && (id === activeRemoteId || item?.remoteId === activeRemoteId);
  });
  const folders = chatFolders?.folders ?? [];
  const grouped = groupRecentChats({
    indices,
    threadIds,
    threadItems,
    folderIds: folders.map(folder => folder.id),
    folderIdOf: remoteId => chatFolders?.assignments.get(remoteId),
    now: new Date(),
  });
  const folderById = new Map(folders.map(folder => [folder.id, folder]));

  return (
    <>
      {grouped.folders.map(({ folderId, indices: folderIndices }) => {
        const folder = folderById.get(folderId);
        if (folder === undefined) return null;
        return (
          <ChatFolderSection key={folderId} folder={folder} count={folderIndices.length}>
            <LimitedChatRows indices={folderIndices} openIndex={openIndex} renderRow={renderRow} />
          </ChatFolderSection>
        );
      })}
      {grouped.today.length > 0 ? (
        <>
          <h3 className={groupHeadingClass}>Today</h3>
          <LimitedChatRows indices={grouped.today} openIndex={openIndex} renderRow={renderRow} />
        </>
      ) : null}
      {grouped.earlier.length > 0 ? (
        <EarlierChats indices={grouped.earlier} openIndex={openIndex} renderRow={renderRow} />
      ) : null}
    </>
  );
}
