'use client';

import {
  MessagePartPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
  useToolCallElapsed,
  type ThreadMessage,
  type ToolApprovalResponse,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { useTrueFoundryApprovals, useTrueFoundryRespondToToolApproval } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useState } from 'react';

import { MapCard } from '../components/MapCard.js';
import { PermissionApprovalCard } from '../sentinel/PermissionApprovalCard.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import { useSlot } from '../theme/SlotsProvider.js';
import {
  ASK_USER_TOOL_NAME,
  MAPS_TOOL_NAMES,
  MCP_META_TOOLS,
  SANDBOX_TOOL_NAMES,
  SUB_AGENT_TOOL_NAME,
  allowOnceOptionId,
  buildApprovalOptions,
  buildOutcomeText,
  formatDuration,
  getAskUserAnswerResult,
  getJsonDisplayValue,
  getToolFailureReason,
  getToolResultContent,
  hasPendingAskUserResponse,
  hasPendingToolApproval,
  mcpDisplayName,
  parseAskUserQuestionArgs,
  parseMapsResult,
  parseMcpToolArgs,
  parseSandboxArgs,
  parseSandboxResult,
  parseToolOutputScreen,
  parseToolResultDisposition,
  resolveSubAgentMeta,
  toStatus,
} from '../utils/toolCallParsing.js';
import { useRegisterApprovalExpand } from './approvalFocus.js';
import { AssistantTextContainer } from './AssistantTextContainer.js';
import { NestedApprovalBridgeContext, useNestedApprovalBridge } from './nestedApprovalBridge.js';
import { SandboxToolCallContainer } from './SandboxToolCallContainer.js';
import { ToolApprovalContainer } from './ToolApprovalContainer.js';
import { ToolCallContentBlockContainer } from './ToolCallContentBlockContainer.js';

function NestedReasoningContainer() {
  const isRunning = useAuiState(s => s.part.status?.type === 'running');
  const ReasoningCard = useSlot('ReasoningCard');
  return isRunning ? <ReasoningCard content="" isStreaming headingText="Thinking…" /> : null;
}

function hostObservedTargetSummary(artifact: unknown): string | undefined {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return undefined;
  const value = Object.entries(artifact).find(([key]) => key === 'hostObservedTargetSummary')?.[1];
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

function ToolApprovalSlot({ part }: { part: ToolCallMessagePartProps }) {
  const isNestedReadonly = useNestedApprovalBridge();
  const respondToNestedApproval = useTrueFoundryRespondToToolApproval();
  const { pending: pendingApprovals, respond: respondToApproval } = useTrueFoundryApprovals();
  const sentinel = useOptionalSentinelState();
  const aui = useAui();

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

  const onSelectOption = (optionId: string, reason?: string) => {
    if (optionId === 'allow-once') return respond({ optionId, approved: true });
    if (optionId === 'allow-chat') return respond({ optionId, approved: true });
    if (optionId === 'deny') return respond({ optionId, approved: false, reason });
    if (optionId === '__allow') return respond({ approved: true });
    if (optionId === '__deny') return respond({ approved: false, reason });
    return respond({ optionId, reason });
  };

  // An approval whose server-built plain-language card arrived on the
  // `tool.approval_required` event replaces the generic approval card. The branch keys
  // on the explicit numeric `tier` the server sent; without it the generic card
  // renders as before. Approve/Deny reuse the same option plumbing, so grants and
  // confirmations behave identically.
  const approvalInfo = sentinel?.approvalFor(part.toolCallId);
  if (approvalInfo?.tier === 2 || approvalInfo?.tier === 3) {
    const options = buildApprovalOptions(part.approval?.options);
    // Approve is always a single-use allow: a declared chat-scoped grant can sort first,
    // and taking the first allow option would silently approve every later equivalent call.
    const allowOnceId = allowOnceOptionId(part.approval?.options) ?? '__allow';
    const denyOption = options.find(option => !option.isAllow);
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
    return (
      <PermissionApprovalCard
        toolName={part.toolName}
        card={approvalInfo.card}
        tier={approvalInfo.tier}
        onApprove={() => onSelectOption(allowOnceId)}
        onDeny={() => onSelectOption(denyOption?.id ?? '__deny')}
        onApproveAll={approveAll}
        batchSize={approveAll === undefined ? undefined : tier2Batch.length}
        disabled={isNestedReadonly}
      />
    );
  }

  return (
    <ToolApprovalContainer
      toolName={part.toolName}
      argsText={part.argsText}
      hostObservedTargetSummary={hostObservedTargetSummary(part.artifact)}
      options={buildApprovalOptions(part.approval?.options)}
      onSelectOption={onSelectOption}
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

export const ToolCallContainer: ToolCallMessagePartComponent = part => {
  const ToolCallCard = useSlot('ToolCallCard');
  const SubAgentCard = useSlot('SubAgentCard');
  const AskUserPrompt = useSlot('AskUserPrompt');
  const elapsedMs = useToolCallElapsed();
  const isRequiresAction = part.status?.type === 'requires-action';
  const stateApproval = useAuiState(s => (s.part.type === 'tool-call' ? s.part.approval : undefined));
  const approval = stateApproval ?? part.approval;
  const approvalPart = approval === part.approval ? part : { ...part, approval };
  const isSubAgent = part.toolName === SUB_AGENT_TOOL_NAME;
  const isSandbox = SANDBOX_TOOL_NAMES.has(part.toolName);
  const isMaps = MAPS_TOOL_NAMES.has(part.toolName);
  const [expanded, setExpanded] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] = useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setExpanded(true);
  }

  const showApproval = hasPendingToolApproval(approval);

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
  const outcomeText = outputWasWithheld ? outputScreen.label : buildOutcomeText(disposition, failureReason);
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

  if (isSandbox) {
    const { command, intent, summary, argsJson } = parseSandboxArgs(part.argsText, part.toolName);
    const { exitCode, resultText, resultJson } = parseSandboxResult(resultString);
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
        argsJson={argsJson}
        resultText={resultText}
        resultJson={resultJson}
        approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : undefined}
        approvalId={showApproval ? approval?.id : undefined}
      />
    );
  }

  if (isMaps) {
    const mapsResult = parseMapsResult(resultString, part.toolName);
    return (
      <div data-slot="tool-call-card" data-variant="map" className="w-full">
        {showApproval ? <ToolApprovalSlot part={approvalPart} /> : undefined}
        <MapCard
          data={mapsResult.data}
          state={mapsResult.state}
          cardId={part.toolCallId}
          blockedMessage={mapsResult.blockedMessage}
        />
      </div>
    );
  }

  if (MCP_META_TOOLS.has(part.toolName)) {
    const { mcpServer, innerToolName, input } = parseMcpToolArgs(part.argsText);
    const argsDisplay = getJsonDisplayValue(part.argsText);
    const resultDisplay = getToolResultContent(part.result);

    if (part.toolName === 'list_tools' && mcpServer) {
      const slots = RequestResponseSlots({
        request: argsDisplay,
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
          approvalSlot={showApproval ? <ToolApprovalSlot part={part} /> : undefined}
          approvalId={showApproval ? part.approval?.id : undefined}
        />
      );
    }

    const inputDisplay = input !== undefined ? getJsonDisplayValue(JSON.stringify(input, null, 2)) : argsDisplay;
    const slots = RequestResponseSlots({
      request: inputDisplay,
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
        {...slots}
        approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : undefined}
        approvalId={showApproval ? approval?.id : undefined}
      />
    );
  }

  const argsDisplay = getJsonDisplayValue(part.argsText);
  const resultDisplay = getToolResultContent(part.result);
  const slots = RequestResponseSlots({
    request: argsDisplay,
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
      {...slots}
      approvalSlot={showApproval ? <ToolApprovalSlot part={approvalPart} /> : undefined}
      approvalId={showApproval ? approval?.id : undefined}
    />
  );
};
