'use client';

import { useAuiState } from '../assistant-ui.js';
import { useChatChromeActionsVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useAgentDetailsVisibility } from '../server/AgentDetailsPreferenceContext.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

// Chat-level "Show agent details" switch, next to Clear chat. While on, every turn shows its agent
// internals (steps, tool calls, in-between text); while off, only the answer and what needs the person.
// The label stays the same and `aria-pressed` carries the state, so "pressed" always means "shown".
// Same visibility rule as Clear chat (hidden while idle and on a fresh chat), and also hidden until the
// chat has a server session id, since the preference is stored on that session.
export function AgentDetailsToggleButton() {
  const visible = useChatChromeActionsVisible();
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const { visible: detailsVisible, setVisibility } = useAgentDetailsVisibility(sessionId);

  if (!visible || sessionId == null) return null;

  return (
    <button
      type="button"
      title={detailsVisible ? 'Agent details are on' : 'Agent details are off'}
      aria-pressed={detailsVisible}
      className={auiButtonClass({
        variant: 'ghost',
        size: 'large',
        className: cn(
          'border border-input-border',
          detailsVisible ? 'bg-secondary-button-hover text-text-primary' : 'bg-transparent',
        ),
      })}
      onClick={() => void setVisibility(detailsVisible ? 'collapsed' : 'expanded')}
    >
      <Icon name="eye" size="0.875rem" />
      Show agent details
    </button>
  );
}
