'use client';

import { useAuiState } from '../assistant-ui.js';
import { useChatChromeActionsVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useAgentDetailsVisibility } from '../server/AgentDetailsPreferenceContext.js';
import { auiButtonClass } from './lib/buttonClasses.js';

// Chat-level "Show/Hide agent details" switch, next to Clear chat. Toggles whether every turn's
// agent internals (tool calls, reasoning steps) render expanded for this chat; see
// AgentDetailsPreferenceContext. Same visibility rule as Clear chat (hidden while idle and on a
// fresh chat), and also hidden until the chat has a server session id, since the preference is
// stored on that session and a toggle with nowhere to write would do nothing.
export function AgentDetailsToggleButton() {
  const visible = useChatChromeActionsVisible();
  const sessionId = useAuiState(s => s.threadListItem.remoteId ?? undefined);
  const { visibility, setVisibility } = useAgentDetailsVisibility(sessionId);
  const expanded = visibility === 'expanded';
  const label = expanded ? 'Hide agent details' : 'Show agent details';

  if (!visible || sessionId == null) return null;

  return (
    <button
      type="button"
      title={label}
      aria-pressed={expanded}
      className={auiButtonClass({ variant: 'ghost', size: 'large' })}
      onClick={() => void setVisibility(expanded ? 'collapsed' : 'expanded')}
    >
      <Icon name="eye" size="0.875rem" />
      {label}
    </button>
  );
}
