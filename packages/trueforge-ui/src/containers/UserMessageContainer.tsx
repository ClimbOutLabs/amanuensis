'use client';

import { useActionBarCopy, useActionBarEdit, useThreadIsRunning } from '@assistant-ui/core/react';
import { MessagePrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { isMorningBriefPrompt } from '@truefoundry/trueforge-core/core/schedules/morningBrief';

import { copyText } from '@/utils/copyText.js';
import { AmanBriefRequest } from '../components/AmanBrief.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { MessageAttachmentsContainer } from './AttachmentsContainer.js';
import { messageText } from './briefTurn.js';

export function UserMessageContainer() {
  const UserMessageBubble = useSlot('UserMessageBubble');
  const UserMessageActionBar = useSlot('UserMessageActionBar');
  const isRunning = useThreadIsRunning();
  const canManageSession = useActiveSessionCanManage();
  const aui = useAui();
  const createdAt = useAuiState(s => s.message.createdAt);
  const text = useAuiState(s => messageText(s.message.content));
  const { edit, disabled: editDisabled } = useActionBarEdit();
  const { copy, isCopied } = useActionBarCopy({
    copyToClipboard: value => copyText(value),
  });

  // A morning brief request is shown as the brief's ticket, not as a bubble.
  if (isMorningBriefPrompt(text)) {
    return (
      <MessagePrimitive.Root data-role="user">
        <AmanBriefRequest />
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root data-role="user">
      <UserMessageBubble
        text={text}
        attachments={<MessageAttachmentsContainer />}
        editAction={
          !isRunning ? (
            <UserMessageActionBar
              isCopied={isCopied}
              editDisabled={editDisabled || !canManageSession}
              retryDisabled={!canManageSession}
              createdAt={createdAt}
              onCopy={copy}
              onEdit={edit}
              onRetry={() => {
                if (!canManageSession) return;
                aui.message().composer().beginEdit();
                aui.message().composer().send({ startRun: true });
              }}
            />
          ) : undefined
        }
      />
    </MessagePrimitive.Root>
  );
}
