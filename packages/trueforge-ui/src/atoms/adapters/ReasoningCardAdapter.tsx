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

/**
 * The reasoning step row. The text shows only while streaming, only when the caller passes it with a
 * toggle, and only once the person opens the row; a finished card never shows it.
 */
export function ReasoningCard({
  content,
  isStreaming = false,
  expanded = false,
  onToggle,
  reasoningTimeText,
  headingText = 'Reasoning',
  dataTestPrefix,
  className,
}: ReasoningCardProps) {
  const status = isStreaming ? 'running' : content.length > 0 ? 'success' : 'idle';
  const title = isStreaming ? headingText : (reasoningTimeText ?? headingText);
  const expandable = isStreaming && onToggle !== undefined && content.trim() !== '';
  const showingText = expandable && expanded;

  return (
    <div
      className={cn('aui-reasoning-card mt-2 flex min-w-0 flex-col', className)}
      data-testid={dataTestPrefix ? `${dataTestPrefix}-reasoning` : undefined}
      data-reasoning-redacted={showingText ? 'false' : 'true'}
    >
      <AgentStepRow
        icon={isStreaming ? 'brain' : 'brain-regular'}
        iconVariant="primary"
        title={title}
        expandable={expandable}
        expanded={showingText}
        onToggle={expandable ? onToggle : undefined}
        status={status}
        statusText={isStreaming ? 'In progress' : content.length > 0 ? 'Complete' : undefined}
        dataTestPrefix={dataTestPrefix}
      >
        {showingText ? (
          <p
            className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm text-text-secondary"
            data-testid={dataTestPrefix ? `${dataTestPrefix}-reasoning-text` : undefined}
          >
            {content}
          </p>
        ) : null}
      </AgentStepRow>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    ReasoningCard: typeof ReasoningCard;
  }
}
