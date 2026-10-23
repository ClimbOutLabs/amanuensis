'use client';

import { useEffect, useRef } from 'react';

import { useOptionalPersonalization } from '../components/PersonalizationContext.js';
import { useChatNotice, type ChatNoticeKind } from '../hooks/useChatNotice.js';
import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { assistantDisplayName } from '../utils/assistantName.js';

function noticeText({ kind, assistant }: { kind: ChatNoticeKind; assistant: string }): string {
  switch (kind) {
    case 'previous-turn-running':
      return `${assistant} is still working on your last message. Wait for it to finish, or press Cancel, then send this again.`;
    case 'stopped-by-restart':
      return `This reply stopped when ${assistant} restarted. Send your message again.`;
  }
}

/** One plain line about the chat's last send, until the person sends again. */
export function ChatNoticeContainer() {
  const notice = useChatNotice();
  const personalization = useOptionalPersonalization();
  const { isSubmitting } = useComposerBusyState();
  const wasSubmittingRef = useRef(isSubmitting);

  useEffect(() => {
    if (isSubmitting && !wasSubmittingRef.current) notice?.dismiss();
    wasSubmittingRef.current = isSubmitting;
  }, [isSubmitting, notice]);

  if (notice == null) return null;
  const assistant = assistantDisplayName(personalization?.profile?.assistant_name);
  return (
    <p data-role="host-chat-notice" role="status" className="text-text-secondary mt-2 px-1 text-sm">
      {noticeText({ kind: notice.kind, assistant })}
    </p>
  );
}
