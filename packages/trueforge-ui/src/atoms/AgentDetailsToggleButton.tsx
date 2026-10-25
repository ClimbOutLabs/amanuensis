'use client';

import { useAuiState } from '../assistant-ui.js';
import { useChatChromeActionsVisible } from '../hooks/useChatChromeActionsVisible.js';
import { useAgentDetailsVisibility } from '../server/AgentDetailsPreferenceContext.js';
import { headerActionClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

// The chat header's "Agent details" switch. While on, every turn shows its agent internals (steps,
// tool calls, in-between text); while off, only the answer and what needs the person. The choice is
// stored on the chat's session, so it is the same after a reload. Hidden while idle, on a fresh chat,
// and until the chat has a server session id to store it on.
export function AgentDetailsToggleButton() {
  const visible = useChatChromeActionsVisible();
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const { visible: detailsVisible, setVisibility } = useAgentDetailsVisibility(sessionId);

  if (!visible || sessionId == null) return null;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={detailsVisible}
      title={detailsVisible ? 'Agent details are on' : 'Agent details are off'}
      className={headerActionClassName}
      onClick={() => void setVisibility(detailsVisible ? 'collapsed' : 'expanded')}
    >
      Agent details
      <span
        aria-hidden="true"
        data-state={detailsVisible ? 'on' : 'off'}
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors motion-reduce:transition-none',
          detailsVisible ? 'border-primary-button-bg bg-primary-button-bg' : 'border-text-secondary bg-transparent',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 size-2.5 rounded-full transition-transform motion-reduce:transition-none',
            detailsVisible ? 'translate-x-3 bg-primary-button-text' : 'translate-x-0 bg-text-secondary',
          )}
        />
      </span>
    </button>
  );
}
