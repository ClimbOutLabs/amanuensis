'use client';

import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import {
  trueFoundryAttachmentAdapter,
  useTrueFoundryAgentRuntime,
  type TrueFoundryAgentConfig,
  type UseTrueFoundryAgentRuntimeOptions,
} from '@truefoundry/assistant-ui-runtime';
import { useCallback, useMemo, type ReactNode } from 'react';
import { withImageDownscaling } from '../server/imageAttachmentAdapter.js';

import { sessionIsCreateAgent } from '../atoms/lib/sessionCreateAgent.js';
import { AvatarActivityProvider, useAvatarActivitySink, type AmanAvatarActivity } from '../hooks/useAvatarActivity.js';
import {
  ComposerBusyScopeProvider,
  getActiveComposerSendId,
  notifyComposerBusyFailure,
  useComposerBusyScope,
} from '../hooks/useComposerBusyState.js';
import { ForegroundEventSync } from '../hooks/useForegroundEventSync.js';
import { ActiveSessionPermissionsProvider } from '../hooks/useResourcePermissions.js';
import {
  isPendingApprovalsError,
  publishBlockedSend,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import type { AgentUIServer } from '../server/types.js';
import { isStaleApprovalError, publishStaleApproval } from '../utils/staleApproval.js';
import { PendingApprovalsReporter } from './PendingApprovalsReporter.js';
import { ToasterProvider, useToaster } from './ToasterContainer.js';

type RuntimeAdapters = NonNullable<UseTrueFoundryAgentRuntimeOptions['adapters']>;

function ActiveSessionPermissionScope({
  locallyCreatedSessionIds,
  children,
}: {
  locallyCreatedSessionIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  const remoteId = useAuiState(state => state.threadListItem.remoteId);
  return (
    <ActiveSessionPermissionsProvider
      sessionId={remoteId}
      assumeManage={remoteId != null && locallyCreatedSessionIds.has(remoteId)}
    >
      {children}
    </ActiveSessionPermissionsProvider>
  );
}

function runtimeServer({
  server,
  locallyCreatedSessionIds,
}: {
  server: AgentUIServer;
  locallyCreatedSessionIds: Set<string>;
}): AgentUIServer {
  return {
    ...server,
    async createSession(request) {
      const session = await server.createSession(request);
      locallyCreatedSessionIds.add(session.id);
      return session;
    },
    async listSessions(request) {
      const result = await server.listSessions(request);
      return {
        ...result,
        data: result.data.filter(session => !sessionIsCreateAgent(session)),
      };
    },
  };
}

export type TrueFoundryChatProviderProps = {
  server: AgentUIServer;
  initialSessionId?: string;
  adapters?: RuntimeAdapters;
  onError?: (error: unknown) => void;
  /**
   * Raw agent activity for the living avatar, emitted immediately on ground-truth change:
   * 'thinking' while submitting or working without visible streaming, 'writing' while
   * response tokens visibly stream into chat, 'error' when a failure is surfaced (auto-clears),
   * 'idle' otherwise. Presentation policy (debounce, dwell) is the avatar's job, not this callback's.
   */
  onAgentActivity?: (activity: AmanAvatarActivity) => void;
  /** Reports the ids of approvals waiting on the person, for hosts that show them outside the chat. */
  onPendingApprovalsChange?: (approvalIds: readonly string[]) => void;
  children: ReactNode;
  /** Discriminated agent source. Prefer over legacy `agentName`. */
  agent?: TrueFoundryAgentConfig;
  /** Legacy named-agent shorthand. Prefer `agent: { mode: "named", agentName }`. */
  agentName?: string;
  /** Forwarded to `listSessions({ agentId })` for history filtering. */
  listSessionsAgentId?: string;
};

function ChatRuntimeScope({
  server,
  agent,
  agentName,
  listSessionsAgentId,
  initialSessionId,
  adapters,
  onError,
  children,
}: {
  server: AgentUIServer;
  agent?: TrueFoundryAgentConfig;
  agentName?: string;
  listSessionsAgentId?: string;
  initialSessionId?: string;
  adapters?: RuntimeAdapters;
  onError?: (error: unknown) => void;
  children: ReactNode;
}) {
  const { showError } = useToaster();
  const reportError = onError ?? showError;
  const activitySink = useAvatarActivitySink();
  // Scopes this chat instance's own busy-state world (see `ComposerBusyScopeProvider` below):
  // two chats rendered side by side get two distinct scopes, so a failure reported here can
  // never be routed to, or read from, a different chat's `ComposerBusyProvider`.
  const composerBusyScope = useComposerBusyScope();
  const localSessionState = useMemo(() => ({ server, ids: new Set<string>() }), [server]);
  const locallyCreatedSessionIds = localSessionState.ids;
  const historyServer = useMemo(
    () => runtimeServer({ server, locallyCreatedSessionIds }),
    [locallyCreatedSessionIds, server],
  );
  // composer().send() is void and swallows onNew rejections; clear optimistic
  // busy when the runtime reports a pre-stream failure (e.g. createSession).
  // The runtime hands back no attempt id of its own, so this failure is stamped with the id of
  // the most recently dispatched send within THIS chat's own scope: routed to its latest attempt
  // rather than clearing busy state unconditionally, which would let it clobber a resend already
  // in flight (in this chat, or in an unrelated one sharing the same module).
  const resolvedOnError = useCallback(
    (error: unknown) => {
      // A surfaced failure is avatar ground truth too: hold the composed error pose, then
      // ease back. Fires whether the host or the toaster renders the error itself.
      activitySink?.reportError();
      notifyComposerBusyFailure(getActiveComposerSendId(composerBusyScope), composerBusyScope);
      if (isPendingApprovalsError(error)) {
        // The send was rejected because the session tip still holds pending
        // tool approvals. Surface the escape hatch immediately (the banner
        // offers the dismiss action) and probe the tip so the runtime learns
        // the approvals even when the approval card never rendered.
        publishBlockedSend();
      }
      if (isStaleApprovalError(error)) {
        // Reload so the expired card is replaced by the chat's current state.
        publishStaleApproval();
      }
      reportError(error);
    },
    [activitySink, composerBusyScope, reportError],
  );

  const runtime = useTrueFoundryAgentRuntime({
    server: historyServer as never,
    agent,
    agentName,
    listSessionsAgentId,
    listSessionsCreatedByMe: true,
    initialSessionId,
    onError: resolvedOnError,
    adapters: {
      ...adapters,
      attachments: adapters?.attachments ?? withImageDownscaling(trueFoundryAttachmentAdapter),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime as never}>
      <ForegroundEventSync />
      <ActiveSessionPermissionScope locallyCreatedSessionIds={locallyCreatedSessionIds}>
        {children}
      </ActiveSessionPermissionScope>
    </AssistantRuntimeProvider>
  );
}

/**
 * Chat shell: wires `useTrueFoundryAgentRuntime` from `server` and provides
 * assistant-ui + error toasts.
 */
export function TrueFoundryChatProvider(props: TrueFoundryChatProviderProps) {
  const {
    server,
    initialSessionId,
    adapters,
    onError,
    onAgentActivity,
    onPendingApprovalsChange,
    children,
    agent,
    agentName,
    listSessionsAgentId,
  } = props;

  const stableServer = useMemo(() => server, [server]);

  return (
    <ToasterProvider>
      <AvatarActivityProvider onActivity={onAgentActivity}>
        <ComposerBusyScopeProvider>
          <ChatRuntimeScope
            server={stableServer}
            agent={agent}
            agentName={agentName}
            listSessionsAgentId={listSessionsAgentId}
            initialSessionId={initialSessionId}
            adapters={adapters}
            onError={onError}
          >
            {onPendingApprovalsChange === undefined ? null : (
              <PendingApprovalsReporter onChange={onPendingApprovalsChange} />
            )}
            {children}
          </ChatRuntimeScope>
        </ComposerBusyScopeProvider>
      </AvatarActivityProvider>
    </ToasterProvider>
  );
}
