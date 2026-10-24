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
import { parseMorningBrief } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { useState, type ReactNode } from 'react';

import { copyText } from '@/utils/copyText.js';
import type { AgentStepsPhase } from '../atoms/adapters/AgentStepsCardAdapter.js';
import { AgentInternalsDisclosure } from '../atoms/agent-chat/AgentInternalsDisclosure.js';
import { MemoryContextCard } from '../atoms/agent-chat/MemoryContextCard.js';
import { ModelUsageDetails } from '../atoms/agent-chat/ModelUsageDetails.js';
import { ModelUsageOverview } from '../atoms/agent-chat/ModelUsageOverview.js';
import { TurnImages } from '../chatImages/ChatImages.js';
import { ChatImageScope, ChatTurnWithoutImages, useChatImagesPort } from '../chatImages/chatImageScope.js';
import { AmanBrief } from '../components/AmanBrief.js';
import { useAgentDetailsVisibility } from '../server/AgentDetailsPreferenceContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { computeAgentStepsSplit, type AgentStepsRun } from '../utils/computeAgentStepsSplit.js';
import { useModelUsageVisible } from '../utils/modelUsageDisplayPreference.js';
import {
  hasPendingAskUserResponse,
  hasPendingToolApproval,
  parseToolResultDisposition,
  toolCallDisposition,
} from '../utils/toolCallParsing.js';
import { AgentStepsContainer } from './AgentStepsContainer.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { useDocumentIngestionStatusLine } from './DocumentIngestionStatusProvider.js';
import { useMemoryTurnContext, useMemoryTurnContextStatus } from './MemoryTurnContextProvider.js';
import { MessageImageContainer } from './MessageImageContainer.js';
import { useModelUsageSummary } from './ModelUsageTurnProvider.js';
import { NeedsYourOkContainer } from './NeedsYourOkContainer.js';
import { ReasoningContainer } from './ReasoningContainer.js';
import { RunCodeSetupNoticesContainer } from './RunCodeSetupNoticesContainer.js';
import { ToolCallContainer } from './ToolCallContainer.js';
import { ToolRefusalNoticesContainer } from './ToolRefusalNoticesContainer.js';
import { answersBriefPrompt, messageText } from './briefTurn.js';

/**
 * Dispatches a leaf message part to its renderer. "data" parts (generative
 * UI) are out of scope for this SDK entirely.
 */
function AssistantReasoningProgress({ text }: { text: string }) {
  const ReasoningCard = useSlot('ReasoningCard');
  const [expanded, setExpanded] = useState(false);
  return (
    <ReasoningCard
      content={text}
      isStreaming
      expanded={expanded}
      onToggle={() => setExpanded(open => !open)}
      headingText="Thinking…"
    />
  );
}

function AssistantLeafPartContainer({ part, stepHidden = false }: { part: EnrichedPartState; stepHidden?: boolean }) {
  switch (part.type) {
    case 'text':
      return <AssistantTextContainer />;
    case 'reasoning':
      return part.status?.type === 'running' ? <AssistantReasoningProgress text={part.text} /> : null;
    case 'image':
      return <MessageImageContainer />;
    case 'tool-call':
      return <ToolCallContainer {...part} stepHidden={stepHidden} />;
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

/** A step that ran into trouble: it failed, was blocked or denied, did not run, or its outcome is unknown. */
function isToolPartUnfinished(part: PartState): boolean {
  if (part.type !== 'tool-call') return false;
  if (isToolPartErrored(part)) return true;
  const disposition = toolCallDisposition(part);
  return disposition !== undefined && disposition.disposition !== 'executed_ok';
}

type NestedPart = { readonly type: string; readonly messages?: readonly { readonly content: readonly NestedPart[] }[] };

/**
 * A tool call the person has to answer: an undecided approval or a question, here or inside a
 * sub-agent's messages. These stay in view even while agent details are off.
 */
function needsPerson(part: PartState | NestedPart): boolean {
  if (part.type !== 'tool-call') return false;
  if ('approval' in part && hasPendingToolApproval(part.approval)) return true;
  if ('interrupt' in part && 'result' in part && hasPendingAskUserResponse(part)) return true;
  return (part.messages ?? []).some(message => message.content.some(needsPerson));
}

function pluralize(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

function buildInternalsSummary({
  toolCount,
  thinkingCount,
  recalledItems,
  helperCalls,
}: {
  toolCount: number;
  thinkingCount: number;
  recalledItems: number;
  helperCalls: number;
}): string {
  const segments: string[] = [];
  const steps = toolCount + thinkingCount;
  if (steps > 0) segments.push(pluralize(steps, 'step'));
  if (toolCount > 0) segments.push(pluralize(toolCount, 'tool'));
  if (recalledItems > 0) segments.push(`${String(recalledItems)} recalled`);
  if (helperCalls > 0) segments.push(pluralize(helperCalls, 'helper call'));
  // An answer with nothing else to list still gets a toggle for its model usage.
  return segments.length > 0 ? segments.join(' · ') : 'Details';
}

type GroupKey = `group-agentSteps-${number}` | 'group-reasoning' | 'group-interimText';

// Each folded run gets its own group key so interleaved runs stay distinct disclosures.
function agentStepsGroupKey(runIndex: number): `group-agentSteps-${number}` {
  return `group-agentSteps-${runIndex}`;
}

const PHASE_LIVE_LABELS: Record<AgentStepsPhase, string> = {
  'waiting-for-model': 'Waiting for model',
  'executing-tools': 'Executing tools',
  'waiting-for-approval': 'Waiting for approval',
};

const BRIEF_WRITING_LINE = 'Putting your brief together…';

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
  const { visible: agentDetailsVisible } = useAgentDetailsVisibility(sessionId);
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
  // Display only: the server records usage whether or not the line is shown in the answer's details.
  const { visible: modelUsageVisible } = useModelUsageVisible();
  const recordedUsage = useModelUsageSummary(turnId);
  const modelUsage = modelUsageVisible && !isMessageRunning ? recordedUsage : undefined;

  const parts = useAuiState(s => s.message.parts);
  const chatImagesPort = useChatImagesPort();
  const messageId = useAuiState(s => s.message.id);
  const answersBrief = useAuiState(s => answersBriefPrompt(s.thread.messages, s.message.id));
  const answerText = useAuiState(s => messageText(s.message.content));
  // A brief replaces the answer once its JSON block is complete and parses. While it is being written one quiet
  // line shows instead of the raw text; a finished answer without a valid block shows as normal markdown.
  const brief = answersBrief ? parseMorningBrief(answerText) : null;
  const briefWriting = answersBrief && brief === null && isMessageRunning;

  const { runs, hasFinal, interimTextIndices } = computeAgentStepsSplit(parts);

  // With agent details off the person sees their answer and what needs them, nothing of the work.
  // In-between lines hide; a settled reply with no text after its last step keeps its last line as
  // the answer, unless a step after that line failed, and then one plain line says it did not finish.
  const settled = messageStatus !== 'running' && messageStatus !== 'requires-action';
  const lastInterim = interimTextIndices.at(-1);
  const failedAfterLastInterim = lastInterim !== undefined && parts.slice(lastInterim + 1).some(isToolPartErrored);
  const keptAsAnswer = settled && !hasFinal && !failedAfterLastInterim ? lastInterim : undefined;
  const hiddenTextIndices = agentDetailsVisible
    ? new Set<number>()
    : new Set(interimTextIndices.filter(index => index !== keptAsAnswer));
  const showNotFinished =
    !agentDetailsVisible &&
    settled &&
    !hasFinal &&
    keptAsAnswer === undefined &&
    error === undefined &&
    parts.some(isToolPartErrored);
  const foldedToolCallIds = new Set(
    runs.flatMap(run =>
      parts.slice(run.start, run.end).flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])),
    ),
  );
  const isHiddenStep = (part: PartState) =>
    !agentDetailsVisible && part.type === 'tool-call' && foldedToolCallIds.has(part.toolCallId) && !needsPerson(part);
  // An answer can read as if everything worked, so a hidden step that did not finish always gets one line.
  const showStepNotFinished =
    settled && !showNotFinished && parts.some(part => isHiddenStep(part) && isToolPartUnfinished(part));

  // The step rows below render only while agent details are on. Errors and approvals surface with an
  // amber dot and auto-expand while the turn is running; a clean completed run with no tools, no
  // thinking, no memory, no usage, and no errors renders no internals row at all.
  const recall = memoryContext?.recall;
  const recallOutcomeBad = recall != null && (recall.stats.outcome === 'timeout' || recall.stats.outcome === 'error');
  const recalledItems = recall?.stats.items ?? 0;
  const hasMemory = recall != null || memoryContext?.profile != null;
  const memoryFailed = memoryContext == null && memoryContextHasError;
  const helperUsage = modelUsage !== undefined && modelUsage.helperCalls > 0 ? modelUsage : undefined;

  // Turn-level state (memory, live label) is hosted by the first run; a turn with no folded run
  // gets a leading row instead. Called only while agent details are on.
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
    const showUsage = isHost && helperUsage !== undefined;
    const usageOverview = isHost ? modelUsage : undefined;
    const trivial =
      !isLive &&
      run.toolCount === 0 &&
      run.thinkingCount === 0 &&
      !showMemory &&
      !showUsage &&
      usageOverview === undefined &&
      !attention;
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
          helperCalls: isHost ? (helperUsage?.helperCalls ?? 0) : 0,
        })}
        liveLabel={liveLabel}
        isRunning={isLive}
        attention={attention}
        lockOpen={messageStatus === 'requires-action' && (isLast || phase === 'waiting-for-approval')}
        expanded
        dataTestPrefix="assistant-message"
      >
        {showMemory && (
          <MemoryContextCard
            recall={memoryContext?.recall}
            profile={memoryContext?.profile}
            unavailable={memoryFailed}
            onRetry={retryMemoryContext}
          />
        )}
        {showUsage && helperUsage !== undefined && <ModelUsageDetails summary={helperUsage} />}
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
        {usageOverview !== undefined && <ModelUsageOverview summary={usageOverview} />}
      </AgentInternalsDisclosure>
    );
  };

  const runIndexOfPart = (index: number) => runs.findIndex(run => index >= run.start && index < run.end);

  const groupBy = (part: PartState, _context: GroupByContext): readonly GroupKey[] | null => {
    const index = parts.findIndex(p => p === part);
    if (hiddenTextIndices.has(index)) return ['group-interimText'];
    const runIndex = runIndexOfPart(index);
    if (runIndex === -1) return null;
    return part.type === 'reasoning'
      ? [agentStepsGroupKey(runIndex), 'group-reasoning']
      : [agentStepsGroupKey(runIndex)];
  };

  // Inside a chat image scope, the turn's images render re-encoded and web images ask first.
  const messageBody = (
    <>
      {agentDetailsVisible &&
        runs.length === 0 &&
        renderInternals({ run: { start: 0, end: 0, toolCount: 0, thinkingCount: 0 }, runIndex: 0 })}
      <RunCodeSetupNoticesContainer parts={parts} />
      <ToolRefusalNoticesContainer parts={parts} />
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
              return isMessageRunning && agentDetailsVisible ? <ReasoningContainer group={part} /> : null;
            case 'group-interimText':
              return null;
            case 'text':
              return briefWriting ? null : <AssistantTextContainer />;
            case 'reasoning':
              return isMessageRunning && agentDetailsVisible ? <AssistantLeafPartContainer part={part} /> : null;
            case 'tool-call':
              return <AssistantLeafPartContainer part={part} stepHidden={isHiddenStep(part)} />;
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
              if (!run) return null;
              // Details off: no step header; only the calls that need the person show from the run.
              return agentDetailsVisible ? renderInternals({ run, runIndex, children }) : children;
            }
          }
        }}
      </MessagePrimitive.GroupedParts>
      {briefWriting ? (
        <p role="status" className="text-sm text-text-secondary" data-testid="brief-writing">
          {BRIEF_WRITING_LINE}
        </p>
      ) : null}
      {showNotFinished && (
        <p role="status" data-testid="assistant-message-not-finished" className="mt-2 text-sm text-text-primary">
          This reply did not finish. Ask again, or turn on Show agent details to see what went wrong.
        </p>
      )}
      {showStepNotFinished && (
        <p role="status" data-testid="assistant-message-step-not-finished" className="mt-2 text-sm text-text-secondary">
          One step didn't finish. Turn on agent details to see it.
        </p>
      )}
      <TurnImages />
    </>
  );

  return (
    <MessagePrimitive.Root data-role="assistant">
      <AssistantMessageBubble
        // An error line belongs to a finished reply. While the thread is still running the
        // message can carry an earlier attempt's error (a resumed or retried run), and showing
        // it would tell the person the reply failed while it is still being written; it clears
        // when the run settles, and only then may the line show.
        error={error !== undefined && !isThreadRunning ? <MessageErrorBanner message={String(error)} /> : undefined}
        actionBar={
          !isThreadRunning ? <MessageActionBar isCopied={isCopied} onCopy={copy} createdAt={createdAt} /> : undefined
        }
      >
        {brief !== null ? (
          <AmanBrief brief={brief} briefId={turnId ?? messageId} sessionId={sessionId} />
        ) : chatImagesPort !== null && sessionId !== undefined && turnId !== undefined ? (
          <ChatImageScope port={chatImagesPort} sessionId={sessionId} turnId={turnId} settled={!isMessageRunning}>
            {messageBody}
          </ChatImageScope>
        ) : (
          <ChatTurnWithoutImages>{messageBody}</ChatTurnWithoutImages>
        )}
        <NeedsYourOkContainer parts={parts} />
      </AssistantMessageBubble>
    </MessagePrimitive.Root>
  );
}
