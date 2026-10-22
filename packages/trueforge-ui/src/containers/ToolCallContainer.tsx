'use client';

import {
  MessagePartPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
  useToolCallElapsed,
  type ThreadMessage,
  type ToolApprovalResponse,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import {
  toolInvocationRawId,
  useTrueFoundryApprovals,
  useTrueFoundryRespondToToolApproval,
} from '@truefoundry/assistant-ui-runtime';
import { changeRequestReason, changeRequestText } from '@truefoundry/trueforge-core/core/permissions/changeRequest';
import { isMapsToolName } from '@truefoundry/trueforge-core/core/permissions/mapsToolNames';
import { isSearchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { CREATE_PERSONA_TOOL_NAME } from '@truefoundry/trueforge-core/core/personas/toolContract';
import { useCallback, useEffect, useState } from 'react';

import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { Button } from '../atoms/primitives/Button.js';
import { MapCard, type MapRefusedPlace } from '../components/MapCard.js';
import { useOptionalPersonas } from '../components/PersonaContext.js';
import { RefusedPlaceList } from '../components/RefusedPlaceList.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { useHighlightedCard } from '../hooks/useRewardLedger.js';
import { useWaitingToolCallIds } from '../hooks/useWaitingToolCallIds.js';
import { ALWAYS_ALLOW_TOOL_OPTION_ID, offersChangeIt, SAVE_DRAFT_OPTION_ID } from '../sentinel/approvalChoices.js';
import { EmailApprovalCard } from '../sentinel/EmailApprovalCard.js';
import { PermissionApprovalCard } from '../sentinel/PermissionApprovalCard.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import { standInApprovalCard } from '../sentinel/standInCard.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { MAIN_THREAD_ID } from '../utils/sessionEventTimeline.js';
import {
  allowChatOptionId,
  allowOnceOptionId,
  ASK_USER_TOOL_NAME,
  buildApprovalOptions,
  buildOutcomeText,
  formatDuration,
  getAskUserAnswerResult,
  getJsonDisplayValue,
  getToolFailureReason,
  getToolResultContent,
  hasPendingAskUserResponse,
  hasPendingToolApproval,
  MCP_META_TOOLS,
  mcpDisplayName,
  notDoneText,
  parseAskUserQuestionArgs,
  parseMapsResult,
  parseMcpToolArgs,
  parseSandboxArgs,
  parseSandboxResult,
  parseToolNotDoneReason,
  parseToolOutputScreen,
  parseToolResultDisposition,
  resolveSubAgentMeta,
  SANDBOX_TOOL_NAMES,
  SUB_AGENT_TOOL_NAME,
  toStatus,
} from '../utils/toolCallParsing.js';
import { useRegisterApprovalExpand } from './approvalFocus.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { NestedApprovalBridgeContext, useNestedApprovalBridge } from './nestedApprovalBridge.js';
import { SandboxToolCallContainer } from './SandboxToolCallContainer.js';
import { ToolCallContentBlockContainer } from './ToolCallContentBlockContainer.js';
import { useEndedApprovalDismiss } from './useEndedApprovalDismiss.js';

function NestedReasoningContainer() {
  const isRunning = useAuiState(s => s.part.status?.type === 'running');
  const ReasoningCard = useSlot('ReasoningCard');
  return isRunning ? <ReasoningCard content="" isStreaming headingText="Thinking…" /> : null;
}

/** A host-set text fact on the tool-call part (the model cannot forge these), or undefined. */
function artifactText(artifact: unknown, name: 'hostObservedTargetSummary' | 'silentSearchQuery'): string | undefined {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return undefined;
  const value = Object.entries(artifact).find(([key]) => key === name)?.[1];
  return typeof value === 'string' ? value : undefined;
}

function NestedSubAgentAssistantMessage() {
  const AssistantMessageBubble = useSlot('AssistantMessageBubble');

  return (
    <div className="mb-3 min-w-0">
      <MessagePrimitive.Root data-role="assistant">
        <AssistantMessageBubble>
          <MessagePrimitive.Parts
            components={{
              Text: AssistantTextContainer,
              Reasoning: NestedReasoningContainer,
              tools: { Fallback: ToolCallContainer },
            }}
          />
        </AssistantMessageBubble>
      </MessagePrimitive.Root>
    </div>
  );
}

/** Single-use allow ids the server declared, by approval id, including sub-agent threads. */
function collectAllowOnceIds(messages: readonly ThreadMessage[], into: Map<string, string>): void {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      const allowOnceId = allowOnceOptionId(part.approval?.options);
      if (part.approval != null && allowOnceId !== undefined) into.set(part.approval.id, allowOnceId);
      if (part.messages != null) collectAllowOnceIds(part.messages, into);
    }
  }
}

/** What a person sees on a card whose request ended. Dismiss clears it without running anything. */
function EndedApprovalNote({ onDismiss, dismissing }: { onDismiss: (() => void) | undefined; dismissing: boolean }) {
  return (
    <div
      data-role="approval-expired"
      className="text-text-secondary flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
    >
      <p>This request ended. Ask again if you still need it.</p>
      {onDismiss !== undefined && (
        <Button.Secondary size="small" onClick={onDismiss} disabled={dismissing}>
          Dismiss
        </Button.Secondary>
      )}
    </div>
  );
}

function ToolApprovalSlot({ part }: { part: ToolCallMessagePartProps }) {
  const isNestedReadonly = useNestedApprovalBridge();
  const respondToNestedApproval = useTrueFoundryRespondToToolApproval();
  const { pending: pendingApprovals, respond: respondToApproval } = useTrueFoundryApprovals();
  const sentinel = useOptionalSentinelState();
  const aui = useAui();
  const isMobile = useIsMobile();
  // Who may answer is the session's rule; a sub-agent's card is answered through the runtime like any other.
  const canManageSession = useActiveSessionCanManage();
  // The approval ticket takes the one highlight only where the rail is hidden; mail never takes it.
  const highlightedApprovalId = useHighlightedCard({
    firstWaitingApprovalId: isMobile ? (pendingApprovals[0]?.approvalId ?? null) : null,
    nextAppointmentId: null,
  });

  const respond = (response: ToolApprovalResponse) => {
    if (part.approval == null) return;

    let approved: boolean | undefined;
    let optionId: string | undefined;
    if ('approved' in response) {
      approved = response.approved;
    }
    if ('optionId' in response) {
      const option = buildApprovalOptions(part.approval.options).find(o => o.id === response.optionId);
      if (option == null) return;
      approved ??= option.isAllow;
      optionId = response.optionId;
    }
    if (approved === undefined) return;
    // A plain allow is still a single-use allow: name the declared option instead of leaving
    // the scope to a default.
    if (approved && optionId === undefined) optionId = allowOnceOptionId(part.approval.options);

    const normalizedResponse = {
      approvalId: part.approval.id,
      approved,
      ...(optionId != null && optionId !== '__allow' && optionId !== '__deny' ? { optionId } : {}),
      ...('reason' in response && response.reason != null ? { reason: response.reason } : {}),
    };

    if (isNestedReadonly || normalizedResponse.optionId === 'allow-chat') {
      respondToNestedApproval(normalizedResponse);
      return;
    }

    // assistant-ui's message-part response narrows an approval to the legacy
    // approved/reason shape. Route chat scope through the TrueForge runtime so
    // it reaches the continuation unchanged. Plain Allow/Deny can still use
    // the message part that owns this exact root thread.
    part.respondToApproval({
      approved,
      ...(normalizedResponse.optionId != null ? { optionId: normalizedResponse.optionId } : {}),
      ...(normalizedResponse.reason != null ? { reason: normalizedResponse.reason } : {}),
    });
  };

  // A standing grant rides the runtime's option path; the runtime maps this option id to scope "always".
  const respondAlwaysAllow = () => {
    if (part.approval == null) return;
    respondToNestedApproval({
      approvalId: part.approval.id,
      approved: true,
      optionId: ALWAYS_ALLOW_TOOL_OPTION_ID,
    });
  };

  const onSelectOption = (optionId: string, reason?: string) => {
    if (optionId === 'allow-once') return respond({ optionId, approved: true });
    if (optionId === 'allow-chat') return respond({ optionId, approved: true });
    if (optionId === 'deny') return respond({ optionId, approved: false, reason });
    if (optionId === '__allow') return respond({ approved: true });
    if (optionId === '__deny') return respond({ approved: false, reason });
    return respond({ optionId, reason });
  };

  const options = buildApprovalOptions(part.approval?.options);
  // Approve is always a single-use allow: a declared chat-scoped grant can sort first,
  // and taking the first allow option would silently approve every later equivalent call.
  const allowOnceId = allowOnceOptionId(part.approval?.options) ?? '__allow';
  const denyOption = options.find(option => !option.isAllow);
  const onDeny = () => onSelectOption(denyOption?.id ?? '__deny');

  // The server's plain-language card from the `tool.approval_required` event picks the card. Approve/Deny
  // reuse the same option plumbing, so grants and confirmations behave identically.
  const approvalInfo = sentinel?.approvalFor(part.toolCallId);
  if (approvalInfo?.tier === 2 || approvalInfo?.tier === 3) {
    // The server decides who may get chat scope; a declared option never overrides a refusal.
    const allowChatId = approvalInfo.chatAllowOffered === false ? undefined : allowChatOptionId(part.approval?.options);
    // Only Tier 2 calls batch, and only those asked by this same approval event on this
    // same thread: a sub-agent's calls never ride along with the parent's. Each call still
    // gets its own allow and redeems its own single-use token. A Tier 3 call is never listed
    // here, so "Approve all" cannot reach it.
    const thisPending = pendingApprovals.find(pending => pending.approvalId === approvalInfo.toolCallId);
    const tier2Batch =
      approvalInfo.tier === 2 && thisPending !== undefined && approvalInfo.eventId !== null
        ? pendingApprovals.filter(pending => {
            const info = sentinel?.approvalFor(pending.approvalId);
            return (
              info?.tier === 2 &&
              info.eventId === approvalInfo.eventId &&
              info.threadId === approvalInfo.threadId &&
              pending.threadId === thisPending.threadId
            );
          })
        : [];
    const approveAll =
      tier2Batch.length > 1
        ? () => {
            const declaredAllowOnce = new Map<string, string>();
            collectAllowOnceIds(aui.thread().getState().messages, declaredAllowOnce);
            for (const pending of tier2Batch) {
              const optionId = declaredAllowOnce.get(pending.approvalId);
              respondToApproval({
                approvalId: pending.approvalId,
                approved: true,
                ...(optionId === undefined ? {} : { optionId }),
              });
            }
          }
        : undefined;
    // A draft option exists only when the server offers it on this approval; otherwise no button shows.
    const saveDraftOption = options.find(option => option.id === SAVE_DRAFT_OPTION_ID);
    // A "Change it" answer is a denial that carries the person's words, so the call never runs.
    const onChangeRequest = offersChangeIt(approvalInfo.card)
      ? (text: string) => onSelectOption(denyOption?.id ?? '__deny', changeRequestReason(text))
      : undefined;
    if (approvalInfo.card.email !== null) {
      return (
        <EmailApprovalCard
          approvalId={approvalInfo.toolCallId}
          card={approvalInfo.card}
          onApprove={() => onSelectOption(allowOnceId)}
          onDeny={onDeny}
          onChangeRequest={onChangeRequest}
          onSaveDraft={saveDraftOption === undefined ? undefined : () => onSelectOption(SAVE_DRAFT_OPTION_ID)}
          disabled={!canManageSession}
        />
      );
    }
    return (
      <PermissionApprovalCard
        approvalId={approvalInfo.toolCallId}
        card={approvalInfo.card}
        highlighted={highlightedApprovalId === approvalInfo.toolCallId}
        othersWaiting={pendingApprovals.filter(pending => pending.approvalId !== approvalInfo.toolCallId).length}
        onApprove={() => onSelectOption(allowOnceId)}
        onApproveForChat={allowChatId === undefined ? undefined : () => onSelectOption(allowChatId)}
        onApproveAlways={approvalInfo.alwaysAllowOffered === true ? respondAlwaysAllow : undefined}
        onDeny={onDeny}
        onChangeRequest={onChangeRequest}
        onApproveAll={approveAll}
        batchSize={approveAll === undefined ? undefined : tier2Batch.length}
        disabled={!canManageSession}
      />
    );
  }

  // A reopened chat draws its calls before its saved cards are read. The stand-in card would offer
  // different choices for a moment, so a waiting call shows a quiet line until the read is done.
  if (sentinel !== null && !sentinel.savedCardsRead) {
    return (
      <p data-role="approval-loading" role="status" className="px-3 py-2 text-sm text-text-secondary">
        Loading this request…
      </p>
    );
  }

  // No server card on this screen yet (it can arrive later, or not at all in a host without Sentinel):
  // the same ticket, built from what the call names, with the choices the call declared.
  const allowChatId = allowChatOptionId(part.approval?.options);
  // Approvals are listed by the server's tool call id, the same id a server card carries.
  const serverCallId = toolInvocationRawId(part.toolCallId);
  // A call that declared no choices gets the default single-use allow, sent by the same id as before.
  const standInAllowId =
    options.find(option => option.id === allowOnceId || option.id === 'allow-once')?.id ?? allowOnceId;
  return (
    <PermissionApprovalCard
      approvalId={serverCallId}
      card={standInApprovalCard({
        toolName: part.toolName,
        argsText: part.argsText,
        hostTarget: artifactText(part.artifact, 'hostObservedTargetSummary'),
      })}
      highlighted={highlightedApprovalId === serverCallId}
      othersWaiting={pendingApprovals.filter(pending => pending.approvalId !== serverCallId).length}
      onApprove={() => onSelectOption(standInAllowId)}
      onApproveForChat={allowChatId === undefined ? undefined : () => onSelectOption(allowChatId)}
      onDeny={onDeny}
      disabled={!canManageSession}
    />
  );
}

/**
 * The user-facing result of a maps tool call, rendered inline in the conversation. Shows a quiet
 * loading state while the call runs and the map card once the result is in.
 */
function MapsResult({ part }: { part: ToolCallMessagePartProps }) {
  const resultString =
    part.result === undefined
      ? undefined
      : typeof part.result === 'string'
        ? part.result
        : JSON.stringify(part.result, null, 2);
  const mapsResult = parseMapsResult(resultString, part.toolName);
  // A failed map a later map in the same answer replaces shrinks to one quiet line: the answer
  // has moved on, and the full failure panel would only repeat what the new map already fixed.
  const replaced = useAuiState(s => {
    if (mapsResult.data !== null) {
      return false;
    }
    const parts = s.message.parts;
    const ownIndex = parts.findIndex(
      candidate => candidate.type === 'tool-call' && candidate.toolCallId === part.toolCallId,
    );
    if (ownIndex === -1) {
      return false;
    }
    return parts.slice(ownIndex + 1).some(candidate => {
      if (candidate.type !== 'tool-call' || !isMapsToolName(candidate.toolName)) {
        return false;
      }
      const later =
        candidate.result === undefined
          ? undefined
          : typeof candidate.result === 'string'
            ? candidate.result
            : JSON.stringify(candidate.result, null, 2);
      return parseMapsResult(later, candidate.toolName).data !== null;
    });
  });
  if (replaced) {
    return (
      <p className="maps-card-replaced" data-testid="map-card-replaced">
        This map did not work. A later map in this answer replaces it.
      </p>
    );
  }
  if (mapsResult.state === 'refused') {
    return <RefusedMapStep refused={mapsResult.refused ?? []} />;
  }
  if (part.status?.type === 'running' && mapsResult.data === null) {
    return (
      <div className="maps-card" data-testid="map-card-loading">
        <div className="maps-card-loading" role="status" aria-label="Loading map">
          <span aria-hidden="true" className="maps-card-loading-spinner" />
        </div>
      </div>
    );
  }
  return <MapCard data={mapsResult.data} state={mapsResult.state} blockedMessage={mapsResult.blockedMessage} />;
}

/**
 * A pin call whose every place failed the page check. No map card: the step shows one quiet line,
 * and its details hold the refusal the person can read.
 */
function RefusedMapStep({ refused }: { refused: MapRefusedPlace[] }) {
  const ToolCallCard = useSlot('ToolCallCard');
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolCallCard
      toolName="Checked places for a map"
      status="muted"
      expanded={expanded}
      onToggle={() => setExpanded(prev => !prev)}
      showResponseLine
      responseSlot={
        refused.length === 0 ? (
          <p className="maps-place-note">No place in this answer could be checked against its page.</p>
        ) : (
          <RefusedPlaceList refused={refused} />
        )
      }
    />
  );
}

function RequestResponseSlots({
  request,
  response,
}: {
  request: { value: string; isJson: boolean };
  response: { data: string; isJson: boolean };
}) {
  return {
    requestSlot: request.value ? (
      <ToolCallContentBlockContainer
        title="Request"
        content={request.value}
        isJson={request.isJson}
        maxHeight="10.5rem"
      />
    ) : response.data ? (
      <ToolCallContentBlockContainer title="Request" content="{}" isJson maxHeight="10.5rem" />
    ) : undefined,
    responseSlot: response.data ? (
      <ToolCallContentBlockContainer title="Response" content={response.data} isJson={response.isJson} resizable />
    ) : undefined,
  };
}

/**
 * A "Change it" answer shows the person's words as their own message right after the call, so the
 * history reads in order. The call itself stays declined. `stepHidden` (agent details off) keeps the
 * step mounted, so its effects still run, but out of sight; the person's words still show.
 */
export function ToolCallContainer({
  stepHidden = false,
  ...part
}: ToolCallMessagePartProps & { stepHidden?: boolean }) {
  const UserMessageBubble = useSlot('UserMessageBubble');
  const stateApproval = useAuiState(s => (s.part.type === 'tool-call' ? s.part.approval : undefined));
  const approval = stateApproval ?? part.approval;
  const changeText = approval?.approved === false ? changeRequestText(approval.reason) : undefined;
  return (
    <>
      {stepHidden ? (
        <div hidden>
          <ToolCallPart {...part} />
        </div>
      ) : (
        <ToolCallPart {...part} />
      )}
      {changeText === undefined ? null : <UserMessageBubble text={changeText} />}
    </>
  );
}

function ToolCallPart(part: ToolCallMessagePartProps) {
  const ToolCallCard = useSlot('ToolCallCard');
  const SubAgentCard = useSlot('SubAgentCard');
  const AskUserPrompt = useSlot('AskUserPrompt');
  const elapsedMs = useToolCallElapsed();
  // A specialist added in this chat shows in the persona list without a page reload.
  const reloadPersonas = useOptionalPersonas()?.reload;
  const specialistAdded = part.toolName === CREATE_PERSONA_TOOL_NAME && part.status?.type === 'complete';
  useEffect(() => {
    if (specialistAdded) void reloadPersonas?.();
  }, [specialistAdded, reloadPersonas]);
  const isRequiresAction = part.status?.type === 'requires-action';
  const stateApproval = useAuiState(s => (s.part.type === 'tool-call' ? s.part.approval : undefined));
  const approval = stateApproval ?? part.approval;
  const approvalPart = approval === part.approval ? part : { ...part, approval };
  // The model's own arguments are stored as written, so a held search shows the server's masked
  // rendering of them instead, before and after the owner answers.
  const sentinelState = useOptionalSentinelState();
  const heldSearchCard = sentinelState?.approvalFor(part.toolCallId)?.card;
  const heldSearchRequest =
    heldSearchCard !== undefined && isSearchHoldCardText(heldSearchCard.plain_what)
      ? { value: heldSearchCard.outbound_text ?? '', isJson: false }
      : undefined;
  const isSubAgent = part.toolName === SUB_AGENT_TOOL_NAME;
  const isSandbox = SANDBOX_TOOL_NAMES.has(part.toolName);
  const isMaps = isMapsToolName(part.toolName);
  const [expanded, setExpanded] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] = useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setExpanded(true);
  }

  // Only the newest message can still be answered: the server refuses a decision once the chat
  // has moved past the turn that asked, so an older pending card is shown as expired instead.
  // Sub-agent messages live inside their parent's message and follow it.
  const isNestedMessage = useNestedApprovalBridge();
  const isNewestMessage = useAuiState(s => s.message.isLast);
  // A sub-agent's card names its own thread; the chat's own cards are on the root thread.
  const endedThreadId = isNestedMessage
    ? (sentinelState?.approvalFor(part.toolCallId)?.threadId ?? null)
    : MAIN_THREAD_ID;
  const endedDismiss = useEndedApprovalDismiss({ toolCallId: part.toolCallId, threadId: endedThreadId });
  const hasPendingApproval = hasPendingToolApproval(approval);
  // A card the server no longer lists as waiting belongs to a request that ended, even when it sits on the newest message.
  const { pending: pendingApprovals } = useTrueFoundryApprovals();
  const waitingToolCallIds = useWaitingToolCallIds(pendingApprovals.map(pending => pending.approvalId));
  const endedOnServer =
    hasPendingApproval &&
    waitingToolCallIds !== undefined &&
    !waitingToolCallIds.has(toolInvocationRawId(part.toolCallId));
  const approvalExpired = hasPendingApproval && ((!isNestedMessage && !isNewestMessage) || endedOnServer);
  const showApproval = hasPendingApproval && !approvalExpired;
  const expiredNote =
    approvalExpired && !endedDismiss.cleared ? (
      <EndedApprovalNote onDismiss={endedDismiss.onDismiss} dismissing={endedDismiss.dismissing} />
    ) : undefined;

  const durationText = elapsedMs === undefined ? undefined : formatDuration(elapsedMs);
  const disposition = parseToolResultDisposition(part.result);
  const outputScreen = parseToolOutputScreen(part.result);
  const outputWasWithheld = outputScreen?.action === 'withheld';
  const status = outputWasWithheld
    ? outputScreen.tone
    : disposition === undefined
      ? toStatus(part.status?.type)
      : disposition.tone;
  const failureReason = outputWasWithheld ? undefined : getToolFailureReason(part.result, disposition);
  const notDoneReason = outputWasWithheld ? undefined : parseToolNotDoneReason(part.result);
  const outcomeText = outputWasWithheld
    ? outputScreen.label
    : notDoneReason !== undefined
      ? notDoneText({ toolName: typeof part.toolName === 'string' ? part.toolName : '', reason: notDoneReason })
      : buildOutcomeText(disposition, failureReason);
  const onToggle = () => setExpanded(prev => !prev);
  const expandSubAgent = useCallback(() => setExpanded(true), []);
  useRegisterApprovalExpand(isSubAgent ? part.toolCallId : '', expandSubAgent);

  if (part.toolName === ASK_USER_TOOL_NAME) {
    if (hasPendingAskUserResponse(part)) {
      return null;
    }
    const answer = getAskUserAnswerResult(part.result);
    if (answer == null) {
      return null;
    }
    const { question, options = [] } = parseAskUserQuestionArgs(part.argsText);
    const isCustom = options.length > 0 && !options.includes(answer);
    return (
      <AskUserPrompt
        questions={[]}
        answeredQuestions={[
          {
            id: part.toolCallId,
            question: question ?? 'Question',
            options,
            answer,
            isCustom,
          },
        ]}
        onSubmit={() => {}}
        readOnly
      />
    );
  }

  if (isSubAgent) {
    const { agentName, instruction, stepCount } = resolveSubAgentMeta(part);

    return (
      <div data-slot="tool-call-card" data-variant="sub-agent" className="w-full">
        <SubAgentCard
          status={status}
          expanded={expanded}
          onToggle={onToggle}
          durationText={durationText}
          agentName={agentName}
          instruction={instruction}
          stepCount={stepCount}
        >
          <NestedApprovalBridgeContext.Provider value={true}>
            <MessagePartPrimitive.Messages
              components={{
                AssistantMessage: NestedSubAgentAssistantMessage,
                UserMessage: () => null,
              }}
            />
          </NestedApprovalBridgeContext.Provider>
        </SubAgentCard>
      </div>
    );
  }

  const resultString =
    part.result === undefined
      ? undefined
      : typeof part.result === 'string'
        ? part.result
        : JSON.stringify(part.result, null, 2);
  // A waiting call's card shows its details in plain fields, so the raw arguments stay out of view until it is answered.
  const noRequest = { value: '', isJson: false };

  if (isSandbox) {
    const { command, intent, summary, argsJson } = parseSandboxArgs(part.argsText, part.toolName);
    const { exitCode, resultText, resultJson, notices } = parseSandboxResult(resultString);
    return (
      <SandboxToolCallContainer
        name={part.toolName}
        intent={intent}
        status={status}
        expanded={expanded}
        onToggle={onToggle}
        durationText={durationText}
        outcomeText={outcomeText}
        command={command}
        summary={summary}
        exitCode={exitCode}
        argsJson={showApproval ? undefined : argsJson}
        resultText={resultText}
        resultJson={resultJson}
        notices={notices}
        approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : expiredNote}
        approvalId={showApproval ? approval?.id : undefined}
      />
    );
  }

  if (isMaps) {
    return (
      <div data-slot="tool-call-card" data-variant="map" className="w-full">
        {showApproval ? <ToolApprovalSlot part={approvalPart} /> : expiredNote}
        {!hasPendingApproval && <MapsResult part={part} />}
      </div>
    );
  }

  if (MCP_META_TOOLS.has(part.toolName)) {
    const { mcpServer, innerToolName, input } = parseMcpToolArgs(part.argsText);
    const argsDisplay = getJsonDisplayValue(part.argsText);
    const resultDisplay = getToolResultContent(part.result);

    if (part.toolName === 'list_tools' && mcpServer) {
      const slots = RequestResponseSlots({
        request: showApproval ? noRequest : argsDisplay,
        response: resultDisplay,
      });
      return (
        <ToolCallCard
          toolName={`Listing tools · ${mcpServer}`}
          icon="mcp-server"
          expanded={expanded}
          onToggle={onToggle}
          awaiting={status === 'running'}
          awaitingText={durationText ?? 'Awaiting Response…'}
          outcomeText={outcomeText}
          status={status}
          showResponseLine={status !== 'running' && !!resultDisplay.data}
          mcpServerName={mcpServer}
          {...slots}
          approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : expiredNote}
          approvalId={showApproval ? approval?.id : undefined}
        />
      );
    }

    const inputDisplay =
      heldSearchRequest ?? (input !== undefined ? getJsonDisplayValue(JSON.stringify(input, null, 2)) : argsDisplay);
    const slots = RequestResponseSlots({
      request: showApproval ? noRequest : inputDisplay,
      response: resultDisplay,
    });

    return (
      <ToolCallCard
        toolName={mcpDisplayName(part.toolName, mcpServer, innerToolName)}
        icon="mcp-server"
        expanded={expanded}
        onToggle={onToggle}
        awaiting={status === 'running'}
        awaitingText={durationText ?? 'Awaiting Response…'}
        outcomeText={outcomeText}
        status={status}
        showResponseLine={status !== 'running' && resultDisplay.data !== undefined}
        mcpServerName={mcpServer}
        searchedQuery={artifactText(part.artifact, 'silentSearchQuery')}
        {...slots}
        approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : expiredNote}
        approvalId={showApproval ? approval?.id : undefined}
      />
    );
  }

  const argsDisplay = getJsonDisplayValue(part.argsText);
  const resultDisplay = getToolResultContent(part.result);
  const slots = RequestResponseSlots({
    request: showApproval ? noRequest : (heldSearchRequest ?? argsDisplay),
    response: resultDisplay,
  });

  return (
    <ToolCallCard
      toolName={part.toolName}
      expanded={expanded}
      onToggle={onToggle}
      awaiting={status === 'running'}
      awaitingText={durationText ?? 'Awaiting Response…'}
      outcomeText={outcomeText}
      status={status}
      showResponseLine={status !== 'running' && resultDisplay.data !== undefined}
      searchedQuery={artifactText(part.artifact, 'silentSearchQuery')}
      {...slots}
      approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : expiredNote}
      approvalId={showApproval ? approval?.id : undefined}
    />
  );
}
