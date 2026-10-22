import type { RespondToToolApprovalOptions, ThreadMessageLike } from '@assistant-ui/react';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AgentDetailsPreferenceProvider } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

export const AGENT_DETAILS_SESSION_ID = 'sess-1';

/** A server whose one session stores the chat-level "Show agent details" switch as given. */
export function agentDetailsServer(agentDetails: 'expanded' | 'collapsed') {
  const session = {
    id: AGENT_DETAILS_SESSION_ID,
    isMutable: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    metadata: { agent_details: agentDetails },
  };
  return createMockAgentUIServer({
    getSession: async () => session,
    updateSession: async () => session,
  });
}

/** Lets the stored switch load from the server. */
export async function settleAgentDetails(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A runtime for a chat with a server session, its "Show agent details" switch stored as given. */
export function AgentDetailsHarness({
  agentDetails,
  messages,
  isRunning,
  onRespondToToolApproval,
  children,
}: {
  agentDetails: 'expanded' | 'collapsed';
  messages: ThreadMessageLike[];
  isRunning?: boolean;
  onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void;
  children: ReactNode;
}) {
  return (
    <ServerProvider server={agentDetailsServer(agentDetails)}>
      <AgentDetailsPreferenceProvider>
        <RuntimeHarness
          messages={messages}
          isRunning={isRunning}
          threadId="t1"
          remoteId={AGENT_DETAILS_SESSION_ID}
          onRespondToToolApproval={onRespondToToolApproval}
        >
          {children}
        </RuntimeHarness>
      </AgentDetailsPreferenceProvider>
    </ServerProvider>
  );
}
