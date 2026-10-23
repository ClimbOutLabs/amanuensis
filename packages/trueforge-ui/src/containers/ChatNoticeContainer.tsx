'use client';

import { useEffect, useRef } from 'react';

import { useOptionalPersonalization } from '../components/PersonalizationContext.js';
import { useChatNotice } from '../hooks/useChatNotice.js';
import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { sendRefusalText } from '../utils/turnRefusal.js';

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
  const assistantName = assistantDisplayName(personalization?.profile?.assistant_name);
  return (
    <p data-role="host-chat-notice" role="status" className="text-text-secondary mt-2 px-1 text-sm">
      {sendRefusalText({ refusal: notice.kind, assistantName })}
    </p>
  );
}
