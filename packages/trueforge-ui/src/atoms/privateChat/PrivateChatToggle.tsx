'use client';

import { useAuiState } from '@assistant-ui/react';

import { Icon } from '../../icons/Icon.js';
import { setPendingPrivateChat, usePrivateChatState } from '../../server/privateChatStore.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';

/**
 * The Private choice on a new chat. It is offered only before the first message, because a chat
 * is private from the start or not at all.
 */
export function PrivateChatToggle({ disabled }: { disabled?: boolean | undefined }) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const { pending } = usePrivateChatState();
  if (sessionId != null) return null;

  return (
    <button
      type="button"
      aria-pressed={pending}
      title={pending ? 'This chat will be private' : 'Make this a private chat'}
      disabled={disabled}
      className={cn(
        auiButtonClass({ variant: 'ghost', size: 'small' }),
        'h-8 gap-1 rounded-full border px-2.5 text-sm font-normal',
        pending ? 'border-text-primary text-text-primary' : 'border-border text-text-secondary hover:text-text-primary',
      )}
      onClick={() => setPendingPrivateChat(!pending)}
    >
      <Icon name="lock" className="size-3.5 shrink-0" />
      Private chat
    </button>
  );
}
