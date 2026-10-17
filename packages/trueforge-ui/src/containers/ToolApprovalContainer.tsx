'use client';

import { useCallback, useMemo, useState } from 'react';

import type { ApprovalOption } from '../atoms/ToolApprovalBar.js';

import { parseMcpToolArgs } from '@/utils/toolCallParsing.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { useSlot } from '../theme/SlotsProvider.js';

export type ToolApprovalOption = {
  id: string;
  label: string;
  isAllow: boolean;
  grants?: readonly string[];
  confirm?: {
    title?: string;
    description?: string;
  };
};

type ToolApprovalContainerProps = {
  toolName?: string;
  argsText?: string;
  hostObservedTargetSummary?: string;
  options: ToolApprovalOption[];
  onSelectOption: (optionId: string, reason?: string) => void;
};

function approvalGuidance(toolName: string): string | undefined {
  if (toolName === 'submit_implementation_plan') {
    return 'Approve for this chat turns this exact plan on until you revoke it. Approve covers only this submission.';
  }
  if (toolName === 'apply_patch' || toolName === 'replace_text') {
    return 'Approve covers this edit even when it is outside an active plan. The host rechecks the target before dispatch; if an earlier attempt was blocked as stale, it was not dispatched, so read the target again before approving this retry. For a bounded set of edits and checks, ask the agent to submit an implementation plan.';
  }
  if (toolName === 'write_file') {
    return 'Approve covers this edit even when it is outside an active plan. For a bounded set of edits and checks, ask the agent to submit an implementation plan.';
  }
  if (toolName === 'run_registered_command') {
    return 'Approve covers this check even when it is outside an active plan. For a bounded set of edits and checks, ask the agent to submit an implementation plan.';
  }
  return undefined;
}

export function ToolApprovalContainer({
  toolName = '',
  argsText,
  hostObservedTargetSummary,
  options,
  onSelectOption,
}: ToolApprovalContainerProps) {
  const ToolApprovalBar = useSlot('ToolApprovalBar');
  const canManageSession = useActiveSessionCanManage();
  const { mcpServer, innerToolName } = parseMcpToolArgs(argsText);
  const displayToolName = innerToolName && mcpServer ? `${innerToolName} (${mcpServer})` : toolName;
  const guidance = approvalGuidance(innerToolName ?? toolName);
  const [selectedDenyOptionId, setSelectedDenyOptionId] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState('');
  const [showReasonError, setShowReasonError] = useState(false);
  const approveOptions = useMemo<ApprovalOption[]>(
    () =>
      options
        .filter(option => option.isAllow)
        .map((option, index) => ({
          ...option,
          variant: index === 0 ? 'primary' : 'secondary',
          requiresReason: false,
        })),
    [options],
  );
  const denyOptions = useMemo<ApprovalOption[]>(
    () =>
      options
        .filter(option => !option.isAllow)
        .map(option => ({
          ...option,
          variant: 'secondary',
          requiresReason: option.confirm != null,
        })),
    [options],
  );
  const selectedDenyOption = denyOptions.find(option => option.id === selectedDenyOptionId);

  const onDenyOptionChange = useCallback((optionId: string | null) => {
    setSelectedDenyOptionId(optionId);
    setDenialReason('');
    setShowReasonError(false);
  }, []);
  const onDenialReasonChange = useCallback((reason: string) => {
    setDenialReason(reason);
    setShowReasonError(false);
  }, []);
  const onReasonSubmit = useCallback(() => {
    if (!canManageSession) return;
    const reason = denialReason.trim();
    if (!reason) {
      setShowReasonError(true);
      return;
    }
    if (selectedDenyOptionId) {
      onSelectOption(selectedDenyOptionId, reason);
      onDenyOptionChange(null);
    }
  }, [canManageSession, denialReason, onDenyOptionChange, onSelectOption, selectedDenyOptionId]);

  return (
    <ToolApprovalBar
      toolName={displayToolName}
      guidance={guidance}
      hostObservedTargetSummary={hostObservedTargetSummary}
      approveOptions={approveOptions.length > 0 ? approveOptions : undefined}
      denyOptions={denyOptions.length > 0 ? denyOptions : undefined}
      selectedDenyOption={selectedDenyOption}
      denialReason={denialReason}
      showReasonError={showReasonError}
      disabled={!canManageSession}
      onSelect={(optionId, reason) => {
        if (!canManageSession) return;
        if (reason === undefined) {
          onSelectOption(optionId);
          return;
        }
        onSelectOption(optionId, reason);
      }}
      onDenyOptionChange={onDenyOptionChange}
      onDenialReasonChange={onDenialReasonChange}
      onReasonSubmit={onReasonSubmit}
    />
  );
}
