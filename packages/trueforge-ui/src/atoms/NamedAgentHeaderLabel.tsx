'use client';

import { useAuiState } from '../assistant-ui.js';
import { briefTopBarTitle } from '../components/briefSections.js';
import { briefRequestDate } from '../containers/briefTurn.js';
import { useNamedAgentHeaderState } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { EditableChatTitle } from './EditableChatTitle.js';
import { cn } from './lib/cn.js';
import { pageHeaderTitleClassName } from './PageHeader.js';
import { Tooltip } from './primitives/Tooltip.js';

/** Dynamic chat title for named agents and New Chat / New Agent drafts. */
export function NamedAgentHeaderLabel({ className }: { className?: string }) {
  const state = useNamedAgentHeaderState();
  const threadTitle = useAuiState(s => s.threadListItem.title);
  const remoteId = useAuiState(s => s.threadListItem.remoteId);
  const server = useOptionalServer();
  const briefDate = useAuiState(s => briefRequestDate(s.thread.messages));
  if (briefDate !== null) {
    return (
      <h1 className={cn('flex min-w-0 items-center', pageHeaderTitleClassName, className)}>
        {briefTopBarTitle(briefDate)}
      </h1>
    );
  }
  if (state === null) return null;

  const syncedTitle = threadTitle?.trim() ?? '';
  const showsChatTitle = state.allowThreadTitle && syncedTitle.length > 0;
  const displayName = showsChatTitle ? syncedTitle : state.name;
  // Only the chat title is renamable; a named agent's header shows the agent, not this chat.
  const renameSessionId = showsChatTitle && server !== null ? remoteId : undefined;

  return (
    <h1 className={cn('flex min-w-0 items-center gap-1.5', pageHeaderTitleClassName, className)}>
      {renameSessionId != null ? (
        <EditableChatTitle sessionId={renameSessionId} title={syncedTitle} />
      ) : (
        <span className="truncate" title={displayName}>
          {displayName}
        </span>
      )}
      {state.isEditing ? (
        <Tooltip content="Try changes here, then choose Update agent to save." side="bottom">
          <span className="border-warning-bg/40 bg-warning-bg/10 text-warning-bg inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
            <Icon name="pencil" className="size-3" />
            Editing
          </span>
        </Tooltip>
      ) : null}
    </h1>
  );
}
