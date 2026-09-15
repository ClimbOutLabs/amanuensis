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
  readThreadAgentName,
  threadListIndicesByRecency,
  threadListItemIsMutable,
} from '../atoms/lib/threadListMeta.js';
import { useResourcePermissions } from '../hooks/useResourcePermissions.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalChatFolders } from '../server/ChatFolderContext.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { ChatFolderSection, ThreadListItemActions } from './ChatFolderControls.js';

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
}: {
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
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
  const showActions = remoteId != null && (canDelete || chatFolders !== null);
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
            <ThreadListItemActions sessionId={remoteId} currentFolderId={currentFolderId} canDelete={canDelete} />
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
}: {
  index: number;
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
}) {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const key = threadIds[index] ?? String(index);
  return (
    <ThreadListItemByIndexProvider key={key} index={index} archived={false}>
      <ThreadListItemRow
        onThreadOpen={onThreadOpen}
        canDeleteSession={canDeleteSession}
        canDeleteResource={canDeleteResource}
      />
    </ThreadListItemByIndexProvider>
  );
}

function ThreadListItemsByRecency({
  indices,
  onThreadOpen,
  canDeleteSession,
  canDeleteResource,
}: {
  indices: number[];
  onThreadOpen?: () => void;
  canDeleteSession: boolean;
  canDeleteResource: (sessionId: string) => boolean;
}) {
  const threadIds = useAuiState(s => s.threads.threadIds);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const chatFolders = useOptionalChatFolders();

  if (chatFolders === null || chatFolders.folders.length === 0) {
    return (
      <>
        {indices.map(index => (
          <ThreadListItemByIndex
            key={threadIds[index] ?? String(index)}
            index={index}
            onThreadOpen={onThreadOpen}
            canDeleteSession={canDeleteSession}
            canDeleteResource={canDeleteResource}
          />
        ))}
      </>
    );
  }

  const indexByFolder = new Map<string, number[]>();
  const unfiled: number[] = [];
  for (const index of indices) {
    const threadId = threadIds[index];
    const item = threadItems.find(candidate => candidate.id === threadId);
    const remoteId = item?.remoteId;
    const folderId = remoteId == null ? undefined : chatFolders.assignments.get(remoteId);
    if (folderId === undefined) {
      unfiled.push(index);
      continue;
    }
    const folderIndices = indexByFolder.get(folderId) ?? [];
    folderIndices.push(index);
    indexByFolder.set(folderId, folderIndices);
  }

  return (
    <>
      {chatFolders.folders.map(folder => (
        <ChatFolderSection key={folder.id} folder={folder} count={(indexByFolder.get(folder.id) ?? []).length}>
          {(indexByFolder.get(folder.id) ?? []).map(index => (
            <ThreadListItemByIndex
              key={threadIds[index] ?? String(index)}
              index={index}
              onThreadOpen={onThreadOpen}
              canDeleteSession={canDeleteSession}
              canDeleteResource={canDeleteResource}
            />
          ))}
        </ChatFolderSection>
      ))}
      {unfiled.length > 0 ? (
        <section aria-label="Unfiled chats" className="mt-1 flex flex-col gap-0.5">
          <div className="px-2 py-1 text-xs font-semibold text-text-secondary">Unfiled</div>
          {unfiled.map(index => (
            <ThreadListItemByIndex
              key={threadIds[index] ?? String(index)}
              index={index}
              onThreadOpen={onThreadOpen}
              canDeleteSession={canDeleteSession}
              canDeleteResource={canDeleteResource}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}

const THREAD_LIST_VIEWPORT_SLOT = 'aui_thread-list-viewport';
/** How close to the bottom (px) before the next sessions page is fetched. */
const LOAD_MORE_BOTTOM_PX = 80;

function RecentChatsSection({
  children,
  viewportRef,
  hideScrollbar,
  collapsible,
}: {
  children: ReactNode;
  viewportRef: Ref<HTMLDivElement>;
  hideScrollbar: boolean;
  /** `recent-history` renders in a narrow, always-open rail; only `default` collapses. */
  collapsible: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const shell = useOptionalShellMode();
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
  const heading =
    shell?.historyAgentFilter == null ? 'Chat History' : `Chats for ${shell.historyAgentFilter.agentName}`;
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
      </div>
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const hasMoreRef = useRef(hasMore);
  const auiRef = useRef(aui);
  hasMoreRef.current = hasMore;
  auiRef.current = aui;

  const showNewChat = shell?.isNewChatEnabled !== false;
  const isIdle = shell?.mode.status === 'idle';
  const isRecentHistory = variant === 'recent-history';
  const canDeleteSession = typeof server?.deleteSession === 'function';
  const remoteSessionIds = useMemo(
    () => threadItems.flatMap(item => (item.remoteId == null ? [] : [item.remoteId])),
    [threadItems],
  );
  const { allows } = useResourcePermissions({ resourceType: 'session', resourceIds: remoteSessionIds });
  const canDeleteResource = (sessionId: string) => allows(sessionId, 'DELETE');

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

  const emptyMessage = isRecentHistory ? 'No recent chats' : undefined;
  const hasFolders = chatFolders !== null && chatFolders.folders.length > 0;

  let listBody: ReactNode;
  if (isIdle) {
    listBody = <ThreadListEmptyState message={emptyMessage} />;
  } else if (isLoading) {
    listBody = <ThreadListRowSkeleton />;
  } else if (indices.length === 0 && !hasFolders) {
    listBody = <ThreadListEmptyState message={emptyMessage} />;
  } else {
    listBody = (
      <ThreadListPrimitive.Root className="flex min-h-0 flex-col gap-0.5">
        <ThreadListItemsByRecency
          indices={indices}
          onThreadOpen={onThreadOpen}
          canDeleteSession={canDeleteSession}
          canDeleteResource={canDeleteResource}
        />
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
      <RecentChatsSection viewportRef={viewportRef} hideScrollbar={isRecentHistory} collapsible={!isRecentHistory}>
        {listBody}
        {!isIdle && hasMore ? <div className="h-4 shrink-0" aria-hidden /> : null}
      </RecentChatsSection>
    </ThreadListShell>
  );
}
