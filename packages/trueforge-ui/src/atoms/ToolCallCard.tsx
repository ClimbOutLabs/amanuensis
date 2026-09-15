'use client';

import type { ReactNode } from 'react';
import { useRef } from 'react';

import { useOptionalApprovalFocus, useRegisterApprovalTarget } from '../containers/approvalFocus.js';
import { AgentStepRow, type AgentStepStatus } from './agent-chat/AgentStepRow.js';
import { cn } from './lib/cn.js';

export type ToolCallStatus = 'running' | 'success' | 'error' | 'warning' | 'muted';

export type ToolCallCardProps = {
  icon?: string;
  iconClassName?: string;
  iconVariant?: 'primary' | 'muted';
  toolName: string;
  expanded?: boolean;
  onToggle?: () => void;
  awaiting?: boolean;
  awaitingText?: string;
  outcomeText?: string;
  status?: ToolCallStatus;
  exitCode?: number | null;
  showExpandChevron?: boolean;
  showResponseLine?: boolean;
  responseIcon?: ReactNode;
  approvalSlot?: ReactNode;
  requestSlot?: ReactNode;
  responseSlot?: ReactNode;
  highlightCard?: boolean;
  className?: string;
  mcpServerName?: string;
  dataTestPrefix?: string;
  /** When set, this card is the scroll/flash target for approval banner navigation. */
  approvalId?: string;
};

const DEFAULT_AWAITING_TEXT = 'Awaiting Response...';

// Matches the `mcpDisplayName` shapes (`call_tool: <inner> (<server>)`,
// `get_tool_info: <inner> (<server>)`) so the card can show the friendly
// `innerTool · server` form without depending on the container's formatting.
const MCP_META_TOOL_LABEL_PATTERN = /^(?:call_tool|get_tool_info):\s(.+?)\s*\(\s*([^)]+?)\s*\)$/;

/**
 * Friendly label for MCP tool steps: `innerTool · server` when the server is known, otherwise
 * the raw tool name. The raw name stays on the title tooltip.
 */
function formatToolLabel({ toolName, mcpServerName }: { toolName: string; mcpServerName?: string }): string {
  if (!mcpServerName) return toolName;
  const innerTool = MCP_META_TOOL_LABEL_PATTERN.exec(toolName)?.[1]?.trim();
  if (innerTool) return `${innerTool} · ${mcpServerName}`;
  if (toolName.endsWith(`· ${mcpServerName}`)) return toolName;
  return `${toolName} · ${mcpServerName}`;
}

export function ToolCallCard({
  icon = 'mcp-server',
  iconClassName,
  iconVariant,
  toolName,
  expanded = false,
  onToggle,
  awaiting = false,
  awaitingText = DEFAULT_AWAITING_TEXT,
  outcomeText,
  status: explicitStatus,
  exitCode,
  showExpandChevron = true,
  showResponseLine = false,
  approvalSlot,
  requestSlot,
  responseSlot,
  highlightCard = false,
  className,
  mcpServerName,
  dataTestPrefix,
  approvalId,
}: ToolCallCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useRegisterApprovalTarget(approvalId, cardRef);
  const { flashingApprovalId } = useOptionalApprovalFocus() ?? { flashingApprovalId: null };
  const isFlashing = approvalId != null && approvalId === flashingApprovalId;

  const hasApproval = !!approvalSlot;
  const hasRequest = !!requestSlot;
  const hasResponse = !!responseSlot;
  const showConnector = hasApproval || hasRequest || hasResponse;
  const isExpandable = showExpandChevron && (hasRequest || hasResponse);

  let derivedStatus: AgentStepStatus = 'idle';
  if (explicitStatus) derivedStatus = explicitStatus;
  else if (awaiting) derivedStatus = 'running';
  else if (exitCode === 0) derivedStatus = 'success';
  else if (exitCode != null) derivedStatus = 'error';
  else if (showResponseLine) derivedStatus = 'success';

  const statusText = awaiting ? awaitingText : outcomeText;
  const isCubeIcon = icon === 'cube';
  const derivedIconVariant = iconVariant || (isCubeIcon ? 'primary' : 'muted');
  const derivedIconSize = isCubeIcon ? '0.75em' : undefined;
  const displayLabel = formatToolLabel({ toolName, mcpServerName });

  return (
    <div
      ref={cardRef}
      className={cn(
        'aui-tool-call-card flex min-w-0 flex-col transition-shadow duration-300',
        highlightCard ? 'rounded-md p-1 -mx-1' : 'mx-0 mt-2 p-0',
        isFlashing && 'rounded-md ring-2 ring-approval-banner-accent ring-offset-2 ring-offset-transparent',
        className,
      )}
      data-testid={dataTestPrefix ? `${dataTestPrefix}-tool-call-card` : undefined}
    >
      <AgentStepRow
        icon={icon}
        iconClassName={iconClassName}
        iconVariant={derivedIconVariant}
        iconSize={derivedIconSize}
        title={<span title={toolName}>{displayLabel}</span>}
        expandable={isExpandable}
        expanded={expanded}
        onToggle={onToggle}
        status={derivedStatus}
        statusText={statusText}
        showConnector={showConnector}
        showContentConnector={true}
        showPersistentContentConnector={!hasApproval}
        dataTestPrefix={dataTestPrefix ? `${dataTestPrefix}-header` : undefined}
        persistentChildren={
          <>
            {approvalSlot}
            {expanded && showResponseLine && responseSlot && (
              <div data-testid={dataTestPrefix ? `${dataTestPrefix}-response` : undefined}>{responseSlot}</div>
            )}
          </>
        }
      >
        {requestSlot && (
          <div className="py-2 pt-0" data-testid={dataTestPrefix ? `${dataTestPrefix}-request` : undefined}>
            {requestSlot}
          </div>
        )}
      </AgentStepRow>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ToolCallCard: typeof ToolCallCard;
  }
}
