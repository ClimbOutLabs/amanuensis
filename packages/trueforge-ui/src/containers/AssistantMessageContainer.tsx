'use client';

import { useActionBarCopy, useMessageError, useThreadIsRunning, type PartState } from '@assistant-ui/core/react';
import {
  MessagePrimitive,
  useAuiState,
  type EnrichedPartState,
  type GroupByContext,
  type MessageStatus,
} from '@assistant-ui/react';
import { useTrueFoundryResumeUnavailable } from '@truefoundry/assistant-ui-runtime';

import type { AgentStepsPhase } from '../atoms/adapters/AgentStepsCardAdapter.js';
import { MemoryContextCard } from '../atoms/agent-chat/MemoryContextCard.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { computeAgentStepsSplit } from '../utils/computeAgentStepsSplit.js';
import { AgentStepsContainer } from './AgentStepsContainer.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { useDocumentIngestionStatusLine } from './DocumentIngestionStatusProvider.js';
import { useMemoryTurnContext, useMemoryTurnContextStatus } from './MemoryTurnContextProvider.js';
import { MessageImageContainer } from './MessageImageContainer.js';
import { ReasoningContainer } from './ReasoningContainer.js';
import { ToolCallContainer } from './ToolCallContainer.js';
import type { ThreadGroupPart } from './ToolGroupContainer.js';

/**
 * Dispatches a leaf message part to its renderer. "data" parts (generative
 * UI) are out of scope for this SDK entirely.
 */
function AssistantReasoningProgress() {
  const ReasoningCard = useSlot('ReasoningCard');
  return <ReasoningCard content="" isStreaming headingText="Thinking…" />;
}

function AssistantLeafPartContainer({ part }: { part: EnrichedPartState }) {
  switch (part.type) {
    case 'text':
      return <AssistantTextContainer />;
    case 'reasoning':
      return part.status?.type === 'running' ? <AssistantReasoningProgress /> : null;
    case 'image':
      return <MessageImageContainer />;
    case 'tool-call':
      return <ToolCallContainer {...part} />;
    default:
      return null;
  }
}

function stepPhase(
  parts: readonly PartState[],
  messageStatus: MessageStatus['type'] | undefined,
): AgentStepsPhase | undefined {
  if (messageStatus === 'requires-action') {
    const hasPendingApproval = parts.some(
      part =>
        part.type === 'tool-call' &&
        part.status?.type === 'requires-action' &&
        part.approval != null &&
        part.approval.approved === undefined &&
        part.approval.resolution === undefined,
    );
    return hasPendingApproval ? 'waiting-for-approval' : undefined;
  }
  if (messageStatus !== 'running') return undefined;
  if (parts.some(part => part.type === 'tool-call' && part.status?.type === 'running')) {
    return 'executing-tools';
  }
  return 'waiting-for-model';
}

export function AssistantMessageContainer() {
  const AssistantMessageBubble = useSlot('AssistantMessageBubble');
  const MessageActionBar = useSlot('MessageActionBar');
  const MessageErrorBanner = useSlot('MessageErrorBanner');
  const MessageIndicator = useSlot('MessageIndicator');
  const isThreadRunning = useThreadIsRunning();
  const resumeUnavailable = useTrueFoundryResumeUnavailable();
  const error = useMessageError();
  const createdAt = useAuiState(s => s.message.createdAt);
  const messageStatus = useAuiState(s => s.message.status?.type);
  const isMessageRunning = messageStatus === 'running';
  const { copy, isCopied } = useActionBarCopy({
    copyToClipboard: text => navigator.clipboard.writeText(text),
  });

  // `metadata.custom.turnId` is set by the runtime for both live and replayed messages (see
  // `MemoryTurnContextProvider`), so this survives a reload the same way tool-call parts do.
  const turnId = useAuiState(s => {
    const value = s.message.metadata.custom.turnId;
    return typeof value === 'string' ? value : undefined;
  });
  const memoryContext = useMemoryTurnContext(turnId);
  const { hasError: memoryContextHasError, retry: retryMemoryContext } = useMemoryTurnContextStatus();
  const ingestionStatusLine = useDocumentIngestionStatusLine(turnId);

  const parts = useAuiState(s => s.message.parts);

  const { cutIndex, hasFinal, toolCount, thinkingCount } = computeAgentStepsSplit(parts, isMessageRunning);
  const phase = stepPhase(parts, messageStatus);

  const groupBy = (part: PartState, _context: GroupByContext): readonly `group-${string}`[] | null => {
    const index = parts.findIndex(p => p === part);
    if (index === -1) return null;

    if (part.type === 'text' && index >= cutIndex) {
      return null;
    }

    if (index < cutIndex) {
      if (part.type === 'reasoning') {
        return ['group-agentSteps', 'group-reasoning'];
      }
      return ['group-agentSteps'];
    }

    return null;
  };

  return (
    <MessagePrimitive.Root data-role="assistant">
      <AssistantMessageBubble
        error={error !== undefined ? <MessageErrorBanner message={String(error)} /> : undefined}
        actionBar={
          !isThreadRunning ? <MessageActionBar isCopied={isCopied} onCopy={copy} createdAt={createdAt} /> : undefined
        }
      >
        <MemoryContextCard
          recall={memoryContext?.recall}
          profile={memoryContext?.profile}
          unavailable={memoryContext == null && memoryContextHasError}
          onRetry={retryMemoryContext}
        />
        {ingestionStatusLine !== undefined && (
          <p className="mb-2 text-xs italic text-text-secondary" data-testid="document-ingestion-status">
            {ingestionStatusLine}
          </p>
        )}
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case 'group-agentSteps':
                return (
                  <AgentStepsContainer
                    toolCount={toolCount}
                    thinkingCount={thinkingCount}
                    hasFinal={hasFinal}
                    phase={phase}
                  >
                    {children}
                  </AgentStepsContainer>
                );
              case 'group-reasoning':
                return isMessageRunning ? <ReasoningContainer group={part as ThreadGroupPart} /> : null;
              case 'text': {
                const index = parts.findIndex(p => p === part);
                // Intermediate text inside Agent steps: muted + indented vs final answer
                if (index >= 0 && index < cutIndex) {
                  return (
                    <div className="mb-2 ml-[1.75rem] text-xs text-text-secondary [&_.markdown-body]:text-inherit">
                      <AssistantTextContainer />
                    </div>
                  );
                }
                return <AssistantTextContainer />;
              }
              case 'reasoning':
                return isMessageRunning ? <AssistantLeafPartContainer part={part} /> : null;
              case 'tool-call':
              case 'image':
              case 'data':
                return <AssistantLeafPartContainer part={part} />;
              case 'indicator':
                return resumeUnavailable ? null : <MessageIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </AssistantMessageBubble>
    </MessagePrimitive.Root>
  );
}
