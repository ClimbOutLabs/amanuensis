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
import {
  ComposerBusyScopeProvider,
  getActiveComposerSendId,
  notifyComposerBusyFailure,
  useComposerBusyScope,
} from '../hooks/useComposerBusyState.js';
import { ActiveSessionPermissionsProvider } from '../hooks/useResourcePermissions.js';
import type { AgentUIServer } from '../server/types.js';
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
      notifyComposerBusyFailure(getActiveComposerSendId(composerBusyScope), composerBusyScope);
      reportError(error);
    },
    [composerBusyScope, reportError],
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
  const { server, initialSessionId, adapters, onError, children, agent, agentName, listSessionsAgentId } = props;

  const stableServer = useMemo(() => server, [server]);

  return (
    <ToasterProvider>
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
          {children}
        </ChatRuntimeScope>
      </ComposerBusyScopeProvider>
    </ToasterProvider>
  );
}
