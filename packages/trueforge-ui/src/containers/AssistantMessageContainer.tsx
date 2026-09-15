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
import { AgentInternalsDisclosure } from '../atoms/agent-chat/AgentInternalsDisclosure.js';
import { MemoryContextCard } from '../atoms/agent-chat/MemoryContextCard.js';
import { useAgentInternalsPreference } from '../hooks/useAgentInternalsPreference.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { computeAgentStepsSplit } from '../utils/computeAgentStepsSplit.js';
import { parseToolResultDisposition } from '../utils/toolCallParsing.js';
import { AgentStepsContainer } from './AgentStepsContainer.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { useDocumentIngestionStatusLine } from './DocumentIngestionStatusProvider.js';
import { useMemoryTurnContext, useMemoryTurnContextStatus } from './MemoryTurnContextProvider.js';
import { MessageImageContainer } from './MessageImageContainer.js';
import { ReasoningContainer } from './ReasoningContainer.js';
import { ToolCallContainer } from './ToolCallContainer.js';

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
    // A pending approval is a tool-call part with an undecided approval.
    // The part's own status may not be set in all runtimes; the message-level
    // 'requires-action' is the authoritative signal.
    const hasPendingApproval = parts.some(
      part =>
        part.type === 'tool-call' &&
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

/**
 * A tool-call part counts as errored when its result disposition carries an
 * error tone. The incomplete-status branch is a fallback for runtimes that
 * preserve part-level statuses (the external-store runtime normalizes them).
 */
function isToolPartErrored(part: PartState): boolean {
  if (part.type !== 'tool-call') return false;
  if (part.status?.type === 'incomplete') return true;
  return parseToolResultDisposition(part.result)?.tone === 'error';
}

function pluralize(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

function buildInternalsSummary({
  toolCount,
  thinkingCount,
  recalledItems,
}: {
  toolCount: number;
  thinkingCount: number;
  recalledItems: number;
}): string {
  const segments: string[] = [];
  const steps = toolCount + thinkingCount;
  if (steps > 0) segments.push(pluralize(steps, 'step'));
  if (toolCount > 0) segments.push(pluralize(toolCount, 'tool'));
  if (recalledItems > 0) segments.push(`${String(recalledItems)} recalled`);
  return segments.join(' · ');
}

const PHASE_LIVE_LABELS: Record<AgentStepsPhase, string> = {
  'waiting-for-model': 'Waiting for model',
  'executing-tools': 'Executing tools',
  'waiting-for-approval': 'Waiting for approval',
};

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
  const { showAgentInternals, setShowAgentInternals } = useAgentInternalsPreference();
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

  // Progressive disclosure inputs: errors and approvals surface with an amber
  // dot and auto-expand; a clean completed turn with no tools, no thinking, no
  // memory, and no errors renders no internals row at all.
  const recall = memoryContext?.recall;
  const recalledItems = recall?.stats.items ?? 0;
  const hasMemory = recall != null || memoryContext?.profile != null;
  const memoryFailed = memoryContext == null && memoryContextHasError;
  const recallOutcomeBad = recall != null && (recall.stats.outcome === 'timeout' || recall.stats.outcome === 'error');
  const hasToolError = parts.some(isToolPartErrored);
  const attention = hasToolError || recallOutcomeBad || memoryFailed || phase === 'waiting-for-approval';
  const trivial = !isMessageRunning && toolCount === 0 && thinkingCount === 0 && !hasMemory && !attention;
  const showInternals = !trivial;

  const summary = buildInternalsSummary({ toolCount, thinkingCount, recalledItems });
  // A paused-for-approval turn is not "running" but still needs a live label —
  // it is the one state that requires the user to act.
  const liveLabel = isMessageRunning
    ? phase !== undefined
      ? PHASE_LIVE_LABELS[phase]
      : 'Thinking…'
    : phase === 'waiting-for-approval'
      ? PHASE_LIVE_LABELS['waiting-for-approval']
      : undefined;

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
        {showInternals && (
          <AgentInternalsDisclosure
            summary={summary}
            liveLabel={liveLabel}
            isRunning={isMessageRunning}
            attention={attention}
            lockOpen={messageStatus === 'requires-action'}
            defaultExpanded={showAgentInternals}
            showPreferenceToggle
            preferenceOn={showAgentInternals}
            onPreferenceChange={setShowAgentInternals}
            dataTestPrefix="assistant-message"
          >
            <MemoryContextCard
              recall={memoryContext?.recall}
              profile={memoryContext?.profile}
              unavailable={memoryFailed}
              onRetry={retryMemoryContext}
            />
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
                        bare
                      >
                        {children}
                      </AgentStepsContainer>
                    );
                  case 'group-reasoning':
                    return isMessageRunning ? <ReasoningContainer group={part} /> : null;
                  case 'text': {
                    // Intermediate text inside the trace: muted vs the final answer.
                    // Final text (at/after the cut) belongs to the main flow, not the trace.
                    const index = parts.findIndex(p => p === part);
                    if (index < 0 || index >= cutIndex) return null;
                    return (
                      <div className="mb-2 text-xs text-text-secondary [&_.markdown-body]:text-inherit">
                        <AssistantTextContainer />
                      </div>
                    );
                  }
                  case 'reasoning':
                    return isMessageRunning ? <AssistantLeafPartContainer part={part} /> : null;
                  case 'tool-call':
                  case 'image':
                  case 'data':
                    return <AssistantLeafPartContainer part={part} />;
                  default:
                    return null;
                }
              }}
            </MessagePrimitive.GroupedParts>
          </AgentInternalsDisclosure>
        )}
        {ingestionStatusLine !== undefined && (
          <p className="mb-2 text-xs italic text-text-secondary" data-testid="document-ingestion-status">
            {ingestionStatusLine}
          </p>
        )}
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part }) => {
            switch (part.type) {
              // Rendered inside the internals disclosure above.
              case 'group-agentSteps':
                return null;
              case 'group-reasoning':
                return isMessageRunning ? <ReasoningContainer group={part} /> : null;
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
