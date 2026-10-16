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
import type { ReactNode } from 'react';

import { copyText } from '@/utils/copyText.js';
import type { AgentStepsPhase } from '../atoms/adapters/AgentStepsCardAdapter.js';
import { AgentInternalsDisclosure } from '../atoms/agent-chat/AgentInternalsDisclosure.js';
import { MemoryContextCard } from '../atoms/agent-chat/MemoryContextCard.js';
import { useAgentDetailsVisibility } from '../server/AgentDetailsPreferenceContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { computeAgentStepsSplit, type AgentStepsRun } from '../utils/computeAgentStepsSplit.js';
import { parseToolResultDisposition } from '../utils/toolCallParsing.js';
import { AgentStepsContainer } from './AgentStepsContainer.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { useDocumentIngestionStatusLine } from './DocumentIngestionStatusProvider.js';
import { useMemoryTurnContext, useMemoryTurnContextStatus } from './MemoryTurnContextProvider.js';
import { MessageImageContainer } from './MessageImageContainer.js';
import { ReasoningContainer } from './ReasoningContainer.js';
import { RunCodeSetupNoticesContainer } from './RunCodeSetupNoticesContainer.js';
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

type GroupKey = `group-agentSteps-${number}` | 'group-reasoning';

// Each folded run gets its own group key so interleaved runs stay distinct disclosures.
function agentStepsGroupKey(runIndex: number): `group-agentSteps-${number}` {
  return `group-agentSteps-${runIndex}`;
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
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const { visibility: agentDetailsVisibility } = useAgentDetailsVisibility(sessionId);
  const { copy, isCopied } = useActionBarCopy({
    copyToClipboard: text => copyText(text),
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

  const { runs, hasFinal } = computeAgentStepsSplit(parts, isMessageRunning);

  // Progressive disclosure inputs: errors and approvals surface with an amber
  // dot and auto-expand while the turn is running; a clean completed run with no tools, no
  // thinking, no memory, and no errors renders no internals row at all. Completed turns with
  // errors keep the dot and the summary row but follow the chat-level switch (collapsed by
  // default) instead of forcing the content open.
  const recall = memoryContext?.recall;
  const agentDetailsVisible = agentDetailsVisibility === 'expanded';
  const recallOutcomeBad = recall != null && (recall.stats.outcome === 'timeout' || recall.stats.outcome === 'error');
  // The recalled-item count is part of "agent details": suppressed while the chat-level
  // preference is collapsed, unless the recall itself needs attention (timeout/error) — then
  // it stays in the summary row next to the amber dot while the disclosure content collapses.
  const memoryVisible = recall != null && (agentDetailsVisible || recallOutcomeBad);
  const recalledItems = memoryVisible ? (recall?.stats.items ?? 0) : 0;
  const hasMemory = memoryVisible || memoryContext?.profile != null;
  const memoryFailed = memoryContext == null && memoryContextHasError;

  // Turn-level state (memory, live label) is hosted by the first run; a turn with no folded run
  // gets a leading row instead.
  const renderInternals = ({
    run,
    runIndex,
    children,
  }: {
    run: AgentStepsRun;
    runIndex: number;
    children?: ReactNode;
  }) => {
    const isHost = runIndex === 0;
    const isLast = runIndex >= runs.length - 1;
    const runParts = parts.slice(run.start, run.end);
    const isLive = isMessageRunning && isLast;
    // Only the last run reflects the running turn; earlier runs have already finished.
    const phase = stepPhase(runParts, isMessageRunning && !isLast ? undefined : messageStatus);
    const attention =
      runParts.some(isToolPartErrored) ||
      (isHost && (recallOutcomeBad || memoryFailed)) ||
      phase === 'waiting-for-approval';
    const showMemory = isHost && hasMemory;
    const trivial = !isLive && run.toolCount === 0 && run.thinkingCount === 0 && !showMemory && !attention;
    if (trivial) return null;

    // A paused-for-approval turn is not "running" but still needs a live label —
    // it is the one state that requires the user to act.
    const liveLabel = isLive
      ? phase !== undefined
        ? PHASE_LIVE_LABELS[phase]
        : 'Thinking…'
      : phase === 'waiting-for-approval'
        ? PHASE_LIVE_LABELS['waiting-for-approval']
        : undefined;

    return (
      <AgentInternalsDisclosure
        summary={buildInternalsSummary({
          toolCount: run.toolCount,
          thinkingCount: run.thinkingCount,
          recalledItems: isHost ? recalledItems : 0,
        })}
        liveLabel={liveLabel}
        isRunning={isLive}
        attention={attention}
        lockOpen={messageStatus === 'requires-action' && (isLast || phase === 'waiting-for-approval')}
        expanded={agentDetailsVisible}
        dataTestPrefix="assistant-message"
      >
        {showMemory && (
          <MemoryContextCard
            recall={memoryContext?.recall}
            profile={memoryContext?.profile}
            unavailable={memoryFailed}
            onRetry={retryMemoryContext}
            agentDetailsVisible={agentDetailsVisible}
          />
        )}
        {children !== undefined && (
          <AgentStepsContainer
            toolCount={run.toolCount}
            thinkingCount={run.thinkingCount}
            hasFinal={hasFinal}
            phase={phase}
            bare
          >
            {children}
          </AgentStepsContainer>
        )}
      </AgentInternalsDisclosure>
    );
  };

  const runIndexOfPart = (index: number) => runs.findIndex(run => index >= run.start && index < run.end);

  const groupBy = (part: PartState, _context: GroupByContext): readonly GroupKey[] | null => {
    const runIndex = runIndexOfPart(parts.findIndex(p => p === part));
    if (runIndex === -1) return null;
    return part.type === 'reasoning'
      ? [agentStepsGroupKey(runIndex), 'group-reasoning']
      : [agentStepsGroupKey(runIndex)];
  };

  return (
    <MessagePrimitive.Root data-role="assistant">
      <AssistantMessageBubble
        error={error !== undefined ? <MessageErrorBanner message={String(error)} /> : undefined}
        actionBar={
          !isThreadRunning ? <MessageActionBar isCopied={isCopied} onCopy={copy} createdAt={createdAt} /> : undefined
        }
      >
        {runs.length === 0 &&
          renderInternals({ run: { start: 0, end: 0, toolCount: 0, thinkingCount: 0 }, runIndex: 0 })}
        <RunCodeSetupNoticesContainer parts={parts} />
        {ingestionStatusLine !== undefined && (
          <p className="mb-2 text-xs italic text-text-secondary" data-testid="document-ingestion-status">
            {ingestionStatusLine}
          </p>
        )}
        {/* The wait queue lives in the `indicator` slot below: it must stay
            mounted for the whole turn, including while text streams.
            assistant-ui's default `indicator="no-text"` unmounts the indicator
            the moment the first tokens land (and remounts it when tools run),
            which would flicker the queue and reset its elapsed clock across
            the phases of a normal agentic turn. */}
        <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="always">
          {({ part, children }) => {
            switch (part.type) {
              case 'group-reasoning':
                return isMessageRunning ? <ReasoningContainer group={part} /> : null;
              case 'text': {
                const index = parts.findIndex(p => p === part);
                // Folded narration reads muted; text outside every run is answer text.
                if (runIndexOfPart(index) === -1) return <AssistantTextContainer />;
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
              case 'indicator':
                return resumeUnavailable ? null : <MessageIndicator />;
              default: {
                if (!('indices' in part)) return null;
                const firstIndex = part.indices[0];
                const runIndex = firstIndex === undefined ? -1 : runIndexOfPart(firstIndex);
                const run = runs[runIndex];
                return run ? renderInternals({ run, runIndex, children }) : null;
              }
            }
          }}
        </MessagePrimitive.GroupedParts>
      </AssistantMessageBubble>
    </MessagePrimitive.Root>
  );
}
