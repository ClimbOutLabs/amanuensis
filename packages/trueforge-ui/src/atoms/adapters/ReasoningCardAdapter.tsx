import { AgentStepRow } from '../agent-chat/AgentStepRow.js';
import { cn } from '../lib/cn.js';

export type ReasoningCardProps = {
  content: string;
  isStreaming?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  isMultiLine?: boolean;
  reasoningTimeText?: string | null;
  previewText?: string;
  headingText?: string;
  contentRef?: (node: HTMLDivElement | null) => void;
  dataTestPrefix?: string;
  className?: string;
};

export function ReasoningCard({
  content,
  isStreaming = false,
  reasoningTimeText,
  headingText = 'Reasoning',
  dataTestPrefix,
  className,
}: ReasoningCardProps) {
  const status = isStreaming ? 'running' : content.length > 0 ? 'success' : 'idle';
  const title = isStreaming ? headingText : (reasoningTimeText ?? headingText);

  return (
    <div
      className={cn('aui-reasoning-card mt-2 flex min-w-0 flex-col', className)}
      data-testid={dataTestPrefix ? `${dataTestPrefix}-reasoning` : undefined}
      data-reasoning-redacted="true"
    >
      <AgentStepRow
        icon={isStreaming ? 'brain' : 'brain-regular'}
        iconVariant="primary"
        title={title}
        expandable={false}
        expanded={false}
        status={status}
        statusText={isStreaming ? 'In progress' : content.length > 0 ? 'Complete' : undefined}
        dataTestPrefix={dataTestPrefix}
      />
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    ReasoningCard: typeof ReasoningCard;
  }
}
