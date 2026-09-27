'use client';

import { useAuiState } from '@assistant-ui/react';
import { useEffect, useRef, useState } from 'react';

import { useChatChromeActionsVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { messageTextOf } from '../voice/messageText.js';
import { auiButtonClass } from './lib/buttonClasses.js';

/**
 * Copies the full conversation as plain text (`You:` / `Assistant:` lines).
 * Sits in the chat header next to Clear chat; hidden while idle and on a
 * fresh chat, following the same visibility rule.
 */
export function CopyTranscriptButton() {
  const shell = useOptionalShellMode();
  const visible = useChatChromeActionsVisible();
  const messages = useAuiState(s => s.thread.messages);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!visible || shell == null) return null;

  const copy = async () => {
    const lines: string[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        lines.push(`You: ${messageTextOf(message.content)}`);
      } else if (message.role === 'assistant') {
        lines.push(`Assistant: ${messageTextOf(message.content)}`);
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n\n'));
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the button simply does not confirm.
    }
  };

  return (
    <button
      type="button"
      title="Copy conversation as text"
      aria-label="Copy conversation as text"
      className={auiButtonClass({ variant: 'ghost', size: 'large' })}
      onClick={() => void copy()}
    >
      <Icon name={copied ? 'check' : 'clone'} size="0.875rem" />
      {copied ? 'Copied' : 'Copy transcript'}
    </button>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    CopyTranscriptButton: typeof CopyTranscriptButton;
  }
}
