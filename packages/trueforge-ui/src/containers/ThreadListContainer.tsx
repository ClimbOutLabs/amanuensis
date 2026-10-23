'use client';

import {
  ThreadListItemByIndexProvider,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { AgentHistoryFilterButton } from '../atoms/AgentHistoryFilterButton.js';
import { cn } from '../atoms/lib/cn.js';
import {
  canReuseMutableShell,
  filterChatsByTitle,
  readThreadAgentName,
  threadListIndicesByRecency,
  threadListItemIsMutable,
} from '../atoms/lib/threadListMeta.js';
import { useResourcePermissions } from '../hooks/useResourcePermissions.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders, type ChatFolderSession } from '../server/ChatFolderContext.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { ChatFolderSection, NewFolderButton, ThreadListItemActions } from './ChatFolderControls.js';
import { RecentChatsGroups, type RecentChat } from './RecentChatsGroups.js';

/**
 * Simplified relative to the reference: renders threads in a single flat list
 * rather than grouping them by Today/Yesterday/Earlier.
 *
 * Delete and folder-move live in `ChatFolderControls.ThreadListItemActions`
 * (adapter.delete → server.deleteSession). Mobile/compact keeps a BottomSheet chrome.
 */
export type ThreadListContainerProps = {
  /** Called after New chat or selecting a row — used by stack/drawer chrome. */
  onThreadOpen?: () => void;
  /** `recent-history` hides navigation and lists only persisted sessions. */
  variant?: 'default' | 'recent-history';
};

function ThreadListItemRow({
  onThreadOpen,
  canDeleteSession,
  canDeleteResource,
  canRenameSession,
}: {
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
  canRenameSession: boolean;
}) {
  const aui = useAui();
  const shell = useOptionalShellMode();
  const chatFolders = useOptionalChatFolders();
  const ThreadListRow = useSlot('ThreadListRow');
  const id = useAuiState(s => s.threadListItem.id);
  const remoteId = useAuiState(s => s.threadListItem.remoteId);
  const title = useAuiState(s => s.threadListItem.title);
  const lastMessageAt = useAuiState(s => s.threadListItem.lastMessageAt);
  const custom = useAuiState(s => s.threadListItem.custom);
  const mainThreadId = useAuiState(s => s.threads.mainThreadId);
  const agentName = readThreadAgentName(custom);
  const sidebarNavOpen = shell?.libraryOpen === true || shell?.sessionsOpen === true || shell?.schedulesOpen === true;
  const canDelete = canDeleteSession && remoteId != null && canDeleteResource(remoteId);
  const canRename = canRenameSession && remoteId != null;
  // The "..." actions menu holds Rename, Delete, and/or Move to folder (the "Show agent
  // details" item moved to a header button next to Clear chat), so it stays gated on those.
  const showActions = remoteId != null && (canDelete || chatFolders !== null || canRename);
  const currentFolderId = remoteId == null ? null : (chatFolders?.assignments.get(remoteId) ?? null);

  return (
    <ThreadListItemPrimitive.Root className="min-w-0">
      <ThreadListRow
        title={title ?? 'New Chat'}
        active={id === mainThreadId && !sidebarNavOpen}
        agentName={agentName}
        lastMessageAt={lastMessageAt}
        onSelect={() => {
          onThreadOpen?.();
          shell?.setSettingsOpen(false);
          shell?.setLibraryOpen(false);
          shell?.setSessionsOpen(false);
          shell?.setSchedulesOpen(false);

          // Prefer custom.isMutable (session wire); agentName-only is a legacy fallback.
          const sessionMutable = threadListItemIsMutable(custom);
          const sameImmutable =
            !sessionMutable &&
            shell?.mode.status === 'active' &&
            !shell.mode.isMutable &&
            (agentName == null
              ? shell.mode.agentName == null && shell.mode.agentId == null
              : shell.mode.agentName === agentName || shell.mode.agentId === agentName);
          const sameMutable = canReuseMutableShell({
            sessionMutable,
            shellMutable: shell?.mode.status === 'active' && shell.mode.isMutable,
            ...(shell?.mode.status === 'active' && shell.mode.isMutable
              ? { shellAgentName: shell.mode.agentName, shellAgentId: shell.mode.agentId }
              : {}),
            remoteId,
            pendingSessionId: shell?.pendingSessionId,
          });

          if ((sameImmutable || sameMutable) && remoteId != null) {
            void Promise.resolve(aui.threads().switchToThread(id)).catch(() => undefined);
            return;
          }
          if (remoteId != null) {
            shell?.openHistorySession({
              sessionId: remoteId,
              isMutable: sessionMutable,
              ...(agentName != null ? { agentName } : {}),
            });
            return;
          }
          void Promise.resolve(aui.threads().switchToThread(id)).catch(() => undefined);
        }}
        actions={
          showActions && remoteId != null ? (
            <ThreadListItemActions
              sessionId={remoteId}
              currentFolderId={currentFolderId}
              canDelete={canDelete}
              canRename={canRename}
              title={title ?? 'New Chat'}
            />
          ) : undefined
        }
      />
    </ThreadListItemPrimitive.Root>
  );
}

function useThreadListIndicesByRecency(variant: NonNullable<ThreadListContainerProps['variant']>): number[] {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);

  return useMemo(() => {
    const indices = threadListIndicesByRecency({ threadIds, threadItems });
    if (variant === 'default') return indices;

    const itemById = new Map<string, (typeof threadItems)[number]>();
    for (const item of threadItems) {
      itemById.set(item.id, item);
      if (item.remoteId != null) itemById.set(item.remoteId, item);
    }

    return indices.filter(index => {
      const id = threadIds[index];
      if (id === undefined) return false;
      const item = itemById.get(id);
      return item?.remoteId != null;
    });
  }, [threadIds, threadItems, variant]);
}

function ThreadListItemByIndex({
  index,
  onThreadOpen,
  canDeleteSession,
  canDeleteResource,
  canRenameSession,
}: {
  index: number;
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
  canRenameSession: boolean;
}) {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const key = threadIds[index] ?? String(index);
  return (
    <ThreadListItemByIndexProvider key={key} index={index} archived={false}>
      <ThreadListItemRow
        onThreadOpen={onThreadOpen}
        canDeleteSession={canDeleteSession}
        canDeleteResource={canDeleteResource}
        canRenameSession={canRenameSession}
      />
    </ThreadListItemByIndexProvider>
  );
}

function FolderSessionRow({
  session,
  active,
  onThreadOpen,
  canDeleteSession,
  canDeleteResource,
  canRenameSession,
  onDeleteSession,
  onRenamedSession,
}: {
  session: ChatFolderSession;
  active: boolean;
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
  canRenameSession: boolean;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRenamedSession: (input: { sessionId: string; title: string }) => void;
}) {
  const shell = useOptionalShellMode();
  const chatFolders = useOptionalChatFolders();
  const ThreadListRow = useSlot('ThreadListRow');
  const title = session.title ?? 'New Chat';
  const canDelete = canDeleteSession && canDeleteResource(session.sessionId);
  const showActions = canDelete || chatFolders !== null || canRenameSession;

  return (
    <ThreadListRow
      title={title}
      active={active}
      agentName={session.agentName ?? undefined}
      lastMessageAt={session.updatedAt}
      onSelect={() => {
        onThreadOpen?.();
        shell?.setSettingsOpen(false);
        shell?.setLibraryOpen(false);
        shell?.setSessionsOpen(false);
        shell?.setSchedulesOpen(false);
        shell?.openHistorySession({
          sessionId: session.sessionId,
          isMutable: session.isMutable,
          ...(session.agentName != null ? { agentName: session.agentName } : {}),
        });
      }}
      actions={
        showActions ? (
          <ThreadListItemActions
            sessionId={session.sessionId}
            currentFolderId={chatFolders?.assignments.get(session.sessionId) ?? null}
            canDelete={canDelete}
            canRename={canRenameSession}
            title={title}
            onDelete={() => onDeleteSession(session.sessionId)}
            onRenamed={nextTitle => onRenamedSession({ sessionId: session.sessionId, title: nextTitle })}
          />
        ) : undefined
      }
    />
  );
}

/** One chat the list can show: a loaded row by its index, or a chat only the folder store has. */
type ChatListEntry = RecentChat & {
  title: string;
  remoteId: string | undefined;
  index: number | null;
  session: ChatFolderSession | null;
};

/**
 * Every chat the list can show, in the order of `indices`, then the chats the folder store knows
 * that the recent list has not loaded. A chat counts as in a folder only while that folder exists;
 * a chat whose folder was deleted reads like one that was never filed.
 */
function useChatListEntries(indices: readonly number[]): ChatListEntry[] {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const chatFolders = useOptionalChatFolders();

  const itemByThreadId = new Map<string, (typeof threadItems)[number]>();
  for (const item of threadItems) {
    itemByThreadId.set(item.id, item);
  }
  const liveFolderIds = new Set((chatFolders?.folders ?? []).map(folder => folder.id));
  const folderIdOf = (sessionId: string): string | undefined => {
    const folderId = chatFolders?.assignments.get(sessionId);
    return folderId !== undefined && liveFolderIds.has(folderId) ? folderId : undefined;
  };

  const entries: ChatListEntry[] = [];
  const loadedRemoteIds = new Set<string>();
  for (const index of indices) {
    const threadId = threadIds[index];
    const item = threadId === undefined ? undefined : itemByThreadId.get(threadId);
    const remoteId = item?.remoteId ?? undefined;
    if (remoteId !== undefined) loadedRemoteIds.add(remoteId);
    entries.push({
      key: threadId ?? String(index),
      time: item?.lastMessageAt?.getTime() ?? Number.POSITIVE_INFINITY,
      folderId: remoteId === undefined ? undefined : folderIdOf(remoteId),
      title: item?.title ?? '',
      remoteId,
      index,
      session: null,
    });
  }

  if (chatFolders !== null) {
    // The folder query is complete even when the recent list has not loaded these chats.
    // Assignments decide the folder, so a chat moved shows in its new folder at once.
    const sessions = [...[...chatFolders.folderSessions.values()].flat(), ...chatFolders.unfiledSessions];
    for (const session of sessions) {
      if (loadedRemoteIds.has(session.sessionId)) continue;
      loadedRemoteIds.add(session.sessionId);
      entries.push({
        key: `folder-session-${session.sessionId}`,
        time: session.updatedAt.getTime(),
        folderId: folderIdOf(session.sessionId),
        title: session.title ?? '',
        remoteId: session.sessionId,
        index: null,
        session,
      });
    }
  }
  return entries;
}

/** Draws one chat entry: a loaded row through the runtime, or a folder-store chat directly. */
function useRenderChatEntry({
  onThreadOpen,
  canDeleteSession,
  canDeleteResource,
  canRenameSession,
}: {
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
  canRenameSession: boolean;
}): (entry: ChatListEntry) => ReactNode {
  const chatFolders = useOptionalChatFolders();
  const server = useOptionalServer();
  const shell = useOptionalShellMode();
  const activeRemoteId = useAuiState(s => s.threadListItem.remoteId);
  const sidebarNavOpen = shell?.libraryOpen === true || shell?.sessionsOpen === true || shell?.schedulesOpen === true;

  // Failures reach the delete dialog, which says so and keeps the chat.
  const deleteFolderSession = async (sessionId: string) => {
    if (server?.deleteSession === undefined) {
      throw new Error('Deleting chats is not available here.');
    }
    await server.deleteSession({ sessionId });
    chatFolders?.removeFolderSession({ sessionId });
  };

  return entry => {
    if (entry.index !== null) {
      return (
        <ThreadListItemByIndex
          key={entry.key}
          index={entry.index}
          onThreadOpen={onThreadOpen}
          canDeleteSession={canDeleteSession}
          canDeleteResource={canDeleteResource}
          canRenameSession={canRenameSession}
        />
      );
    }
    if (entry.session === null || chatFolders === null) return null;
    return (
      <FolderSessionRow
        key={entry.key}
        session={entry.session}
        active={entry.session.sessionId === activeRemoteId && !sidebarNavOpen}
        onThreadOpen={onThreadOpen}
        canDeleteSession={canDeleteSession}
        canDeleteResource={canDeleteResource}
        canRenameSession={canRenameSession}
        onDeleteSession={deleteFolderSession}
        onRenamedSession={chatFolders.updateFolderSessionTitle}
      />
    );
  };
}

const newestFirst = (entries: readonly ChatListEntry[]) => [...entries].sort((a, b) => b.time - a.time);

function ThreadListItemsByRecency({
  entries,
  renderEntry,
}: {
  entries: readonly ChatListEntry[];
  renderEntry: (entry: ChatListEntry) => ReactNode;
}) {
  const chatFolders = useOptionalChatFolders();

  // The flat list is enough when there are no folders and every chat the folder
  // store knows is already in the loaded list.
  const hasFolderOnlySessions = entries.some(entry => entry.session !== null);
  if (chatFolders === null || (chatFolders.folders.length === 0 && !hasFolderOnlySessions)) {
    return <>{entries.map(renderEntry)}</>;
  }

  const unfiledEntries = newestFirst(entries.filter(entry => entry.folderId === undefined));
  return (
    <>
      {chatFolders.folders.map(folder => {
        const folderEntries = newestFirst(entries.filter(entry => entry.folderId === folder.id));
        return (
          <ChatFolderSection key={folder.id} folder={folder} count={folderEntries.length}>
            {folderEntries.map(renderEntry)}
          </ChatFolderSection>
        );
      })}
      {unfiledEntries.length > 0 ? (
        <section aria-label="Unfiled chats" className="mt-1 flex flex-col gap-0.5">
          <div className="px-2 py-1 text-xs font-semibold text-text-secondary">Unfiled</div>
          {unfiledEntries.map(renderEntry)}
        </section>
      ) : null}
    </>
  );
}

const THREAD_LIST_VIEWPORT_SLOT = 'aui_thread-list-viewport';
/** How close to the bottom (px) before the next sessions page is fetched. */
const LOAD_MORE_BOTTOM_PX = 80;

/** The Chats column's search: a toggle in the header, and a field under it while open. */
type RecentChatsSearch = { open: boolean; query: string; onToggle: () => void; onQueryChange: (query: string) => void };

function RecentChatsSection({
  children,
  viewportRef,
  hideScrollbar,
  collapsible,
  search,
  folderHeading,
}: {
  children: ReactNode;
  viewportRef: Ref<HTMLDivElement>;
  hideScrollbar: boolean;
  /** `recent-history` renders in a narrow, always-open rail; only `default` collapses. */
  collapsible: boolean;
  search?: RecentChatsSearch;
  /** Puts a Folders heading with the new-folder control above the list. */
  folderHeading: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const shell = useOptionalShellMode();
  const chatFolders = useOptionalChatFolders();
  const activeRemoteId = useAuiState(s => s.threadListItem.remoteId);
  const historyFilterIntent = shell?.historyAgentFilter?.intent;
  const showFilter =
    shell?.isLibraryEnabled === true &&
    historyFilterIntent !== 'try-agent' &&
    (historyFilterIntent === 'history' ||
      shell.mode.status !== 'active' ||
      shell.mode.isMutable ||
      shell.pendingSessionId != null ||
      activeRemoteId != null);
  const heading = shell?.historyAgentFilter == null ? 'Chats' : `Chats for ${shell.historyAgentFilter.agentName}`;
  const isOpen = !collapsible || expanded;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-1 py-1">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-medium text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary"
            onClick={() => setExpanded(v => !v)}
          >
            <span className="truncate">{heading}</span>
            <Icon
              name="chevron-down"
              className={cn('size-3.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
            />
          </button>
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-1.5 py-1 text-sm font-medium text-text-secondary">{heading}</h2>
        )}
        {showFilter ? <AgentHistoryFilterButton /> : null}
        {search !== undefined ? (
          <button
            type="button"
            aria-label="Search chats"
            aria-pressed={search.open}
            title="Search chats"
            className="flex size-7 shrink-0 items-center justify-center rounded-full border border-transparent text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary"
            onClick={search.onToggle}
          >
            <Icon name="search" className="size-3.5" />
          </button>
        ) : null}
        {chatFolders !== null && !folderHeading ? <NewFolderButton /> : null}
      </div>
      {search?.open ? (
        <label className="mx-1 mb-1 flex shrink-0 items-center gap-2 rounded-[1.25rem] border border-border bg-card-bg px-3 py-1.5 focus-within:border-gold-line">
          <Icon name="search" className="size-3.5 shrink-0 text-text-secondary" />
          <input
            type="search"
            aria-label="Search chats"
            placeholder="Search chats"
            value={search.query}
            onChange={event => search.onQueryChange(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-text-primary outline-none placeholder:text-text-secondary"
            autoFocus
          />
        </label>
      ) : null}
      {folderHeading && chatFolders !== null ? (
        <div className="flex shrink-0 items-center justify-between px-2.5 pt-1 pb-0.5">
          <h3 className="m-0 text-[0.75rem] font-normal text-text-secondary">Folders</h3>
          <NewFolderButton />
        </div>
      ) : null}
      {isOpen ? (
        <div
          ref={viewportRef}
          data-slot={THREAD_LIST_VIEWPORT_SLOT}
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto',
            hideScrollbar && 'aui-scrollbar-hidden',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadListContainer({ onThreadOpen, variant = 'default' }: ThreadListContainerProps = {}) {
  const aui = useAui();
  const server = useOptionalServer();
  const chatFolders = useOptionalChatFolders();
  const isLoading = useAuiState(s => s.threads.isLoading);
  const isLoadingMore = useAuiState(s => s.threads.isLoadingMore);
  const hasMore = useAuiState(s => s.threads.hasMore);
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const activeRemoteId = useAuiState(s => s.threadListItem.remoteId);
  const shell = useOptionalShellMode();

  const ThreadListShell = useSlot('ThreadListShell');
  const ThreadListNewButton = useSlot('ThreadListNewButton');
  const AgentsLibraryButton = useSlot('AgentsLibraryButton');
  const SessionsBrowserButton = useSlot('SessionsBrowserButton');
  const SchedulesButton = useSlot('SchedulesButton');
  const SpacesButton = useSlot('SpacesButton');
  const ThreadListRowSkeleton = useSlot('ThreadListRowSkeleton');
  const ThreadListEmptyState = useSlot('ThreadListEmptyState');

  const indices = useThreadListIndicesByRecency(variant);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const hasMoreRef = useRef(hasMore);
  const auiRef = useRef(aui);
  hasMoreRef.current = hasMore;
  auiRef.current = aui;

  const showNewChat = shell?.isNewChatEnabled !== false;
  const isIdle = shell?.mode.status === 'idle';
  const isRecentHistory = variant === 'recent-history';
  const canDeleteSession = typeof server?.deleteSession === 'function';
  // `updateSession` is required on AgentChatServer, so any connected server can rename;
  // this only gates on the server existing at all (mirrors `chatFolders !== null` above).
  const canRenameSession = server !== null;
  const loadedRemoteSessionIds = useMemo(
    () => threadItems.flatMap(item => (item.remoteId == null ? [] : [item.remoteId])),
    [threadItems],
  );
  const remoteSessionIds = useMemo(() => {
    const sessionIds = [...loadedRemoteSessionIds];
    const seen = new Set(sessionIds);
    if (chatFolders !== null) {
      for (const sessions of chatFolders.folderSessions.values()) {
        for (const session of sessions) {
          if (!seen.has(session.sessionId)) {
            seen.add(session.sessionId);
            sessionIds.push(session.sessionId);
          }
        }
      }
      for (const session of chatFolders.unfiledSessions) {
        if (!seen.has(session.sessionId)) {
          seen.add(session.sessionId);
          sessionIds.push(session.sessionId);
        }
      }
    }
    return sessionIds;
  }, [chatFolders, loadedRemoteSessionIds]);
  const previousLoadedRemoteSessionIdsRef = useRef<ReadonlySet<string> | null>(null);

  // A chat deleted or archived outside this list can leave its folder copy behind. Drop that
  // copy once the loaded list no longer contains the chat, so it does not reappear as unloaded.
  useEffect(() => {
    if (chatFolders === null || isLoading || isLoadingMore) return;
    const current = new Set(loadedRemoteSessionIds);
    const previous = previousLoadedRemoteSessionIdsRef.current;
    previousLoadedRemoteSessionIdsRef.current = current;
    if (previous === null) return;
    for (const sessionId of previous) {
      if (!current.has(sessionId) && chatFolders.assignments.has(sessionId)) {
        chatFolders.removeFolderSession({ sessionId });
      }
    }
  }, [chatFolders, isLoading, isLoadingMore, loadedRemoteSessionIds]);

  const { allows } = useResourcePermissions({ resourceType: 'session', resourceIds: remoteSessionIds });
  const canDeleteResource = (sessionId: string) => allows(sessionId, 'DELETE');
  const entries = useChatListEntries(indices);
  const renderEntry = useRenderChatEntry({ onThreadOpen, canDeleteSession, canDeleteResource, canRenameSession });

  // Fill an underflowing viewport; once it scrolls, paginate only near the bottom.
  // Re-measure after commit (threadIds / hasMore) instead of rAF-chaining, which
  // raced layout and could drain every remaining listSessions page.
  // The runtime owns request deduplication, so Strict Mode remounts can recheck safely.
  useEffect(() => {
    if (isIdle || isLoading || isLoadingMore) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    let cancelled = false;

    const tryLoadMore = () => {
      if (cancelled || !hasMoreRef.current) return;
      if (viewport.clientHeight <= 0) return;

      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (viewport.scrollHeight > viewport.clientHeight && remaining > LOAD_MORE_BOTTOM_PX) return;

      void auiRef.current.threads().loadMore();
    };

    viewport.addEventListener('scroll', tryLoadMore, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => tryLoadMore());
    if (resizeObserver) {
      resizeObserver.observe(viewport);
    } else {
      window.addEventListener('resize', tryLoadMore);
    }
    tryLoadMore();

    return () => {
      cancelled = true;
      viewport.removeEventListener('scroll', tryLoadMore);
      resizeObserver?.disconnect();
      if (!resizeObserver) {
        window.removeEventListener('resize', tryLoadMore);
      }
    };
  }, [hasMore, isIdle, isLoading, isLoadingMore, threadIds.length]);

  const handleNewChat = () => {
    onThreadOpen?.();
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openDraft();
      return;
    }
    shell?.setSettingsOpen(false);
    shell?.setSchedulesOpen(false);
    void Promise.resolve(aui.threads().switchToNewThread()).catch(() => undefined);
  };

  const emptyMessage = isRecentHistory ? 'Your chats will show up here.' : undefined;
  const loadedRemoteSessionIdSet = new Set(loadedRemoteSessionIds);
  const hasFolderOnlySessions = remoteSessionIds.some(sessionId => !loadedRemoteSessionIdSet.has(sessionId));
  const hasFolders = chatFolders !== null && (chatFolders.folders.length > 0 || hasFolderOnlySessions);
  const shownEntries = isRecentHistory
    ? filterChatsByTitle({ chats: entries, query: searchOpen ? searchQuery : '' })
    : entries;
  const openKey = activeRemoteId == null ? undefined : entries.find(entry => entry.remoteId === activeRemoteId)?.key;

  let listBody: ReactNode;
  if (isIdle) {
    listBody = <ThreadListEmptyState message={emptyMessage} />;
  } else if (isLoading) {
    listBody = <ThreadListRowSkeleton />;
  } else if (entries.length === 0 && !hasFolders) {
    listBody = <ThreadListEmptyState message={emptyMessage} />;
  } else if (shownEntries.length === 0 && !hasFolders) {
    listBody = <ThreadListEmptyState message="No chats match that search." />;
  } else {
    listBody = (
      <ThreadListPrimitive.Root className="flex min-h-0 flex-col gap-0.5">
        {isRecentHistory ? (
          <RecentChatsGroups chats={shownEntries} openKey={openKey} renderRow={renderEntry} />
        ) : (
          <ThreadListItemsByRecency entries={shownEntries} renderEntry={renderEntry} />
        )}
      </ThreadListPrimitive.Root>
    );
  }

  return (
    <ThreadListShell
      header={
        isRecentHistory ? null : (
          <div className="flex flex-col gap-1">
            {showNewChat ? <ThreadListNewButton onClick={handleNewChat} /> : null}
            <AgentsLibraryButton />
            <SessionsBrowserButton />
            <SchedulesButton />
            <SpacesButton />
          </div>
        )
      }
    >
      <RecentChatsSection
        viewportRef={viewportRef}
        hideScrollbar={isRecentHistory}
        collapsible={!isRecentHistory}
        folderHeading={isRecentHistory}
        search={
          isRecentHistory
            ? {
                open: searchOpen,
                query: searchQuery,
                onToggle: () => {
                  setSearchOpen(open => !open);
                  setSearchQuery('');
                },
                onQueryChange: setSearchQuery,
              }
            : undefined
        }
      >
        {chatFolders?.loadError != null ? (
          <p role="alert" className="mx-2 mb-2 rounded-md bg-failure-bg/12 px-2 py-1.5 text-sm text-failure-bg">
            {chatFolders.loadError}
          </p>
        ) : null}
        {listBody}
        {!isIdle && hasMore ? <div className="h-4 shrink-0" aria-hidden /> : null}
      </RecentChatsSection>
    </ThreadListShell>
  );
}
